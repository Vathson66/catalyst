/**
 * Reverse-proxy for the BigCommerce Storefront REST API.
 * @bigcommerce/checkout-sdk calls /api/storefront/... internally.
 * This route forwards those requests to the actual BC storefront origin,
 * preserving method, headers, and body.
 */
import { type NextRequest, NextResponse } from 'next/server';

const STOREFRONT_URL = process.env.BC_STOREFRONT_URL?.replace(/\/$/, '');

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

async function proxy(
  req: NextRequest,
  pathSegments: string[],
  method: string,
): Promise<NextResponse> {
  if (!STOREFRONT_URL) {
    return NextResponse.json({ error: 'BC_STOREFRONT_URL not configured' }, { status: 503 });
  }

  const search = req.nextUrl.search ?? '';
  const targetUrl = `${STOREFRONT_URL}/api/storefront/${pathSegments.join('/')}${search}`;

  // Build proxy headers: forward all safe request headers, then layer on auth.
  const proxyHeaders = new Headers();

  // Headers to skip (hop-by-hop or Next.js internal)
  const skipHeaders = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding',
    'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
  ]);

  for (const [key, value] of req.headers.entries()) {
    if (!skipHeaders.has(key.toLowerCase())) {
      proxyHeaders.set(key, value);
    }
  }

  // Override / inject auth — storefront Bearer token takes precedence.
  const token = process.env.BIGCOMMERCE_STOREFRONT_TOKEN;
  if (token) proxyHeaders.set('Authorization', `Bearer ${token}`);

  const hasBody = method !== 'GET' && method !== 'DELETE';
  const bodyText = hasBody ? await req.text() : undefined;

  const res = await fetch(targetUrl, {
    method,
    headers: proxyHeaders,
    body: bodyText,
    cache: 'no-store',
  });

  // checkout-settings returns 404 on some BC plans/auth modes — the SDK
  // needs a 200 with empty/default settings to continue initialising.
  if (res.status === 404 && pathSegments[0] === 'checkout-settings') {
    return NextResponse.json({});
  }

  const responseBody = await res.text();
  return new NextResponse(responseBody, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  });
}
