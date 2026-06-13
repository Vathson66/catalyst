import type { User } from 'next-auth';
import { decode, encode } from 'next-auth/jwt';

export const checkoutCustomerCookieName = 'authjs.checkout-customer-session-token';
export const checkoutCustomerSessionMaxAge = 60 * 60 * 24 * 7;

export interface CheckoutCustomerSession {
  user?: User;
}

export function resolveCheckoutCustomerCookieName(useSecureCookies: boolean): string {
  return `${useSecureCookies ? '__Secure-' : ''}${checkoutCustomerCookieName}`;
}

export function resolveCheckoutCustomerCookieNames(): string[] {
  return [resolveCheckoutCustomerCookieName(true), resolveCheckoutCustomerCookieName(false)];
}

function resolveSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;

  if (!secret) {
    throw new Error('AUTH_SECRET is not set');
  }

  return secret;
}

export async function encodeCheckoutCustomerSession(
  user: User,
  cookieName: string,
): Promise<string> {
  return encode({
    salt: cookieName,
    secret: resolveSecret(),
    token: {
      user,
    },
    maxAge: checkoutCustomerSessionMaxAge,
  });
}

export async function decodeCheckoutCustomerSession(
  token: string,
  cookieName: string,
): Promise<CheckoutCustomerSession | null> {
  try {
    const session = await decode({
      secret: resolveSecret(),
      salt: cookieName,
      token,
    });

    if (!session || typeof session !== 'object') {
      return null;
    }

    return session;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to decode checkout customer session cookie', error);

    return null;
  }
}
