/**
 * POST /api/checkout/auth/sign-in
 *
 * Validates BC customer credentials and returns profile + saved addresses.
 * Server-side only.
 */
import { NextRequest, NextResponse } from 'next/server';

import { signIn } from '~/auth';
import { client } from '~/client';
import { graphql } from '~/client/graphql';

import { loadCustomerLoanSession } from '../loan-session';

function bcBase(): string {
  const hash = process.env.BIGCOMMERCE_STORE_HASH;
  if (!hash) throw new Error('Missing BIGCOMMERCE_STORE_HASH');
  return `https://api.bigcommerce.com/stores/${hash}`;
}

function bcHeaders(): Record<string, string> {
  const token = process.env.BC_MANAGEMENT_TOKEN;
  if (!token) throw new Error('Missing BC_MANAGEMENT_TOKEN');
  return { 'X-Auth-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' };
}

interface BcAddress {
  id: number;
  first_name: string;
  last_name: string;
  company: string;
  street_1: string;
  street_2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  country_iso2: string;
  phone: string;
  address_type: 'residential' | 'commercial';
}

interface BcCustomerV2 {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
}

interface BcValidateResponse {
  customer_id: number;
}

const CART_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CheckoutLoginValidationMutation = graphql(`
  mutation CheckoutLoginValidationMutation($email: String!, $password: String!) {
    login(email: $email, password: $password) {
      customerAccessToken {
        value
      }
      customer {
        entityId
      }
    }
  }
`);

async function validateWithStorefrontLogin(
  email: string,
  password: string,
): Promise<number | null> {
  try {
    const response = await client.fetch({
      document: CheckoutLoginValidationMutation,
      variables: { email, password },
      channelId: process.env.BIGCOMMERCE_CHANNEL_ID,
      fetchOptions: {
        cache: 'no-store',
      },
    });

    if (response.errors && response.errors.length > 0) {
      return null;
    }

    const result = response.data.login;

    if (!result.customer?.entityId || !result.customerAccessToken?.value) {
      return null;
    }

    return result.customer.entityId;
  } catch {
    return null;
  }
}

async function buildSuccessResponse(
  base: string,
  headers: Record<string, string>,
  customerId: number,
  email: string,
  password: string,
  cartId?: string,
): Promise<NextResponse> {
  const profileRes = await fetch(`${base}/v2/customers/${customerId}`, { headers });
  const profile = profileRes.ok ? ((await profileRes.json()) as BcCustomerV2) : null;
  const loanSession = await loadCustomerLoanSession(customerId);
  const authCartId = cartId && CART_ID_PATTERN.test(cartId) ? cartId : undefined;

  await signIn('password', {
    email,
    password,
    cartId: authCartId,
    redirect: false,
  });

  const addrRes = await fetch(`${base}/v2/customers/${customerId}/addresses?limit=10`, { headers });
  let addresses: BcAddress[] = [];
  if (addrRes.ok) {
    const addrText = await addrRes.text();
    if (addrText && addrText.trim() !== '') {
      try {
        addresses = JSON.parse(addrText) as BcAddress[];
      } catch {
        addresses = [];
      }
    }
  }

  return NextResponse.json({
    success: true,
    customerId,
    firstName: profile?.first_name ?? '',
    lastName: profile?.last_name ?? '',
    email: profile?.email ?? email,
    phone: profile?.phone ?? '',
    authPersisted: true,
    ...loanSession,
    addresses: addresses.map((a) => ({
      id: a.id,
      firstName: a.first_name,
      lastName: a.last_name,
      company: a.company,
      address1: a.street_1,
      address2: a.street_2,
      city: a.city,
      state: a.state,
      postalCode: a.zip,
      countryCode: a.country_iso2,
      country: a.country,
      phone: a.phone,
      addressType: a.address_type,
    })),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { email?: string; password?: string; cartId?: string };
    const email = body.email?.trim().toLowerCase();
    const password = body.password;
    const cartId = body.cartId?.trim();

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }
    if (!password || password.length < 1) {
      return NextResponse.json({ error: 'Password required' }, { status: 400 });
    }

    const base = bcBase();
    const headers = bcHeaders();

    const validateRes = await fetch(`${base}/v2/customers/validate_credentials`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    });

    if (validateRes.status === 404) {
      // Never fall back to email-only lookup. If this endpoint is unavailable,
      // validate credentials through Storefront GraphQL login instead.
      const customerId = await validateWithStorefrontLogin(email, password);

      if (!customerId) {
        return NextResponse.json({ success: false, error: 'Invalid email or password.' });
      }

      return await buildSuccessResponse(base, headers, customerId, email, password, cartId);
    }

    if (validateRes.status === 204 || !validateRes.ok) {
      return NextResponse.json({ success: false, error: 'Invalid email or password.' });
    }

    const validateData = (await validateRes.json()) as BcValidateResponse;
    if (!validateData.customer_id || validateData.customer_id === 0) {
      return NextResponse.json({ success: false, error: 'Invalid email or password.' });
    }

    return await buildSuccessResponse(
      base,
      headers,
      validateData.customer_id,
      email,
      password,
      cartId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
