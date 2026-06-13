import { NextResponse, URLPattern } from 'next/server';

import { anonymousSignIn, auth, clearAnonymousSession, getAnonymousSession } from '~/auth';
import {
  decodeCheckoutCustomerSession,
  resolveCheckoutCustomerCookieNames,
} from '~/auth/checkout-customer-session-token';

import { type ProxyFactory } from './compose-proxies';

// Path matcher for any routes that require authentication
const protectedPathPattern = new URLPattern({ pathname: `{/:locale}?/(account)/*` });

function redirectToLogin(url: string) {
  return NextResponse.redirect(new URL('/login', url), { status: 302 });
}

async function getCheckoutCustomerAccessToken(req: Parameters<Parameters<typeof auth>[0]>[0]) {
  const sessions = await Promise.all(
    resolveCheckoutCustomerCookieNames().map(async (cookieName) => {
      const token = req.cookies.get(cookieName)?.value;

      if (!token) {
        return null;
      }

      return decodeCheckoutCustomerSession(token, cookieName);
    }),
  );
  const session = sessions.find((candidate) => candidate?.user?.customerAccessToken);

  return session?.user?.customerAccessToken;
}

export const withAuth: ProxyFactory = (next) => {
  return async (request, event) => {
    return auth(async (req) => {
      const anonymousSession = await getAnonymousSession();
      const isProtectedRoute = protectedPathPattern.test(req.nextUrl.toString().toLowerCase());
      const isGetRequest = req.method === 'GET';
      const checkoutCustomerAccessToken = isProtectedRoute
        ? await getCheckoutCustomerAccessToken(req)
        : undefined;

      // Create the anonymous session if it doesn't exist
      if (!req.auth && !anonymousSession) {
        await anonymousSignIn();
      }

      // If the user is authenticated and there is an anonymous session, clear the anonymous session
      if (req.auth && anonymousSession) {
        await clearAnonymousSession();
      }

      if (!req.auth) {
        if (isProtectedRoute && isGetRequest && checkoutCustomerAccessToken) {
          return next(req, event);
        }

        if (isProtectedRoute && isGetRequest) {
          return redirectToLogin(req.url);
        }

        return next(req, event);
      }

      const { customerAccessToken } = req.auth.user ?? {};

      if (
        isProtectedRoute &&
        isGetRequest &&
        !customerAccessToken &&
        !checkoutCustomerAccessToken
      ) {
        return redirectToLogin(req.url);
      }

      // Continue the proxy chain
      return next(req, event);
    })(request, event);
  };
};
