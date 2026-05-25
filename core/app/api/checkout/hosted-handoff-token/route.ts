import { NextResponse } from 'next/server';
import { z } from 'zod';

import { signHostedCheckoutHandoffToken } from '~/lib/checkout/hosted-handoff-token';

const HostedHandoffTokenBodySchema = z.object({
  checkoutId: z.string().optional(),
  paymentOnly: z.boolean().optional(),
  returnUrl: z.string().url(),
  checkoutUrl: z.string().url(),
  cartUrl: z.string().url(),
  paymentMethodId: z.string().max(255).optional(),
  paymentGatewayId: z.string().max(255).optional(),
  paymentMethodType: z.string().max(255).optional(),
});

function isValidCheckoutId(checkoutId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(checkoutId);
}

export async function POST(request: Request) {
  try {
    const parseResult = HostedHandoffTokenBodySchema.safeParse(await request.json());
    const body = parseResult.success ? parseResult.data : null;
    const checkoutId = body?.checkoutId?.trim();

    if (!body) {
      return NextResponse.json(
        { error: 'Hosted checkout handoff payload is invalid' },
        { status: 400 },
      );
    }

    if (!checkoutId) {
      return NextResponse.json({ error: 'checkoutId is required' }, { status: 400 });
    }

    if (!isValidCheckoutId(checkoutId)) {
      return NextResponse.json({ error: 'checkoutId format is invalid' }, { status: 400 });
    }

    const token = signHostedCheckoutHandoffToken({
      checkoutId,
      paymentOnly: body.paymentOnly ?? true,
      returnUrl: body.returnUrl,
      checkoutUrl: body.checkoutUrl,
      cartUrl: body.cartUrl,
      paymentMethodId: body.paymentMethodId,
      paymentGatewayId: body.paymentGatewayId,
      paymentMethodType: body.paymentMethodType,
    });

    return NextResponse.json({ token });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unable to create hosted checkout handoff token';

    console.error(`[checkout-hosted-handoff-token] ${message}`);

    return NextResponse.json(
      { error: 'Unable to prepare hosted checkout handoff. Please try again.' },
      { status: 500 },
    );
  }
}
