/**
 * CheckoutSdkAdapter — all live BC calls go through our own Next.js API routes
 * (server-side proxy) to avoid CORS issues when running on a different domain
 * from the BC storefront.
 *
 * When storeUrl is empty (CHECKOUT_DEV_MOCK=true) every method returns mock
 * data so the UI can be tested without live BC credentials.
 *
 * This file must only be imported in client components ('use client').
 */

import type { CheckoutSession } from './types';

export interface SdkShippingOption {
  id: string;
  description: string;
  cost: number;
  transitTime?: string;
  isRecommended?: boolean;
}

export interface SdkPaymentMethod {
  id: string;
  gateway?: string;
  method: string;
  name: string;
  kind?: 'manual' | 'card' | 'wallet' | 'online';
}

type AddressInput = {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  stateOrProvinceCode: string;
  postalCode: string;
  countryCode: string;
  phone?: string;
  email?: string;
};

interface SelectShippingResponse {
  error?: string;
  session?: CheckoutSession;
}

const MOCK_SHIPPING_OPTIONS: SdkShippingOption[] = [
  {
    id: 'ship-standard',
    description: 'Standard Shipping',
    cost: 0,
    transitTime: '5–7 business days',
    isRecommended: true,
  },
  {
    id: 'ship-express',
    description: 'Express Shipping',
    cost: 12.99,
    transitTime: '2–3 business days',
  },
  {
    id: 'ship-overnight',
    description: 'Overnight Shipping',
    cost: 24.99,
    transitTime: 'Next business day',
  },
];

const MOCK_PAYMENT_METHODS: SdkPaymentMethod[] = [
  { id: 'card', method: 'credit-card', name: 'Credit / Debit Card', kind: 'online' },
  { id: 'paypalcommerce', method: 'paypal', name: 'PayPal', gateway: 'paypalcommerce', kind: 'online' },
  { id: 'googlepay', method: 'googlepay', name: 'Google Pay', kind: 'wallet' },
  { id: 'applepay', method: 'applepay', name: 'Apple Pay', kind: 'wallet' },
  { id: 'amazonpay', method: 'amazonpay', name: 'Amazon Pay', kind: 'wallet' },
];

export class CheckoutSdkAdapter {
  private readonly checkoutId: string;
  private readonly storeUrl: string;

  // State preserved across calls
  private pendingAddress: AddressInput | null = null;
  private consignmentId: string | null = null;

  constructor(checkoutId: string, storeUrl: string) {
    this.checkoutId = checkoutId;
    this.storeUrl = storeUrl;
  }

  get isMock(): boolean {
    return !this.storeUrl;
  }

  /** No-op — live mode no longer needs the BC SDK. */
  async init(): Promise<void> {
    // nothing to do
  }

  /**
   * Stores the address locally; the actual BC consignment is created when
   * loadShippingOptions() is called (we need address + line-items together).
   */
  async updateShippingAddress(addr: AddressInput): Promise<void> {
    this.pendingAddress = addr;
    this.consignmentId = null; // reset so a new consignment is created
  }

  async loadShippingOptions(): Promise<SdkShippingOption[]> {
    if (this.isMock) return MOCK_SHIPPING_OPTIONS;

    const addr = this.pendingAddress;
    if (!addr) throw new Error('Call updateShippingAddress before loadShippingOptions');

    const res = await fetch('/api/checkout/shipping-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutId: this.checkoutId, address: addr }),
    });

    const data = (await res.json()) as {
      consignmentId?: string;
      options?: SdkShippingOption[];
      error?: string;
    };

    if (!res.ok || data.error) {
      throw new Error(data.error ?? `Shipping options failed [${res.status}]`);
    }

    this.consignmentId = data.consignmentId ?? null;
    const options = data.options ?? [];
    return options.length > 0 ? options : MOCK_SHIPPING_OPTIONS;
  }

  async selectShippingOption(optionId: string): Promise<CheckoutSession | null> {
    if (this.isMock) return null;

    const consignmentId = this.consignmentId;
    if (!consignmentId) throw new Error('No consignment — call loadShippingOptions first');

    const res = await fetch('/api/checkout/select-shipping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutId: this.checkoutId, consignmentId, optionId }),
    });

    const data: SelectShippingResponse = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error ?? `Select shipping failed [${res.status}]`);
    }

    return data.session ?? null;
  }

  async updateBillingAddress(addr: AddressInput): Promise<void> {
    if (this.isMock) return;

    const res = await fetch('/api/checkout/billing-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutId: this.checkoutId, address: addr }),
    });

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      throw new Error(data.error ?? `Billing address failed [${res.status}]`);
    }
  }

  async loadPaymentMethods(): Promise<SdkPaymentMethod[]> {
    if (this.isMock) return MOCK_PAYMENT_METHODS;

    const res = await fetch(
      `/api/checkout/payment-methods?checkoutId=${encodeURIComponent(this.checkoutId)}`,
    );
    const data = (await res.json()) as { methods?: SdkPaymentMethod[]; error?: string };

    const methods = data.methods ?? [];
    return methods.length > 0 ? methods : MOCK_PAYMENT_METHODS;
  }

  /**
   * Submits the order via our server-side route.
   */
  async submitOrder(methodId: string, gatewayId?: string): Promise<{ orderId: number }> {
    if (this.isMock) {
      await new Promise((r) => setTimeout(r, 1200));
      return { orderId: 10001 };
    }

    const res = await fetch('/api/checkout/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutId: this.checkoutId, methodId, gatewayId }),
    });

    const data = (await res.json()) as { orderId?: number; error?: string };

    if (!res.ok || !data.orderId) {
      throw new Error(data.error ?? `Order submission failed [${res.status}]`);
    }

    return { orderId: data.orderId };
  }
}
