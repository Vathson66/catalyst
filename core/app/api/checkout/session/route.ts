import { type NextRequest, NextResponse } from 'next/server';

import { loadCheckoutSession } from '~/lib/checkout/session';

export async function GET(req: NextRequest) {
  const checkoutId = req.nextUrl.searchParams.get('checkoutId');

  if (!checkoutId) {
    return NextResponse.json({ error: 'checkoutId is required' }, { status: 400 });
  }

  const session = await loadCheckoutSession(checkoutId);

  return NextResponse.json(session);
}
