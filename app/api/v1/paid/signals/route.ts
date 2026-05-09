import { NextRequest, NextResponse } from 'next/server';
import { CONTRACTS } from '@/lib/contracts';
import { verifyPyrimidPaymentTx } from '@/lib/payment-verification';

const PRICE_USDC = '0.25';
const PRODUCT_ID = 'pragma-signal-snapshot';
const VENDOR_ID = 'pragma-trading';
const PYRIMID_ROUTER = CONTRACTS.ROUTER;

function paymentRequired(req: NextRequest) {
  const url = new URL(req.url);
  const requirement = {
    x402Version: 2,
    scheme: 'exact',
    network: 'base',
    asset: 'USDC',
    maxAmountRequired: PRICE_USDC,
    payTo: PYRIMID_ROUTER,
    resource: url.toString(),
    description: 'Pragma BTC derivatives signal snapshot routed through Pyrimid',
    mimeType: 'application/json',
    vendorId: VENDOR_ID,
    productId: PRODUCT_ID,
    affiliateBps: 5000,
    protocol: 'pyrimid',
  };
  return NextResponse.json(
    {
      error: 'payment_required',
      message: `Pay ${PRICE_USDC} USDC on Base through Pyrimid, then retry with X-PAYMENT or X-PAYMENT-TX.`,
      accepts: [requirement],
      docs: 'https://pyrimid.ai/quickstart',
    },
    {
      status: 402,
      headers: {
        'X-PAYMENT-REQUIRED': JSON.stringify(requirement),
        'X-Pyrimid-Vendor': VENDOR_ID,
        'X-Pyrimid-Product': PRODUCT_ID,
        'Cache-Control': 'no-store',
      },
    }
  );
}

export async function GET(req: NextRequest) {
  const proof = req.headers.get('x-payment-tx') || req.headers.get('x-payment');
  if (!proof) return paymentRequired(req);

  const verification = await verifyPyrimidPaymentTx(proof, 250000);
  if (!verification.valid) {
    return NextResponse.json(
      {
        error: 'payment_invalid',
        message: verification.reason || 'Payment could not be verified on Base',
        docs: 'https://pyrimid.ai/quickstart',
        proof: 'https://pyrimid.ai/proof',
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json({
    product_id: PRODUCT_ID,
    vendor_id: VENDOR_ID,
    payment_tx: verification.txHash,
    payment_amount: verification.amount?.toString(),
    buyer: verification.buyer,
    signal: {
      asset: 'BTC-PERP',
      timeframe: '4H',
      stance: 'risk-managed only',
      note: 'Seed paid endpoint for Pyrimid/x402 integration testing. Use live Pragma APIs for production signals.',
      invalidation_required: true,
    },
    routed_by: 'pyrimid',
    links: {
      docs: 'https://pyrimid.ai/quickstart',
      proof: 'https://pyrimid.ai/proof',
      stats: 'https://pyrimid.ai/stats',
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
