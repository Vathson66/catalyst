import { NextRequest, NextResponse } from 'next/server';

import { auth, getCheckoutCustomerSession } from '~/auth';
import { generateCustomerLoginApiJwt } from '~/auth/customer-login-api';

interface BcCustomer {
  id: number;
  email: string;
}

interface HostedLoginUrlRequest {
  checkoutUrl?: string;
  checkoutId?: string;
  carryCustomerIdentity?: boolean;
}

interface RedirectUrlsResponse {
  data?: {
    checkout_url?: string;
    embedded_checkout_url?: string;
  };
}

const BIGCOMMERCE_MANAGED_HOST_SUFFIXES = [
  '.mybigcommerce.com',
  '.bigcommerce.com',
  '.bigcommerce.net',
];

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function resolveStoreHash(): string {
  return requireEnv('BIGCOMMERCE_STORE_HASH');
}

function resolveChannelId(): number {
  const raw = process.env.BIGCOMMERCE_CHANNEL_ID?.trim();

  if (!raw) {
    return 1;
  }

  const parsed = Number(raw);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function bcBase(): string {
  return `https://api.bigcommerce.com/stores/${resolveStoreHash()}`;
}

function bcHeaders(): Record<string, string> {
  return {
    'X-Auth-Token': requireEnv('BC_MANAGEMENT_TOKEN'),
    Accept: 'application/json',
  };
}

function bcJsonHeaders(): Record<string, string> {
  return {
    ...bcHeaders(),
    'Content-Type': 'application/json',
  };
}

function isValidCheckoutId(checkoutId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(checkoutId);
}

function resolveCheckoutIdFromUrl(checkoutUrl: URL): string | undefined {
  const candidates = ['checkoutId', 'checkout_id', 'cartId', 'cart_id', 'id'];
  const hashParams = new URLSearchParams(checkoutUrl.hash.replace(/^#\??/, ''));

  for (const key of candidates) {
    const value = checkoutUrl.searchParams.get(key)?.trim();

    if (value && isValidCheckoutId(value)) {
      return value;
    }

    const hashValue = hashParams.get(key)?.trim();

    if (hashValue && isValidCheckoutId(hashValue)) {
      return hashValue;
    }
  }

  // Some BigCommerce redirects carry the checkout/cart identifier in the URL path.
  const pathSegments = checkoutUrl.pathname.split('/').map((segment) => segment.trim());

  for (let index = pathSegments.length - 1; index >= 0; index -= 1) {
    const segment = pathSegments[index];

    if (segment && isValidCheckoutId(segment) && segment.length >= 8 && /\d/.test(segment)) {
      return segment;
    }
  }

  return undefined;
}

function isBigCommerceManagedCheckoutHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);

  return BIGCOMMERCE_MANAGED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function buildTrustedCheckoutHosts(): Set<string> {
  const hosts = new Set<string>();
  const storefrontUrl = process.env.BC_STOREFRONT_URL?.trim();

  if (storefrontUrl) {
    try {
      hosts.add(normalizeHostname(new URL(storefrontUrl).hostname));
    } catch {
      // Ignore malformed storefront URL env and rely on default host.
    }
  }

  hosts.add(normalizeHostname(`store-${resolveStoreHash()}.mybigcommerce.com`));

  return hosts;
}

function parseCheckoutUrl(rawUrl: string): URL {
  const checkoutUrl = new URL(rawUrl);
  const protocol = checkoutUrl.protocol.toLowerCase();

  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error('checkoutUrl must be an absolute http(s) URL');
  }

  return checkoutUrl;
}

async function resolveCheckoutHostsFromBigCommerce(checkoutId: string): Promise<Set<string>> {
  const hosts = new Set<string>();
  const res = await fetch(`${bcBase()}/v3/carts/${encodeURIComponent(checkoutId)}/redirect_urls`, {
    method: 'POST',
    headers: bcJsonHeaders(),
    body: JSON.stringify({}),
    cache: 'no-store',
  });

  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`Could not verify checkout host [${res.status}]`);
  }

  let payload: RedirectUrlsResponse = {};

  if (bodyText) {
    try {
      payload = JSON.parse(bodyText) as RedirectUrlsResponse;
    } catch {
      payload = {};
    }
  }

  const checkoutUrls = [payload.data?.checkout_url, payload.data?.embedded_checkout_url].filter(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );

  for (const checkoutUrl of checkoutUrls) {
    try {
      hosts.add(normalizeHostname(new URL(checkoutUrl).hostname));
    } catch {
      // Ignore malformed URL entries and continue with remaining candidates.
    }
  }

  return hosts;
}

function reconcileCheckoutUrl(trustedCheckoutUrl: URL, requestedCheckoutUrl: URL): URL {
  const reconciled = new URL(trustedCheckoutUrl.toString());

  for (const [key, value] of requestedCheckoutUrl.searchParams.entries()) {
    reconciled.searchParams.set(key, value);
  }

  reconciled.hash = requestedCheckoutUrl.hash;

  return reconciled;
}

async function resolveTrustedCheckoutUrl(checkoutUrl: URL, checkoutId?: string): Promise<URL> {
  const checkoutHost = normalizeHostname(checkoutUrl.hostname);
  const trustedHosts = buildTrustedCheckoutHosts();

  if (trustedHosts.has(checkoutHost)) {
    return checkoutUrl;
  }

  if (checkoutId && isValidCheckoutId(checkoutId)) {
    if (isBigCommerceManagedCheckoutHost(checkoutHost)) {
      // The cart redirect URL is already minted by our checkout-url route.
      // Avoid calling redirect_urls again here because BC can rotate the
      // one-time loader URL and strand the shopper back on cart.php.
      return checkoutUrl;
    }

    const verifiedHosts = await resolveCheckoutHostsFromBigCommerce(checkoutId);

    if (verifiedHosts.has(checkoutHost)) {
      return checkoutUrl;
    }

    // Some stores can receive valid redirect URLs while the redirect host payload is empty.
    // In that case, continue for known BigCommerce-managed domains after checkoutId verification.
    if (verifiedHosts.size === 0 && isBigCommerceManagedCheckoutHost(checkoutHost)) {
      return checkoutUrl;
    }

    // Some BigCommerce-managed checkout hosts vary by edge routing while still being valid
    // for the same checkout/cart. Reconcile to one verified host while preserving query params.
    if (
      isBigCommerceManagedCheckoutHost(checkoutHost) &&
      Array.from(verifiedHosts).some((host) => isBigCommerceManagedCheckoutHost(host))
    ) {
      const verifiedHost = Array.from(verifiedHosts).find((host) =>
        isBigCommerceManagedCheckoutHost(host),
      );

      if (verifiedHost) {
        const reconciledCheckoutUrl = reconcileCheckoutUrl(
          new URL(`${checkoutUrl.protocol}//${verifiedHost}${checkoutUrl.pathname}`),
          checkoutUrl,
        );

        console.warn(
          `[hosted-login-url] checkout host mismatch reconciled for checkoutId=${checkoutId} requestedHost=${checkoutHost} verifiedHost=${verifiedHost}`,
        );

        return reconciledCheckoutUrl;
      }
    }
  }

  throw new Error('checkoutUrl host is not trusted for hosted login');
}

async function lookupCustomerByEmail(email: string): Promise<BcCustomer | null> {
  const res = await fetch(`${bcBase()}/v2/customers?email=${encodeURIComponent(email)}&limit=1`, {
    headers: bcHeaders(),
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Customer lookup failed with status ${res.status}`);
  }

  const bodyText = await res.text();

  if (!bodyText || bodyText.trim() === '') {
    return null;
  }

  let customers: BcCustomer[] = [];

  try {
    customers = JSON.parse(bodyText) as BcCustomer[];
  } catch {
    customers = [];
  }

  if (!Array.isArray(customers) || customers.length === 0) {
    return null;
  }

  const customer = customers[0];

  if (!customer?.id) {
    return null;
  }

  return customer;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as HostedLoginUrlRequest;
    const checkoutUrlRaw = body.checkoutUrl?.trim();
    const checkoutIdRaw = body.checkoutId?.trim();
    const carryCustomerIdentity = body.carryCustomerIdentity !== false;

    if (!checkoutUrlRaw) {
      return NextResponse.json({ error: 'checkoutUrl is required' }, { status: 400 });
    }

    if (checkoutIdRaw && !isValidCheckoutId(checkoutIdRaw)) {
      return NextResponse.json({ error: 'checkoutId format is invalid' }, { status: 400 });
    }

    const checkoutUrl = parseCheckoutUrl(checkoutUrlRaw);
    const checkoutId = checkoutIdRaw || resolveCheckoutIdFromUrl(checkoutUrl);
    const trustedCheckoutUrl = await resolveTrustedCheckoutUrl(checkoutUrl, checkoutId);

    if (!carryCustomerIdentity) {
      return NextResponse.json({
        launchUrl: trustedCheckoutUrl.toString(),
        identityCarried: false,
      });
    }

    const session = await auth();
    const checkoutCustomerSession = await getCheckoutCustomerSession();
    const sessionEmail = (session?.user?.email ?? checkoutCustomerSession?.user?.email)
      ?.trim()
      .toLowerCase();

    if (!sessionEmail) {
      return NextResponse.json({
        launchUrl: trustedCheckoutUrl.toString(),
        identityCarried: false,
      });
    }

    const customer = await lookupCustomerByEmail(sessionEmail);

    if (!customer) {
      return NextResponse.json(
        {
          error:
            'Your storefront login could not be mapped to a BigCommerce customer account for hosted checkout.',
        },
        { status: 409 },
      );
    }

    const redirectTo = `${trustedCheckoutUrl.pathname}${trustedCheckoutUrl.search}${trustedCheckoutUrl.hash}`;
    const token = await generateCustomerLoginApiJwt(customer.id, resolveChannelId(), redirectTo);
    const launchUrl = `${trustedCheckoutUrl.origin}/login/token/${token}`;

    return NextResponse.json({
      launchUrl,
      identityCarried: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';

    if (
      message.includes('Customer Login signing secret') ||
      message.includes('Customer Login signing client ID') ||
      message.includes('BIGCOMMERCE_CLIENT_SECRET') ||
      message.includes('BIGCOMMERCE_CLIENT_ID') ||
      message.includes('BC_CUSTOMER_LOGIN_CLIENT_SECRET') ||
      message.includes('BC_CUSTOMER_LOGIN_CLIENT_ID')
    ) {
      return NextResponse.json(
        {
          error:
            'Hosted customer identity bridge is not configured. Set BC_CUSTOMER_LOGIN_CLIENT_ID and BC_CUSTOMER_LOGIN_CLIENT_SECRET (or BIGCOMMERCE_CLIENT_ID and BIGCOMMERCE_CLIENT_SECRET).',
          code: 'HOSTED_IDENTITY_NOT_CONFIGURED',
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
