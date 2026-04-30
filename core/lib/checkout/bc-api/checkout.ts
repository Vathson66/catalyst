import { bcManagementBase, bcManagementHeaders } from './auth';

export interface BcLineItem {
  id: string;
  name: string;
  sku: string;
  quantity: number;
  sale_price: number;
  extended_sale_price: number;
  variant_id?: number;
  product_id?: number;
  image_url?: string;
}

export interface BcDiscount {
  id: string;
  discounted_amount: number;
}

export interface BcCoupon {
  code: string;
  display_name: string;
  coupon_type: string;
  discounted_amount: number;
}

export interface BcCheckout {
  id: string;
  cart: {
    id: string;
    customer_id: number;
    base_amount: number;
    discount_amount: number;
    currency: { code: string };
    line_items: {
      physical_items: BcLineItem[];
      digital_items: BcLineItem[];
      gift_certificates: BcLineItem[];
      custom_items: BcLineItem[];
    };
    coupons: BcCoupon[];
    discounts: BcDiscount[];
  };
  taxes?: Array<{ name: string; amount: number }>;
  tax_total?: number;
  shipping_cost_total?: number;
  outstanding_balance: number;
  grand_total: number;
  customer?: {
    email?: string;
  };
}

export async function fetchCheckout(checkoutId: string): Promise<BcCheckout> {
  const url = `${bcManagementBase()}/checkouts/${encodeURIComponent(checkoutId)}`;

  const res = await fetch(url, {
    headers: bcManagementHeaders(),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();

    throw new Error(`BC checkout fetch failed [${res.status}]: ${text}`);
  }

  const body = (await res.json()) as { data: BcCheckout };

  return body.data;
}
