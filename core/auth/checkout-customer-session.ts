import { cookies, headers } from 'next/headers';
import { User } from 'next-auth';
import { decode, encode } from 'next-auth/jwt';

const checkoutCustomerCookieName = 'authjs.checkout-customer-session-token';
const checkoutCustomerSessionMaxAge = 60 * 60 * 24 * 7;

const shouldUseSecureCookie = async () => {
  const headersList = await headers();

  return headersList.get('x-forwarded-proto') === 'https';
};

async function resolveCookieOptions() {
  const useSecureCookies = await shouldUseSecureCookie();
  const cookiePrefix = useSecureCookies ? '__Secure-' : '';

  return {
    name: `${cookiePrefix}${checkoutCustomerCookieName}`,
    secure: useSecureCookies,
  };
}

function resolveSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;

  if (!secret) {
    throw new Error('AUTH_SECRET is not set');
  }

  return secret;
}

export async function checkoutCustomerSignIn(user: User): Promise<void> {
  const cookieJar = await cookies();
  const { name, secure } = await resolveCookieOptions();
  const secret = resolveSecret();
  const token = await encode({
    salt: name,
    secret,
    token: {
      user,
    },
    maxAge: checkoutCustomerSessionMaxAge,
  });

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

  try {
    return (await decode({
      secret: resolveSecret(),
      salt: name,
      token: token.value,
    })) as { user?: User } | null;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to decode checkout customer session cookie', error);

    return null;
  }
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
