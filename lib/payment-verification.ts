import { createPublicClient, decodeEventLog, http, parseAbiItem, type Hash } from 'viem';
import { CONTRACTS, CHAIN } from '@/lib/contracts';

const paymentRoutedEvent = parseAbiItem(
  'event PaymentRouted(bytes16 indexed vendorId,uint256 indexed productId,bytes16 indexed affiliateId,address buyer,uint256 amount,uint256 platformFee,uint256 affiliateCommission,uint256 vendorShare)'
);

const client = createPublicClient({
  transport: http(process.env.BASE_RPC_URL || CHAIN.rpc),
});

const DEFAULT_MAX_PAYMENT_AGE_SECONDS = 5 * 60;

export type PaymentVerification = {
  valid: boolean;
  txHash?: Hash;
  reason?: string;
  amount?: bigint;
  buyer?: string;
  vendorId?: string;
  productId?: bigint;
  blockNumber?: bigint;
  blockTimestamp?: bigint;
};

export type VerifyPyrimidPaymentOptions = {
  requiredAmountAtomic: number | bigint;
  expectedVendorId?: `0x${string}`;
  expectedProductId?: number | bigint;
  maxAgeSeconds?: number;
};

function isTxHash(value: string): value is Hash {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function normalizeBytes16(value?: `0x${string}`) {
  return value?.toLowerCase();
}

export async function verifyPyrimidPaymentTx(
  proof: string,
  optionsOrRequiredAmount: VerifyPyrimidPaymentOptions | number | bigint
): Promise<PaymentVerification> {
  const txHash = proof.trim();
  if (!isTxHash(txHash)) {
    return { valid: false, reason: 'X-PAYMENT-TX must be a Base transaction hash' };
  }

  const options = typeof optionsOrRequiredAmount === 'object'
    ? optionsOrRequiredAmount
    : { requiredAmountAtomic: optionsOrRequiredAmount };
  const required = BigInt(options.requiredAmountAtomic);
  const expectedVendorId = normalizeBytes16(options.expectedVendorId);
  const expectedProductId = options.expectedProductId === undefined ? undefined : BigInt(options.expectedProductId);
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_PAYMENT_AGE_SECONDS;

  try {
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
    ]);

    if (!tx.to || tx.to.toLowerCase() !== CONTRACTS.ROUTER.toLowerCase()) {
      return { valid: false, txHash, reason: 'transaction was not sent to PyrimidRouter' };
    }

    if (receipt.status !== 'success') {
      return { valid: false, txHash, reason: 'transaction did not succeed' };
    }

    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const txAgeSeconds = Math.floor(Date.now() / 1000) - Number(block.timestamp);

    if (txAgeSeconds > maxAgeSeconds) {
      return {
        valid: false,
        txHash,
        blockNumber: receipt.blockNumber,
        blockTimestamp: block.timestamp,
        reason: `payment proof expired: older than ${maxAgeSeconds} seconds`,
      };
    }

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== CONTRACTS.ROUTER.toLowerCase()) continue;

      try {
        const decoded = decodeEventLog({
          abi: [paymentRoutedEvent],
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName !== 'PaymentRouted') continue;

        const args = decoded.args as {
          vendorId: string;
          productId: bigint;
          buyer: string;
          amount: bigint;
        };

        if (expectedVendorId && args.vendorId.toLowerCase() !== expectedVendorId) {
          return {
            valid: false,
            txHash,
            vendorId: args.vendorId,
            blockNumber: receipt.blockNumber,
            blockTimestamp: block.timestamp,
            reason: 'payment vendorId mismatch',
          };
        }

        if (expectedProductId !== undefined && args.productId !== expectedProductId) {
          return {
            valid: false,
            txHash,
            productId: args.productId,
            blockNumber: receipt.blockNumber,
            blockTimestamp: block.timestamp,
            reason: 'payment productId mismatch',
          };
        }

        if (args.amount < required) {
          return {
            valid: false,
            txHash,
            amount: args.amount,
            blockNumber: receipt.blockNumber,
            blockTimestamp: block.timestamp,
            reason: `payment amount below required ${required.toString()} atomic USDC`,
          };
        }

        return {
          valid: true,
          txHash,
          amount: args.amount,
          buyer: args.buyer,
          vendorId: args.vendorId,
          productId: args.productId,
          blockNumber: receipt.blockNumber,
          blockTimestamp: block.timestamp,
        };
      } catch {
        // Not a PaymentRouted log; keep scanning.
      }
    }

    return {
      valid: false,
      txHash,
      blockNumber: receipt.blockNumber,
      blockTimestamp: block.timestamp,
      reason: 'no PyrimidRouter PaymentRouted event found',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = message.toLowerCase().includes('could not be found')
      ? 'transaction not found on Base'
      : 'payment verification failed';
    return { valid: false, txHash, reason };
  }
}
