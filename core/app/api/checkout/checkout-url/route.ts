import { NextRequest, NextResponse } from 'next/server';

import { bcManagementBase, bcManagementHeaders } from '~/lib/checkout/bc-api/auth';

const BC_REDIRECT_TIMEOUT_MS = 10_000;
const BC_REDIRECT_MAX_ATTEMPTS = 2;

interface RedirectUrlsResponse {
  data?: {
    checkout_url?: string;
    embedded_checkout_url?: string;
  };
}

function isValidCheckoutId(checkoutId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(checkoutId);
}

function isSecureHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestRedirectUrl(checkoutId: string): Promise<{ res: Response; bodyText: string }> {
  let lastResponse: Response | null = null;
  let lastBody = '';

  for (let attempt = 1; attempt <= BC_REDIRECT_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BC_REDIRECT_TIMEOUT_MS);

    try {
      const res = await fetch(
        `${bcManagementBase()}/carts/${encodeURIComponent(checkoutId)}/redirect_urls`,
        {
          method: 'POST',
          headers: bcManagementHeaders(),
          body: JSON.stringify({}),
          cache: 'no-store',
          signal: controller.signal,
        },
      );

      const bodyText = await res.text();

      if (res.ok) {
        return { res, bodyText };
      }

      lastResponse = res;
      lastBody = bodyText;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === BC_REDIRECT_MAX_ATTEMPTS) {
        return { res, bodyText };
      }
    } catch (err) {
      if (attempt === BC_REDIRECT_MAX_ATTEMPTS) {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }

    await delay(200 * attempt);
  }

  if (lastResponse) {
    return { res: lastResponse, bodyText: lastBody };
  }

  throw new Error('Unable to fetch checkout redirect URL from BigCommerce');
}

export async function GET(req: NextRequest) {
  const requestId = `checkout-url-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const checkoutId = req.nextUrl.searchParams.get('checkoutId')?.trim();

  if (!checkoutId) {
    return NextResponse.json({ error: 'checkoutId is required' }, { status: 400 });
  }

  if (!isValidCheckoutId(checkoutId)) {
    return NextResponse.json({ error: 'checkoutId format is invalid' }, { status: 400 });
  }

  try {
    // In BigCommerce, checkout id matches cart id for this flow.
    // Generate a fresh redirect URL each time so the shopper is sent to
    // BC-hosted checkout using current cart/session context.
    const { res, bodyText } = await requestRedirectUrl(checkoutId);

    let payload: RedirectUrlsResponse = {};
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText) as RedirectUrlsResponse;
      } catch {
        payload = {};
      }
    }

    if (!res.ok) {
      console.error(
        `[checkout-url] requestId=${requestId} checkoutId=${checkoutId} status=${res.status}`,
      );

      return NextResponse.json(
        {
          error: `Unable to fetch checkout redirect URL [${res.status}]`,
          detail: bodyText.slice(0, 800) || undefined,
          requestId,
        },
        { status: 502 },
      );
    }

    const checkoutUrl = payload.data?.checkout_url ?? payload.data?.embedded_checkout_url;
    if (!checkoutUrl) {
      return NextResponse.json(
        { error: 'No checkout redirect URL returned by BigCommerce', requestId },
        { status: 502 },
      );
    }

    if (!isSecureHttpUrl(checkoutUrl)) {
      return NextResponse.json(
        { error: 'BigCommerce returned an invalid checkout URL', requestId },
        { status: 502 },
      );
    }

    return NextResponse.json({ checkoutUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error while loading checkout URL';
    console.error(`[checkout-url] requestId=${requestId} checkoutId=${checkoutId} error=${message}`);

    return NextResponse.json(
      {
        error: message,
        requestId,
      },
      { status: 500 },
    );
  }
}
