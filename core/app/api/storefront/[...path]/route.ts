/**
 * Reverse-proxy for the BigCommerce Storefront REST API.
 * @bigcommerce/checkout-sdk calls /api/storefront/... internally.
 * This route forwards those requests to the actual BC storefront origin,
 * preserving method, headers, and body.
 */
import { type NextRequest, NextResponse } from 'next/server';

const STOREFRONT_URL = process.env.BC_STOREFRONT_URL?.replace(/\/$/, '');
const STOREFRONT_REQUEST_TIMEOUT_MS = 12_000;
const STOREFRONT_MAX_ATTEMPTS = 2;

const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'authorization',
  'cookie',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path, 'GET');
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path, 'POST');
}
export async function PUT(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path, 'PUT');
}
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path, 'DELETE');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function forwardToStorefront(
  targetUrl: string,
  method: string,
  headers: Headers,
  body: string | undefined,
): Promise<{ res: Response; responseBody: string }> {
  let lastResponse: Response | null = null;
  let lastBody = '';

  for (let attempt = 1; attempt <= STOREFRONT_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STOREFRONT_REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(targetUrl, {
        method,
        headers,
        body,
        cache: 'no-store',
        signal: controller.signal,
      });

      const responseBody = await res.text();

      if (res.ok) {
        return { res, responseBody };
      }

      lastResponse = res;
      lastBody = responseBody;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === STOREFRONT_MAX_ATTEMPTS) {
        return { res, responseBody };
      }
    } catch (err) {
      if (attempt === STOREFRONT_MAX_ATTEMPTS) {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }

    await delay(150 * attempt);
  }

  if (lastResponse) {
    return { res: lastResponse, responseBody: lastBody };
  }

  throw new Error('Unable to reach BigCommerce storefront API');
}

async function proxy(
  req: NextRequest,
  pathSegments: string[],
  method: string,
): Promise<NextResponse> {
  if (!STOREFRONT_URL) {
    return NextResponse.json({ error: 'BC_STOREFRONT_URL not configured' }, { status: 503 });
  }

  const search = req.nextUrl.search ?? '';
  const storefrontPath = pathSegments.join('/');
  const targetUrl = `${STOREFRONT_URL}/api/storefront/${storefrontPath}${search}`;

  // Build proxy headers: forward all safe request headers, then layer on auth.
  const proxyHeaders = new Headers();

  for (const [key, value] of req.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      proxyHeaders.set(key, value);
    }
  }

  // Override / inject auth — storefront Bearer token takes precedence.
  const token = process.env.BIGCOMMERCE_STOREFRONT_TOKEN;
  if (token) proxyHeaders.set('Authorization', `Bearer ${token}`);

  const hasBody = method !== 'GET' && method !== 'DELETE';
  const bodyText = hasBody ? await req.text() : undefined;

  try {
    const { res, responseBody } = await forwardToStorefront(
      targetUrl,
      method,
      proxyHeaders,
      bodyText,
    );

    // checkout-settings returns 404 on some BC plans/auth modes — the SDK
    // needs a 200 with empty/default settings to continue initialising.
    if (res.status === 404 && pathSegments[0] === 'checkout-settings') {
      return NextResponse.json({});
    }

    if (res.status === 401 || res.status >= 500) {
      console.warn(
        `[storefront-proxy] ${method} ${storefrontPath} -> ${res.status}`,
      );
    }

    const responseHeaders = new Headers();
    const contentType = res.headers.get('Content-Type');
    const cacheControl = res.headers.get('Cache-Control');
    const location = res.headers.get('Location');

    if (contentType) {
      responseHeaders.set('Content-Type', contentType);
    }
    if (cacheControl) {
      responseHeaders.set('Cache-Control', cacheControl);
    }
    if (location) {
      responseHeaders.set('Location', location);
    }

    return new NextResponse(responseBody, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Storefront proxy request failed';
    console.error(`[storefront-proxy] ${method} ${storefrontPath} failed: ${message}`);

    return NextResponse.json(
      { error: 'Storefront API is temporarily unavailable. Please try again.' },
      { status: 502 },
    );
  }
}
