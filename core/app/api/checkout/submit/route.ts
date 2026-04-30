import { NextResponse } from 'next/server';

import { loadCheckoutSession } from '~/lib/checkout/session';
import { submitCheckout } from '~/lib/checkout/submit';

export async function POST(request: Request) {
  const body = (await request.json()) as {
    checkoutId?: string;
    methodId?: string;
    gatewayId?: string;
  };

  if (!body.checkoutId) {
    return NextResponse.json({ error: 'checkoutId is required' }, { status: 400 });
  }

  const session = await loadCheckoutSession(body.checkoutId);
  const result = await submitCheckout(session, body.methodId ?? 'credit-card', body.gatewayId);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }

  return NextResponse.json({ orderId: result.orderId });
}
