import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const TOKEN_VERSION = 1;
const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

const HostedCheckoutHandoffTokenPayloadSchema = z.object({
  version: z.literal(TOKEN_VERSION),
  checkoutId: z.string(),
  paymentOnly: z.boolean(),
  returnUrl: z.string().url(),
  checkoutUrl: z.string().url(),
  cartUrl: z.string().url(),
  paymentMethodId: z.string().optional(),
  paymentGatewayId: z.string().optional(),
  paymentMethodType: z.string().optional(),
  iat: z.number(),
  exp: z.number(),
  nonce: z.string(),
});

export type HostedCheckoutHandoffTokenPayload = z.infer<
  typeof HostedCheckoutHandoffTokenPayloadSchema
>;

interface SignHostedCheckoutHandoffTokenInput {
  checkoutId: string;
  paymentOnly: boolean;
  returnUrl: string;
  checkoutUrl: string;
  cartUrl: string;
  paymentMethodId?: string;
  paymentGatewayId?: string;
  paymentMethodType?: string;
}

function getSecret(): string {
  const secret =
    process.env.CHECKOUT_HOSTED_HANDOFF_TOKEN_SECRET ??
    process.env.CHECKOUT_RETURN_TOKEN_SECRET ??
    process.env.AUTH_SECRET;

  if (!secret) {
    throw new Error(
      'Missing CHECKOUT_HOSTED_HANDOFF_TOKEN_SECRET, CHECKOUT_RETURN_TOKEN_SECRET, or AUTH_SECRET',
    );
  }

  return secret;
}

function getTokenTtlMs(): number {
  const configured = Number(process.env.CHECKOUT_HOSTED_HANDOFF_TOKEN_TTL_MS);

  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TOKEN_TTL_MS;
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

export function signHostedCheckoutHandoffToken({
  checkoutId,
  paymentOnly,
  returnUrl,
  checkoutUrl,
  cartUrl,
  paymentMethodId,
  paymentGatewayId,
  paymentMethodType,
}: SignHostedCheckoutHandoffTokenInput): string {
  const now = Date.now();
  const payload: HostedCheckoutHandoffTokenPayload = {
    version: TOKEN_VERSION,
    checkoutId,
    paymentOnly,
    returnUrl: returnUrl.trim(),
    checkoutUrl: checkoutUrl.trim(),
    cartUrl: cartUrl.trim(),
    paymentMethodId: normalizeOptional(paymentMethodId),
    paymentGatewayId: normalizeOptional(paymentGatewayId),
    paymentMethodType: normalizeOptional(paymentMethodType),
    iat: now,
    exp: now + getTokenTtlMs(),
    nonce: randomBytes(16).toString('base64url'),
  };
  const encodedPayload = encode(JSON.stringify(payload));

  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function verifyHostedCheckoutHandoffToken(token: string): HostedCheckoutHandoffTokenPayload {
  const [encodedPayload, signature] = token.split('.');

  if (!encodedPayload || !signature) {
    throw new Error('Hosted checkout handoff token is malformed');
  }

  const expectedSignature = signPayload(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature, 'base64url');
  const actualBuffer = Buffer.from(signature, 'base64url');

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new Error('Hosted checkout handoff token signature is invalid');
  }

  const payload = HostedCheckoutHandoffTokenPayloadSchema.safeParse(
    JSON.parse(decode(encodedPayload)),
  );

  if (!payload.success) {
    throw new Error('Hosted checkout handoff token payload is invalid');
  }

  if (Date.now() > payload.data.exp) {
    throw new Error('Hosted checkout handoff token has expired');
  }

  return payload.data;
}
