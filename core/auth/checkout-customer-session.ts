import { cookies, headers } from 'next/headers';
import type { User } from 'next-auth';

import {
  checkoutCustomerSessionMaxAge,
  decodeCheckoutCustomerSession,
  encodeCheckoutCustomerSession,
  resolveCheckoutCustomerCookieName,
} from './checkout-customer-session-token';

const shouldUseSecureCookie = async () => {
  const headersList = await headers();

  return headersList.get('x-forwarded-proto') === 'https';
};

async function resolveCookieOptions() {
  const useSecureCookies = await shouldUseSecureCookie();

  return {
    name: resolveCheckoutCustomerCookieName(useSecureCookies),
    secure: useSecureCookies,
  };
}

export async function checkoutCustomerSignIn(user: User): Promise<void> {
  const cookieJar = await cookies();
  const { name, secure } = await resolveCookieOptions();
  const token = await encodeCheckoutCustomerSession(user, name);

  cookieJar.set(name, token, {
    secure,
    sameSite: 'lax',
    maxAge: checkoutCustomerSessionMaxAge,
    httpOnly: true,
  });
}

export async function getCheckoutCustomerSession(): Promise<{ user?: User } | null> {
  const cookieJar = await cookies();
  const { name } = await resolveCookieOptions();
  const token = cookieJar.get(name);

  if (!token) {
    return null;
  }

  return decodeCheckoutCustomerSession(token.value, name);
}

export async function clearCheckoutCustomerSession(): Promise<void> {
  const cookieJar = await cookies();
  const { name, secure } = await resolveCookieOptions();

  cookieJar.delete({
    name,
    secure,
    sameSite: 'lax',
    httpOnly: true,
  });
}
