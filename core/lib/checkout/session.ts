import { fetchCheckout } from '~/lib/checkout/bc-api/checkout';
import { fetchLoanApproval } from '~/lib/checkout/bc-api/customer-metafields';
import type { CheckoutSession, Discount, OrderItem } from '~/lib/checkout/types';

export async function loadCheckoutSession(checkoutId: string): Promise<CheckoutSession> {
  const checkout = await fetchCheckout(checkoutId);
  const customerId = checkout.cart.customer_id;

  const loanApproval =
    customerId > 0
      ? await fetchLoanApproval(customerId)
      : { approved: false, approvedAmount: 0 };

  const allItems: OrderItem[] = [
    ...(checkout.cart.line_items?.physical_items ?? []),
    ...(checkout.cart.line_items?.digital_items ?? []),
    ...(checkout.cart.line_items?.custom_items ?? []),
  ].map((li) => ({
    id: li.id,
    name: li.name,
    sku: li.sku ?? '',
    price: li.sale_price,
    quantity: li.quantity,
    imageUrl: li.image_url,
  }));

  const discounts: Discount[] = [
    ...(checkout.cart.coupons ?? []).map((c) => ({
      type: 'coupon' as const,
      code: c.code,
      label: c.display_name ?? `Coupon: ${c.code}`,
      amount: c.discounted_amount,
    })),
    ...(checkout.cart.discounts ?? [])
      .filter((d) => d.discounted_amount > 0)
      .map((d) => ({
        type: 'promotion' as const,
        label: `Discount`,
        amount: d.discounted_amount,
      })),
  ];

  const subtotal = checkout.cart.base_amount ?? 0;
  const taxTotal = checkout.tax_total ?? (checkout.taxes ?? []).reduce((s, t) => s + t.amount, 0);
  const shipping = checkout.shipping_cost_total ?? 0;

  return {
    checkoutId: checkout.id,
    cartId: checkout.cart.id,
    customerId,
    currencyCode: checkout.cart.currency?.code ?? 'USD',
    storeUrl: process.env.BC_STOREFRONT_URL ?? '',
    items: allItems,
    subtotal,
    discounts,
    tax: taxTotal,
    shipping,
    grandTotal: checkout.grand_total,
    outstandingBalance: checkout.outstanding_balance,
    customer: {
      isLoggedIn: customerId > 0,
      email: checkout.customer?.email,
    },
    loan: {
      eligible: loanApproval.approved,
      approvedAmount: loanApproval.approvedAmount,
      selected: false,
      appliedAmount: 0,
    },
    loanEnabled: process.env.LOAN_ENABLED === 'true',
  };
}
