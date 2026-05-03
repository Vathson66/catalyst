import { NextRequest, NextResponse } from 'next/server';

import { bcManagementBase, bcManagementHeaders } from '~/lib/checkout/bc-api/auth';

export interface PaymentMethodShape {
  id: string;
  gateway?: string;
  method: string;
  name: string;
  kind: 'manual' | 'card' | 'wallet' | 'online';
}

interface BcMgmtPaymentMethod {
  id: string;
  name: string;
  gateway?: string;
}

interface BcMgmtResponse {
  data?: BcMgmtPaymentMethod[];
}

function normalizeToken(value?: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function detectOfflineMethodType(id: string): PaymentMethodShape['method'] {
  const token = normalizeToken(id);

  if (token.includes('bank') || token.includes('deposit')) {
    return 'bank-deposit';
  }

  if (token.includes('cash') || token.includes('cod')) {
    return 'cash-on-delivery';
  }

  if (token.includes('check') || token.includes('moneyorder')) {
    return 'check';
  }

  return 'manual-payment';
}

function isOfflineMethod(m: BcMgmtPaymentMethod): boolean {
  const id = normalizeToken(m.id);
  const gateway = normalizeToken(m.gateway);

  if (gateway.includes('offline') || gateway.includes('manual')) {
    return true;
  }

  return (
    id.includes('bank') ||
    id.includes('deposit') ||
    id.includes('cash') ||
    id.includes('cod') ||
    id.includes('check') ||
    id.includes('moneyorder')
  );
}

function normalise(m: BcMgmtPaymentMethod): PaymentMethodShape {
  const lower = m.id.toLowerCase();

  if (isOfflineMethod(m)) {
    return {
      id: m.id,
      gateway: m.gateway,
      method: detectOfflineMethodType(m.id),
      name: m.name,
      kind: 'manual',
    };
  }

  // Wallets should stay as distinct wallet methods.
  if (lower.includes('google')) {
    return { id: m.id, gateway: m.gateway, method: 'googlepay', name: m.name, kind: 'wallet' };
  }

  if (lower.includes('apple')) {
    return { id: m.id, gateway: m.gateway, method: 'applepay', name: m.name, kind: 'wallet' };
  }

  if (lower.includes('amazon')) {
    return { id: m.id, gateway: m.gateway, method: 'amazonpay', name: m.name, kind: 'wallet' };
  }

  // PayPal is considered an online payment method in BC control panel categories.
  if (lower.includes('paypal')) {
    return { id: m.id, gateway: m.gateway, method: 'paypal', name: m.name, kind: 'online' };
  }

  // Card-like methods are also online methods in BC category terms.
  if (lower.includes('.card') || lower.includes('card') || lower === 'bigpaypay' || lower === 'stripeocs') {
    return { id: m.id, gateway: m.gateway, method: 'credit-card', name: m.name, kind: 'online' };
  }

  if (lower.includes('klarna') || lower.includes('afterpay') || lower.includes('clearpay') || lower.includes('zip') || lower.includes('laybuy') || lower.includes('sezzle')) {
    return { id: m.id, gateway: m.gateway, method: 'bnpl', name: m.name, kind: 'online' };
  }

  if (lower.includes('.ach') || lower === 'ach' || lower.includes('bank_transfer')) {
    return { id: m.id, gateway: m.gateway, method: 'bank-transfer', name: m.name, kind: 'online' };
  }

  // Fallback: keep method visible to shopper and let BC secure checkout handle it.
  return {
    id: m.id,
    gateway: m.gateway,
    method: 'online-payment',
    name: m.name,
    kind: 'online',
  };
}

function pruneGatewayVariants(methods: PaymentMethodShape[]): PaymentMethodShape[] {
  const idSet = new Set(methods.map((m) => m.id.toLowerCase()));

  return methods.filter((m) => {
    const lower = m.id.toLowerCase();

    // Prefer the shopper-facing PayPal flow over PayPal card tokenization variant.
    if (lower === 'paypalcommerce.card' && idSet.has('paypalcommerce.paypal')) {
      return false;
    }

    // Prefer Stripe card flow over ACH variant for method-picker simplicity.
    if (lower === 'stripeocs.ach' && idSet.has('stripeocs.card')) {
      return false;
    }

    return true;
  });
}

export async function GET(req: NextRequest) {
  const checkoutId = req.nextUrl.searchParams.get('checkoutId');

  if (!checkoutId) {
    return NextResponse.json(
      { error: 'checkoutId is required', methods: [], source: 'fallback' },
      { status: 400 },
    );
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
      const methods = pruneGatewayVariants((mgmtData.data ?? []).map(normalise));

      return NextResponse.json({
        methods,
        source: 'bc-management',
      });
    }

    const errorBody = await mgmtRes.text();
    return NextResponse.json(
      {
        error: `Unable to load payment methods from BigCommerce [${mgmtRes.status}]`,
        detail: errorBody,
        methods: [],
        source: 'fallback',
      },
      { status: 502 },
    );
  } catch {
    return NextResponse.json(
      {
        error: 'Unable to load payment methods from BigCommerce',
        methods: [],
        source: 'fallback',
      },
      { status: 502 },
    );
  }
}
