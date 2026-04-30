import { bcManagementBase, bcManagementHeaders } from '~/lib/checkout/bc-api/auth';
import type { CheckoutSession } from '~/lib/checkout/types';

// Map our internal method IDs to BC order payment_method strings and status IDs
const OFFLINE_METHODS: Record<string, { paymentMethod: string; statusId: number }> = {
  'bank_deposit':      { paymentMethod: 'Bank Deposit',    statusId: 7 }, // Awaiting Payment
  'bank-deposit':      { paymentMethod: 'Bank Deposit',    statusId: 7 },
  'cash_on_delivery':  { paymentMethod: 'Cash on Delivery', statusId: 8 }, // Awaiting Pickup
  'cash-on-delivery':  { paymentMethod: 'Cash on Delivery', statusId: 8 },
  'check_money_order': { paymentMethod: 'Check',           statusId: 7 },
  'check':             { paymentMethod: 'Check',           statusId: 7 },
};

interface BcOrderResponse {
  data?: { id?: number };
  status?: number;
  title?: string;
}

/**
 * Creates a BC order from the checkout via the Management API.
 * For offline methods (bank deposit, COD, check), updates the order status
 * to "Awaiting Payment" and sets the payment method after creation.
 */
export async function submitCheckout(
  session: CheckoutSession,
  methodId: string,
  _gatewayId?: string,
): Promise<{ ok: boolean; orderId?: number; error?: string }> {
  const base = bcManagementBase();
  const headers = bcManagementHeaders();

  try {
    const res = await fetch(`${base}/checkouts/${session.checkoutId}/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      cache: 'no-store',
    });

    const data = (await res.json()) as BcOrderResponse;

    if (!res.ok) {
      const msg = data.title ?? `BC order creation failed [${res.status}]`;
      return { ok: false, error: msg };
    }

    const orderId = data.data?.id;
    if (!orderId) {
      return { ok: false, error: 'BC did not return an order ID' };
    }

    // For offline methods, update the order to set payment method + status
    const offlineConfig = OFFLINE_METHODS[methodId.toLowerCase()];
    if (offlineConfig) {
      const v2Base = `https://api.bigcommerce.com/stores/${process.env.BIGCOMMERCE_STORE_HASH}/v2`;
      await fetch(`${v2Base}/orders/${orderId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          payment_method: offlineConfig.paymentMethod,
          status_id: offlineConfig.statusId,
        }),
        cache: 'no-store',
      });
    }

    return { ok: true, orderId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error creating order';
    return { ok: false, error: msg };
  }
}
