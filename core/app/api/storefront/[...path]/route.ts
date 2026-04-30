/**
 * Reverse-proxy for the BigCommerce Storefront REST API.
 * @bigcommerce/checkout-sdk calls /api/storefront/... internally.
 * This route forwards those requests to the actual BC storefront origin,
 * preserving method, headers, and body.
 */
import { type NextRequest, NextResponse } from 'next/server';

const STOREFRONT_URL = process.env.BC_STOREFRONT_URL?.replace(/\/$/, '');

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, params.path, 'GET');
}
export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, params.path, 'POST');
}
export async function PUT(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, params.path, 'PUT');
}
export async function DELETE(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, params.path, 'DELETE');
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

  const proxyHeaders = new Headers();
  const token = process.env.BC_STOREFRONT_TOKEN;
  if (token) proxyHeaders.set('Authorization', `Bearer ${token}`);
  proxyHeaders.set('Content-Type', 'application/json');

  const upstream = await req.headers;
  // Forward useful headers
  const acceptHeader = upstream.get('Accept');
  if (acceptHeader) proxyHeaders.set('Accept', acceptHeader);
  const cookieHeader = upstream.get('Cookie');
  if (cookieHeader) proxyHeaders.set('Cookie', cookieHeader);

  const hasBody = method !== 'GET' && method !== 'DELETE';
  const bodyText = hasBody ? await req.text() : undefined;

  const res = await fetch(targetUrl, {
    method,
    headers: proxyHeaders,
    body: bodyText,
    cache: 'no-store',
  });

  const responseBody = await res.text();
  return new NextResponse(responseBody, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  });
}
