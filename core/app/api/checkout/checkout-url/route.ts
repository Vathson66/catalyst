import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { bcManagementBase, bcManagementHeaders } from '~/lib/checkout/bc-api/auth';

const BC_REDIRECT_TIMEOUT_MS = 10_000;
const BC_REDIRECT_MAX_ATTEMPTS = 2;

const QueryParamsSchema = z.record(
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/),
  z.string().max(4096),
);

const CheckoutUrlRequestSchema = z.object({
  checkoutId: z.string().optional(),
  queryParams: QueryParamsSchema.optional(),
});

const RedirectUrlsResponseSchema = z
  .object({
    data: z
      .object({
        checkout_url: z.string().optional(),
        embedded_checkout_url: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

type RedirectQueryParams = z.infer<typeof QueryParamsSchema>;
type RedirectUrlsResponse = z.infer<typeof RedirectUrlsResponseSchema>;

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

async function requestRedirectUrl(
  checkoutId: string,
  queryParams?: RedirectQueryParams,
): Promise<{ res: Response; bodyText: string }> {
  let lastResponse: Response | null = null;
  let lastBody = '';
  const body = queryParams ? { query_params: queryParams } : {};

  for (let attempt = 1; attempt <= BC_REDIRECT_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BC_REDIRECT_TIMEOUT_MS);

    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(
        `${bcManagementBase()}/carts/${encodeURIComponent(checkoutId)}/redirect_urls`,
        {
          method: 'POST',
          headers: bcManagementHeaders(),
          body: JSON.stringify(body),
          cache: 'no-store',
          signal: controller.signal,
        },
      );

      // eslint-disable-next-line no-await-in-loop
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

    // eslint-disable-next-line no-await-in-loop
    await delay(200 * attempt);
  }

  if (lastResponse) {
    return { res: lastResponse, bodyText: lastBody };
  }

  throw new Error('Unable to fetch checkout redirect URL from BigCommerce');
}

async function handleCheckoutUrlRequest(
  checkoutId: string | undefined,
  queryParams?: RedirectQueryParams,
) {
  const requestId = `checkout-url-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedCheckoutId = checkoutId?.trim();

  if (!normalizedCheckoutId) {
    return NextResponse.json({ error: 'checkoutId is required' }, { status: 400 });
  }

  if (!isValidCheckoutId(normalizedCheckoutId)) {
    return NextResponse.json({ error: 'checkoutId format is invalid' }, { status: 400 });
  }

  try {
    // In BigCommerce, checkout id matches cart id for this flow.
    // Generate a fresh redirect URL each time so the shopper is sent to
    // BC-hosted checkout using current cart/session context.
    const { res, bodyText } = await requestRedirectUrl(normalizedCheckoutId, queryParams);

    const payload = parseRedirectUrlsResponse(bodyText);

    if (!res.ok) {
      console.error(
        `[checkout-url] requestId=${requestId} checkoutId=${normalizedCheckoutId} status=${res.status}`,
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
    console.error(
      `[checkout-url] requestId=${requestId} checkoutId=${normalizedCheckoutId} error=${message}`,
    );

    return NextResponse.json(
      {
        error: message,
        requestId,
      },
      { status: 500 },
    );
  }
}

function parseRedirectUrlsResponse(bodyText: string): RedirectUrlsResponse {
  if (!bodyText) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(bodyText);
    const result = RedirectUrlsResponseSchema.safeParse(parsed);

    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest) {
  return handleCheckoutUrlRequest(req.nextUrl.searchParams.get('checkoutId') ?? undefined);
}

export async function POST(req: NextRequest) {
  const parseResult = CheckoutUrlRequestSchema.safeParse(await req.json());

  if (!parseResult.success) {
    return NextResponse.json(
      { error: 'checkoutId or redirect query parameters are invalid' },
      { status: 400 },
    );
  }

  return handleCheckoutUrlRequest(parseResult.data.checkoutId, parseResult.data.queryParams);
}
