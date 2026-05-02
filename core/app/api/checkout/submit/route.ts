import { NextResponse } from 'next/server';

import { loadCheckoutSession } from '~/lib/checkout/session';
import { submitCheckout } from '~/lib/checkout/submit';

interface SubmitCheckoutBody {
  checkoutId?: string;
  methodId?: string;
  gatewayId?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SubmitCheckoutBody;
    const checkoutId = body.checkoutId?.trim();
    const methodId = body.methodId?.trim();
    const gatewayId = body.gatewayId?.trim();

    if (!checkoutId) {
      return NextResponse.json({ error: 'checkoutId is required' }, { status: 400 });
    }

    if (body.methodId !== undefined && typeof body.methodId !== 'string') {
      return NextResponse.json({ error: 'methodId must be a string when provided' }, { status: 400 });
    }

    if (body.gatewayId !== undefined && typeof body.gatewayId !== 'string') {
      return NextResponse.json({ error: 'gatewayId must be a string when provided' }, { status: 400 });
    }

    const session = await loadCheckoutSession(checkoutId);
    const result = await submitCheckout(session, methodId ?? 'credit-card', gatewayId);

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }

    return NextResponse.json({ orderId: result.orderId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected checkout submit failure';
    const normalized = message.toLowerCase();
    const missingCheckout = normalized.includes('[404]') || normalized.includes('not found');

    if (missingCheckout) {
      return NextResponse.json(
        { error: 'This checkout has expired. Please return to cart and try again.' },
        { status: 404 },
      );
    }

    console.error(`[checkout-submit] ${message}`);

    return NextResponse.json(
      { error: 'Unable to submit checkout right now. Please try again.' },
      { status: 500 },
    );
  }
}
