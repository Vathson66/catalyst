import 'server-only';

import {
  fetchOrderConfirmationDetails,
  type OrderConfirmationDetails,
} from '~/lib/checkout/bc-api/order';
import { verifyCheckoutReturnToken } from '~/lib/checkout/return-token';

interface LoadOrderConfirmationInput {
  orderId: number;
  returnToken: string;
}

function normalize(value?: string): string {
  return value?.trim().toLowerCase() ?? '';
}

function assertTokenMatchesOrder(
  order: OrderConfirmationDetails,
  tokenCheckoutId: string,
  tokenEmail?: string,
) {
  if (order.checkoutId) {
    if (order.checkoutId !== tokenCheckoutId) {
      throw new Error('Order does not match checkout return token');
    }

    return;
  }

  const orderEmail = normalize(order.billingAddress.email);
  const expectedEmail = normalize(tokenEmail);

  if (!orderEmail || !expectedEmail || orderEmail !== expectedEmail) {
    throw new Error('Order email does not match checkout return token');
  }
}

export async function loadVerifiedOrderConfirmation({
  orderId,
  returnToken,
}: LoadOrderConfirmationInput): Promise<OrderConfirmationDetails> {
  const token = verifyCheckoutReturnToken(returnToken);
  const order = await fetchOrderConfirmationDetails(orderId);

  assertTokenMatchesOrder(order, token.checkoutId, token.email);

  return order;
}
