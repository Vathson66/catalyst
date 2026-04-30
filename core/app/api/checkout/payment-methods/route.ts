import { NextRequest, NextResponse } from 'next/server';

import { bcManagementBase, bcManagementHeaders } from '~/lib/checkout/bc-api/auth';

export interface PaymentMethodShape {
  id: string;
  gateway?: string;
  method: string;
  name: string;
}

function mapMethod(id: string): string {
  const lower = id.toLowerCase();
  if (lower === 'bank_deposit') return 'bank-deposit';
  if (lower === 'cash_on_delivery') return 'cash-on-delivery';
  if (lower === 'check_money_order') return 'check';
  if (lower === 'bigpaypay') return 'credit-card';
  if (lower === 'paypalcommerceacceleratedcheckout') return 'credit-card';
  if (lower === 'paypalcommerce' || lower === 'paypalcommercecredit') return 'paypal';
  if (lower.includes('paypal')) return 'paypal';
  if (lower.includes('google')) return 'googlepay';
  if (lower.includes('apple')) return 'applepay';
  if (lower.includes('amazon')) return 'amazonpay';
  if (lower.includes('klarna')) return 'klarna';
  if (lower.includes('afterpay') || lower.includes('clearpay')) return 'afterpay';
  return 'credit-card';
}

const OFFLINE_METHOD_DEFINITIONS: Record<string, PaymentMethodShape> = {
  bank_deposit:     { id: 'bank_deposit',     method: 'bank-deposit',     name: 'Bank Deposit' },
  cash_on_delivery: { id: 'cash_on_delivery', method: 'cash-on-delivery', name: 'Cash on Delivery' },
  check_money_order: { id: 'check_money_order', method: 'check',          name: 'Check / Money Order' },
};

function getConfiguredOfflineMethods(): PaymentMethodShape[] {
  const raw = process.env.CHECKOUT_OFFLINE_METHODS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((key) => OFFLINE_METHOD_DEFINITIONS[key])
    .filter((m): m is PaymentMethodShape => m !== undefined);
}

const SKIP_METHODS = new Set([
  'paypalcommerceacceleratedcheckout',
  'paypalcommercevenmo',
]);

interface BcMgmtPaymentMethod {
  id: string;
  name: string;
  gateway?: string;
}

interface BcMgmtResponse {
  data?: BcMgmtPaymentMethod[];
}

function normalise(m: BcMgmtPaymentMethod): PaymentMethodShape | null {
  const lower = m.id.toLowerCase();
  if (SKIP_METHODS.has(lower)) return null;
  return {
    id: m.id,
    gateway: m.gateway,
    method: mapMethod(m.id),
    name: m.name,
  };
}

export async function GET(req: NextRequest) {
  const checkoutId = req.nextUrl.searchParams.get('checkoutId');
  const offlineMethods = getConfiguredOfflineMethods();

  if (!checkoutId) {
    return NextResponse.json({ methods: offlineMethods, source: 'fallback' });
  }

  try {
    const base = bcManagementBase();
    const headers = bcManagementHeaders();

    const mgmtRes = await fetch(
      `${base}/payments/methods?checkout_id=${encodeURIComponent(checkoutId)}`,
      { headers, cache: 'no-store' },
    );

    if (mgmtRes.ok) {
      const mgmtData = (await mgmtRes.json()) as BcMgmtResponse;
      const onlineMethods = (mgmtData.data ?? [])
        .map(normalise)
        .filter((m): m is PaymentMethodShape => m !== null);

      // Deduplicate offline methods (don't add if BC already returned them)
      const existingIds = new Set(onlineMethods.map((m) => m.id));
      const filteredOffline = offlineMethods.filter((m) => !existingIds.has(m.id));

      return NextResponse.json({
        methods: [...onlineMethods, ...filteredOffline],
        source: 'bc-management',
      });
    }
  } catch {
    // fall through to fallback
  }

  return NextResponse.json({ methods: offlineMethods, source: 'fallback' });
}
