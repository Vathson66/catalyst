import { NextResponse } from 'next/server';
import { z } from 'zod';

import { signCheckoutReturnToken } from '~/lib/checkout/return-token';
import { loadCheckoutSession } from '~/lib/checkout/session';

const ReturnTokenBodySchema = z.object({
  checkoutId: z.string().optional(),
  email: z.string().optional(),
  currency: z.string().optional(),
});

function isValidCheckoutId(checkoutId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(checkoutId);
}

export async function POST(request: Request) {
  try {
    const parseResult = ReturnTokenBodySchema.safeParse(await request.json());
    const body = parseResult.success ? parseResult.data : {};
    const checkoutId = body.checkoutId?.trim();

    if (!checkoutId) {
      return NextResponse.json({ error: 'checkoutId is required' }, { status: 400 });
    }

    if (!isValidCheckoutId(checkoutId)) {
      return NextResponse.json({ error: 'checkoutId format is invalid' }, { status: 400 });
    }

    const session = await loadCheckoutSession(checkoutId);
    const token = signCheckoutReturnToken({
      checkoutId,
      email: session.customer.email ?? body.email,
      currency: body.currency ?? session.currencyCode,
    });

    return NextResponse.json({ token });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to create checkout return token';

    console.error(`[checkout-return-token] ${message}`);

    return NextResponse.json(
      { error: 'Unable to prepare secure checkout return. Please try again.' },
      { status: 500 },
    );
  }
}
