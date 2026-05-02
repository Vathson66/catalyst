import { NextRequest, NextResponse } from 'next/server';

import { bcManagementBase, bcManagementHeaders } from '~/lib/checkout/bc-api/auth';

interface RedirectUrlsResponse {
  data?: {
    checkout_url?: string;
  };
}

export async function GET(req: NextRequest) {
  const checkoutId = req.nextUrl.searchParams.get('checkoutId');

  if (!checkoutId) {
    return NextResponse.json({ error: 'checkoutId is required' }, { status: 400 });
  }

  try {
    // In BigCommerce, checkout id matches cart id for this flow.
    // Generate a fresh redirect URL each time so the shopper is sent to
    // BC-hosted checkout using current cart/session context.
    const res = await fetch(
      `${bcManagementBase()}/carts/${encodeURIComponent(checkoutId)}/redirect_urls`,
      {
        method: 'POST',
        headers: bcManagementHeaders(),
        body: JSON.stringify({}),
        cache: 'no-store',
      },
    );

    const bodyText = await res.text();
    let payload: RedirectUrlsResponse = {};
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText) as RedirectUrlsResponse;
      } catch {
        payload = {};
      }
    }

    if (!res.ok) {
      return NextResponse.json(
        {
          error: `Unable to fetch checkout redirect URL [${res.status}]`,
          detail: bodyText || undefined,
        },
        { status: 502 },
      );
    }

    const checkoutUrl = payload.data?.checkout_url;
    if (!checkoutUrl) {
      return NextResponse.json(
        { error: 'No checkout redirect URL returned by BigCommerce' },
        { status: 502 },
      );
    }

    return NextResponse.json({ checkoutUrl });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : 'Unexpected error while loading checkout URL',
      },
      { status: 500 },
    );
  }
}
