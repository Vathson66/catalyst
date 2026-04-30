export interface OrderItem {
  id: string;
  name: string;
  sku: string;
  price: number;
  quantity: number;
  variantId?: string;
  imageUrl?: string;
}

export interface Discount {
  type: 'coupon' | 'promotion' | 'promo';
  code?: string;
  label: string;
  amount: number;
}

export interface CheckoutSession {
  checkoutId: string;
  cartId: string;
  customerId: number;
  currencyCode: string;
  /** BC storefront origin (e.g. https://store.mybigcommerce.com). Empty in mock mode. */
  storeUrl: string;
  items: OrderItem[];
  subtotal: number;
  discounts: Discount[];
  tax: number;
  shipping: number;
  grandTotal: number;
  outstandingBalance: number;
  customer: {
    isLoggedIn: boolean;
    email?: string;
    firstName?: string;
    lastName?: string;
  };
  loan: {
    eligible: boolean;
    approvedAmount: number;
    selected: boolean;
    appliedAmount: number;
  };
  /** Feature flag: true when the merchant has merchant-financing enabled (LOAN_ENABLED=true) */
  loanEnabled: boolean;
}

export interface UpsellCandidate {
  id: string;
  title: string;
  price: number;
  type: 'service' | 'accessory';
}
