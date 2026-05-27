import { redirect } from 'next/navigation';

import { CheckoutClient } from '~/app/[locale]/(default)/checkout/CheckoutClient';
import { defaultLocale } from '~/i18n/locales';
import { getCartId } from '~/lib/cart';
import { loadCheckoutSession } from '~/lib/checkout/session';
import './checkout.css';

interface CheckoutPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ checkoutId?: string; cartId?: string }>;
}

function buildCartPath(locale: string): string {
  return locale === defaultLocale ? '/cart' : `/${locale}/cart`;
}

export default async function CheckoutPage({ params, searchParams }: CheckoutPageProps) {
  const { locale } = await params;
  const query = await searchParams;
  // BigCommerce cart ID and checkout ID are the same value.
  // Fall back to the cart cookie when navigating directly from /cart (no query param).
  const checkoutId = query.checkoutId ?? query.cartId ?? (await getCartId()) ?? undefined;

  if (!checkoutId) {
    redirect(buildCartPath(locale));
  }

  let session;

  try {
    session = await loadCheckoutSession(checkoutId);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('[404]') || error.message.includes('[400]'))
    ) {
      redirect(buildCartPath(locale));
    }

    throw error;
  }

  const initialLoan = { appliedLoan: 0, residual: session.grandTotal };

  return (
    <div className="checkout-shell">
      <CheckoutClient session={session} initialLoan={initialLoan} />
    </div>
  );
}
