import { NextRequest, NextResponse } from 'next/server';

import { auth } from '~/auth';
import { generateCustomerLoginApiJwt } from '~/auth/customer-login-api';

interface BcCustomer {
  id: number;
  email: string;
}

interface HostedLoginUrlRequest {
  checkoutUrl?: string;
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

function buildTrustedCheckoutHosts(): Set<string> {
  const hosts = new Set<string>();
  const storefrontUrl = process.env.BC_STOREFRONT_URL?.trim();

  if (storefrontUrl) {
    try {
      hosts.add(new URL(storefrontUrl).host.toLowerCase());
    } catch {
      // Ignore malformed storefront URL env and rely on default host.
    }
  }

  hosts.add(`store-${resolveStoreHash()}.mybigcommerce.com`);

  return hosts;
}

function parseCheckoutUrl(rawUrl: string): URL {
  const checkoutUrl = new URL(rawUrl);
  const protocol = checkoutUrl.protocol.toLowerCase();

  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error('checkoutUrl must be an absolute http(s) URL');
  }

  const trustedHosts = buildTrustedCheckoutHosts();

  if (!trustedHosts.has(checkoutUrl.host.toLowerCase())) {
    throw new Error('checkoutUrl host is not trusted for hosted login');
  }

  return checkoutUrl;
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

    if (!checkoutUrlRaw) {
      return NextResponse.json({ error: 'checkoutUrl is required' }, { status: 400 });
    }

    const checkoutUrl = parseCheckoutUrl(checkoutUrlRaw);
    const session = await auth();
    const sessionEmail = session?.user?.email?.trim().toLowerCase();

    if (!sessionEmail) {
      return NextResponse.json({
        launchUrl: checkoutUrl.toString(),
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

    const redirectTo = `${checkoutUrl.pathname}${checkoutUrl.search}${checkoutUrl.hash}`;
    const token = await generateCustomerLoginApiJwt(customer.id, resolveChannelId(), redirectTo);
    const launchUrl = `${checkoutUrl.origin}/login/token/${token}`;

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