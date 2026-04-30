import { notFound } from 'next/navigation';

import { CheckoutClient } from '~/app/[locale]/(default)/checkout/CheckoutClient';
import { getCartId } from '~/lib/cart';
import { loadCheckoutSession } from '~/lib/checkout/session';
import './checkout.css';

interface CheckoutPageProps {
  searchParams: Promise<{ checkoutId?: string; cartId?: string }>;
}

export default async function CheckoutPage({ searchParams }: CheckoutPageProps) {
  const params = await searchParams;
  // BigCommerce cart ID and checkout ID are the same value.
  // Fall back to the cart cookie when navigating directly from /cart (no query param).
  const checkoutId = params.checkoutId ?? params.cartId ?? (await getCartId()) ?? undefined;

  if (!checkoutId) {
    notFound();
  }

  const session = await loadCheckoutSession(checkoutId);
  const initialLoan = { appliedLoan: 0, residual: session.grandTotal };

  return (
    <div className="checkout-shell">
      <CheckoutClient session={session} initialLoan={initialLoan} />
    </div>
  );
}
