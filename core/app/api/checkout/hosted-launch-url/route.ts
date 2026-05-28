import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '~/auth';
import { generateCustomerLoginApiJwt } from '~/auth/customer-login-api';
import { signHostedCheckoutHandoffToken } from '~/lib/checkout/hosted-handoff-token';
import { signCheckoutReturnToken } from '~/lib/checkout/return-token';
import { loadCheckoutSession } from '~/lib/checkout/session';
import { bcManagementBase, bcManagementHeaders } from '~/lib/checkout/bc-api/auth';

const BC_REDIRECT_TIMEOUT_MS = 10_000;
const BC_REDIRECT_MAX_ATTEMPTS = 2;
const DEFAULT_HOSTED_PAYMENT_ONLY_MODE = true;
const DEFAULT_HOSTED_RETURN_TOKEN_PARAM = 'catalyst_order_token';
const DEFAULT_HOSTED_HANDOFF_TOKEN_PARAM = 'catalyst_handoff';
const DEFAULT_HOSTED_RETURN_SOURCE = 'hosted-checkout';

const PaymentMethodSchema = z
  .object({
    id: z.string().max(255).optional(),
    gateway: z.string().max(255).optional(),
    method: z.string().max(255).optional(),
  })
  .optional();

const HostedLaunchUrlBodySchema = z.object({
  checkoutId: z.string().optional(),
  localePrefix: z.string().max(32).optional(),
  email: z.string().optional(),
  currency: z.string().optional(),
  paymentOnly: z.boolean().optional(),
  paymentMethod: PaymentMethodSchema,
});

interface BcCustomer {
  id: number;
  email: string;
}

function isValidCheckoutId(checkoutId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(checkoutId);
}

function normalizeLocalePrefix(value?: string): string {
  const trimmed = value?.trim() ?? '';

  if (!trimmed || trimmed === '/') {
    return '';
  }

  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;

  return /^\/[A-Za-z0-9_-]+$/.test(normalized) ? normalized : '';
}

function sanitizeOptional(value?: string): string | undefined {
  const normalized = value?.trim();

  return normalized || undefined;
}

function resolveChannelId(): number {
  const raw = process.env.BIGCOMMERCE_CHANNEL_ID?.trim();

  if (!raw) {
    return 1;
  }

  const parsed = Number(raw);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestRedirectUrl(
  checkoutId: string,
  handoffToken: string,
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= BC_REDIRECT_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BC_REDIRECT_TIMEOUT_MS);

    try {
      // Generate a fresh redirect URL with the handoff token carried directly by BC.
      // This keeps the hosted loader aligned with the current cart/session context.
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(
        `${bcManagementBase()}/carts/${encodeURIComponent(checkoutId)}/redirect_urls`,
        {
          method: 'POST',
          headers: bcManagementHeaders(),
          body: JSON.stringify({
            query_params: {
              [resolveHostedHandoffTokenParam()]: handoffToken,
            },
          }),
          cache: 'no-store',
          signal: controller.signal,
        },
      );

      // eslint-disable-next-line no-await-in-loop
      const payload = (await response.json().catch(() => null)) as
        | {
            data?: {
              checkout_url?: string;
              embedded_checkout_url?: string;
            };
          }
        | null;

      const checkoutUrl = payload?.data?.checkout_url ?? payload?.data?.embedded_checkout_url;

      if (response.ok && checkoutUrl) {
        return checkoutUrl;
      }

      const message = `Unable to fetch checkout redirect URL [${response.status}]`;
      const retryable = response.status === 429 || response.status >= 500;

      if (!retryable || attempt === BC_REDIRECT_MAX_ATTEMPTS) {
        throw new Error(message);
      }

      lastError = new Error(message);
    } catch (error) {
      const nextError =
        error instanceof Error ? error : new Error('Unable to fetch checkout redirect URL');

      if (attempt === BC_REDIRECT_MAX_ATTEMPTS) {
        throw nextError;
      }

      lastError = nextError;
    } finally {
      clearTimeout(timeout);
    }

    // eslint-disable-next-line no-await-in-loop
    await delay(200 * attempt);
  }

  throw lastError ?? new Error('Unable to fetch checkout redirect URL');
}

async function lookupCustomerByEmail(email: string): Promise<BcCustomer | null> {
  const authToken = bcManagementHeaders()['X-Auth-Token'];

  if (!authToken) {
    throw new Error('Missing BC management token');
  }

  const response = await fetch(
    `${bcManagementBase().replace(/\/v3$/, '/v2')}/customers?email=${encodeURIComponent(email)}&limit=1`,
    {
      headers: {
        'X-Auth-Token': authToken,
        Accept: 'application/json',
      },
      cache: 'no-store',
    },
  );

  if (!response.ok) {
    throw new Error(`Customer lookup failed with status ${response.status}`);
  }

  const bodyText = await response.text();

  if (!bodyText || bodyText.trim() === '') {
    return null;
  }

  const customers = JSON.parse(bodyText) as BcCustomer[];

  if (!Array.isArray(customers) || customers.length === 0 || !customers[0]?.id) {
    return null;
  }

  return customers[0];
}

function resolveHostedHandoffTokenParam(): string {
  const raw = process.env.NEXT_PUBLIC_CHECKOUT_HOSTED_HANDOFF_TOKEN_PARAM?.trim();
  const safeValue = raw?.replace(/[^a-zA-Z0-9_-]/g, '');

  return safeValue || DEFAULT_HOSTED_HANDOFF_TOKEN_PARAM;
}

function resolveHostedReturnTokenParam(): string {
  const raw = process.env.NEXT_PUBLIC_CHECKOUT_HOSTED_RETURN_TOKEN_PARAM?.trim();
  const safeValue = raw?.replace(/[^a-zA-Z0-9_-]/g, '');

  return safeValue || DEFAULT_HOSTED_RETURN_TOKEN_PARAM;
}

function resolveAbsoluteUrl(origin: string, path: string): string {
  return new URL(path, origin).toString();
}

function resolveHostedReturnUrl(
  origin: string,
  localePrefix: string,
  returnToken: string,
  email?: string,
  currency?: string,
): string {
  const fallbackPath = `${localePrefix}/checkout/order-confirmation`;
  const target = new URL(
    process.env.NEXT_PUBLIC_CHECKOUT_HOSTED_RETURN_URL?.trim() || fallbackPath,
    origin,
  );

  if (email) {
    target.searchParams.set('email', email);
  }

  if (currency) {
    target.searchParams.set('currency', currency);
  }

  target.searchParams.set(resolveHostedReturnTokenParam(), returnToken);
  target.searchParams.set('source', DEFAULT_HOSTED_RETURN_SOURCE);

  return target.toString();
}

function appendCompatibilityParams(
  checkoutUrl: string,
  handoffToken: string,
  paymentOnly: boolean,
  paymentMethod?: z.infer<typeof PaymentMethodSchema>,
): string {
  const target = new URL(checkoutUrl);

  target.searchParams.set(resolveHostedHandoffTokenParam(), handoffToken);
  target.searchParams.set('catalyst_payment_only', paymentOnly ? '1' : '0');

  if (paymentMethod?.id) {
    target.searchParams.set('catalyst_payment_method_id', paymentMethod.id);
  }

  if (paymentMethod?.gateway) {
    target.searchParams.set('catalyst_payment_gateway_id', paymentMethod.gateway);
  }

  if (paymentMethod?.method) {
    target.searchParams.set('catalyst_payment_method_type', paymentMethod.method);
  }

  return target.toString();
}

async function buildHostedLaunchUrl(
  request: z.infer<typeof HostedLaunchUrlBodySchema>,
  origin: string,
): Promise<string> {
  const checkoutId = request.checkoutId?.trim();

  if (!checkoutId) {
    throw new Error('checkoutId is required');
  }

  if (!isValidCheckoutId(checkoutId)) {
    throw new Error('checkoutId format is invalid');
  }

  const localePrefix = normalizeLocalePrefix(request.localePrefix);
  const checkoutSession = await loadCheckoutSession(checkoutId);
  const email = checkoutSession.customer.email ?? sanitizeOptional(request.email);
  const currency = sanitizeOptional(request.currency) ?? checkoutSession.currencyCode;
  const returnToken = signCheckoutReturnToken({
    checkoutId,
    email,
    currency,
  });
  const paymentOnly = request.paymentOnly ?? DEFAULT_HOSTED_PAYMENT_ONLY_MODE;
  const returnUrl = resolveHostedReturnUrl(origin, localePrefix, returnToken, email, currency);
  const checkoutUrl = resolveAbsoluteUrl(origin, `${localePrefix}/checkout`);
  const cartUrl = resolveAbsoluteUrl(origin, `${localePrefix}/cart`);
  const handoffToken = signHostedCheckoutHandoffToken({
    checkoutId,
    paymentOnly,
    returnUrl,
    checkoutUrl,
    cartUrl,
    paymentMethodId: sanitizeOptional(request.paymentMethod?.id),
    paymentGatewayId: sanitizeOptional(request.paymentMethod?.gateway),
    paymentMethodType: sanitizeOptional(request.paymentMethod?.method),
  });
  const bcCheckoutUrl = await requestRedirectUrl(checkoutId, handoffToken);
  const hostedCheckoutUrl = appendCompatibilityParams(
    bcCheckoutUrl,
    handoffToken,
    paymentOnly,
    request.paymentMethod,
  );
  const session = await auth();
  const sessionEmail = session?.user?.email?.trim().toLowerCase();

  if (!sessionEmail) {
    return hostedCheckoutUrl;
  }

  const customer = await lookupCustomerByEmail(sessionEmail);

  if (!customer) {
    throw new Error(
      'Your storefront login could not be mapped to a BigCommerce customer account for hosted checkout.',
    );
  }

  const redirectTargetUrl = new URL(hostedCheckoutUrl);
  const redirectTo = `${redirectTargetUrl.pathname}${redirectTargetUrl.search}${redirectTargetUrl.hash}`;
  const token = await generateCustomerLoginApiJwt(customer.id, resolveChannelId(), redirectTo);

  return `${redirectTargetUrl.origin}/login/token/${token}`;
}

export async function POST(request: NextRequest) {
  try {
    const parseResult = HostedLaunchUrlBodySchema.safeParse(await request.json());

    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Hosted checkout launch payload is invalid' },
        { status: 400 },
      );
    }

    const launchUrl = await buildHostedLaunchUrl(parseResult.data, request.nextUrl.origin);

    return NextResponse.json({ launchUrl });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to prepare secure hosted checkout handoff';

    console.error(`[checkout-hosted-launch-url] ${message}`);

    return NextResponse.json(
      { error: message || 'Unable to open secure hosted checkout.' },
      { status: 500 },
    );
  }
}
