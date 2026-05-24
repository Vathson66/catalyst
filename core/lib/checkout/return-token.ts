import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const TOKEN_VERSION = 1;
const DEFAULT_TOKEN_TTL_MS = 4 * 60 * 60 * 1000;

const CheckoutReturnTokenPayloadSchema = z.object({
  version: z.literal(TOKEN_VERSION),
  checkoutId: z.string(),
  email: z.string().optional(),
  currency: z.string().optional(),
  iat: z.number(),
  exp: z.number(),
  nonce: z.string(),
});

export type CheckoutReturnTokenPayload = z.infer<typeof CheckoutReturnTokenPayloadSchema>;

interface SignCheckoutReturnTokenInput {
  checkoutId: string;
  email?: string;
  currency?: string;
}

function getSecret(): string {
  const secret = process.env.CHECKOUT_RETURN_TOKEN_SECRET ?? process.env.AUTH_SECRET;

  if (!secret) {
    throw new Error('Missing CHECKOUT_RETURN_TOKEN_SECRET or AUTH_SECRET');
  }

  return secret;
}

function getTokenTtlMs(): number {
  const configured = Number(process.env.CHECKOUT_RETURN_TOKEN_TTL_MS);

  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TOKEN_TTL_MS;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', getSecret()).update(encodedPayload).digest('base64url');
}

function normalizeOptional(value?: string): string | undefined {
  const normalized = value?.trim();

  return normalized || undefined;
}

export function signCheckoutReturnToken({
  checkoutId,
  email,
  currency,
}: SignCheckoutReturnTokenInput): string {
  const now = Date.now();
  const payload: CheckoutReturnTokenPayload = {
    version: TOKEN_VERSION,
    checkoutId,
    email: normalizeOptional(email)?.toLowerCase(),
    currency: normalizeOptional(currency)?.toUpperCase(),
    iat: now,
    exp: now + getTokenTtlMs(),
    nonce: randomBytes(16).toString('base64url'),
  };
  const encodedPayload = encode(JSON.stringify(payload));

  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function verifyCheckoutReturnToken(token: string): CheckoutReturnTokenPayload {
  const [encodedPayload, signature] = token.split('.');

  if (!encodedPayload || !signature) {
    throw new Error('Checkout return token is malformed');
  }

  const expectedSignature = signPayload(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature, 'base64url');
  const actualBuffer = Buffer.from(signature, 'base64url');

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new Error('Checkout return token signature is invalid');
  }

  const payload = CheckoutReturnTokenPayloadSchema.safeParse(JSON.parse(decode(encodedPayload)));

  if (!payload.success) {
    throw new Error('Checkout return token payload is invalid');
  }

  if (Date.now() > payload.data.exp) {
    throw new Error('Checkout return token has expired');
  }

  return payload.data;
}
