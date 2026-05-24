import 'server-only';

import { z } from 'zod';

import { bcManagementHeaders } from './auth';

const StringOrNumberSchema = z.union([z.string(), z.number()]);
const OptionalIdSchema = z.coerce.number().optional();
const OptionalMoneySchema = StringOrNumberSchema.optional();

const BcOrderAddressSchema = z
  .object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    company: z.string().optional(),
    street_1: z.string().optional(),
    street_2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
    country: z.string().optional(),
    country_iso2: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();

const BcOrderSchema = z
  .object({
    id: z.coerce.number(),
    cart_id: z.string().optional(),
    customer_id: OptionalIdSchema,
    date_created: z.string().optional(),
    status: z.string().optional(),
    status_id: OptionalIdSchema,
    billing_address: BcOrderAddressSchema.optional(),
    currency_code: z.string().optional(),
    subtotal_inc_tax: OptionalMoneySchema,
    subtotal_ex_tax: OptionalMoneySchema,
    discount_amount: OptionalMoneySchema,
    coupon_discount: OptionalMoneySchema,
    shipping_cost_inc_tax: OptionalMoneySchema,
    base_shipping_cost: OptionalMoneySchema,
    tax_total: OptionalMoneySchema,
    total_inc_tax: OptionalMoneySchema,
    payment_method: z.string().optional(),
    payment_provider_id: z.string().optional(),
    items_total: OptionalIdSchema,
    items_shipped: OptionalIdSchema,
  })
  .passthrough();

const BcOrderProductOptionSchema = z
  .object({
    display_name: z.string().optional(),
    display_value: z.string().optional(),
  })
  .passthrough();

const BcOrderProductSchema = z
  .object({
    id: z.coerce.number(),
    product_id: OptionalIdSchema,
    variant_id: OptionalIdSchema,
    name: z.string(),
    sku: z.string().optional(),
    quantity: z.coerce.number(),
    price_inc_tax: OptionalMoneySchema,
    price_ex_tax: OptionalMoneySchema,
    total_inc_tax: OptionalMoneySchema,
    total_ex_tax: OptionalMoneySchema,
    product_options: z.array(BcOrderProductOptionSchema).optional(),
  })
  .passthrough();

const BcOrderShippingAddressSchema = BcOrderAddressSchema.extend({
  id: z.coerce.number(),
  shipping_method: z.string().optional(),
  items_total: OptionalIdSchema,
  items_shipped: OptionalIdSchema,
  base_cost: OptionalMoneySchema,
  cost_inc_tax: OptionalMoneySchema,
}).passthrough();

type BcOrderAddress = z.infer<typeof BcOrderAddressSchema>;

export interface OrderConfirmationLineItem {
  id: string;
  productId?: number;
  variantId?: number;
  name: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
  total: number;
  options: Array<{ label: string; value: string }>;
}

export interface OrderConfirmationAddress {
  firstName?: string;
  lastName?: string;
  company?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  countryCode?: string;
  phone?: string;
  email?: string;
}

export interface OrderConfirmationShippingDestination {
  id: string;
  method?: string;
  address: OrderConfirmationAddress;
  itemsTotal?: number;
  itemsShipped?: number;
  cost?: number;
}

export interface OrderConfirmationDetails {
  id: number;
  checkoutId?: string;
  customerId?: number;
  status?: string;
  statusId?: number;
  orderedAt?: string;
  currencyCode: string;
  billingAddress: OrderConfirmationAddress;
  shippingDestinations: OrderConfirmationShippingDestination[];
  lineItems: OrderConfirmationLineItem[];
  totals: {
    subtotal: number;
    discount: number;
    shipping: number;
    tax: number;
    total: number;
  };
  payment: {
    method?: string;
    providerId?: string;
  };
  fulfillment: {
    itemsTotal?: number;
    itemsShipped?: number;
  };
}

function v2Base(): string {
  const storeHash = process.env.BIGCOMMERCE_STORE_HASH;

  if (!storeHash) {
    throw new Error('Missing required environment variable: BIGCOMMERCE_STORE_HASH');
  }

  return `https://api.bigcommerce.com/stores/${storeHash}/v2`;
}

function toNumber(value: string | number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function normalizeAddress(address: BcOrderAddress | undefined): OrderConfirmationAddress {
  return {
    firstName: address?.first_name,
    lastName: address?.last_name,
    company: address?.company,
    street1: address?.street_1,
    street2: address?.street_2,
    city: address?.city,
    state: address?.state,
    postalCode: address?.zip,
    country: address?.country,
    countryCode: address?.country_iso2,
    phone: address?.phone,
    email: address?.email,
  };
}

async function fetchBcV2<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(`${v2Base()}${path}`, {
    headers: bcManagementHeaders(),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();

    throw new Error(`BC order request failed [${res.status}]: ${text}`);
  }

  const json: unknown = await res.json();

  return schema.parse(json);
}

async function fetchBcV2Optional<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  const res = await fetch(`${v2Base()}${path}`, {
    headers: bcManagementHeaders(),
    cache: 'no-store',
  });

  if (res.status === 404) {
    return fallback;
  }

  if (!res.ok) {
    const text = await res.text();

    throw new Error(`BC order request failed [${res.status}]: ${text}`);
  }

  const json: unknown = await res.json();

  return schema.parse(json);
}

export async function fetchOrderConfirmationDetails(
  orderId: number,
): Promise<OrderConfirmationDetails> {
  const [order, products, shippingAddresses] = await Promise.all([
    fetchBcV2(`/orders/${orderId}`, BcOrderSchema),
    fetchBcV2(`/orders/${orderId}/products`, z.array(BcOrderProductSchema)),
    fetchBcV2Optional(
      `/orders/${orderId}/shipping_addresses`,
      z.array(BcOrderShippingAddressSchema),
      [],
    ),
  ]);

  return {
    id: order.id,
    checkoutId: order.cart_id,
    customerId: order.customer_id,
    status: order.status,
    statusId: order.status_id,
    orderedAt: order.date_created,
    currencyCode: order.currency_code ?? 'USD',
    billingAddress: normalizeAddress(order.billing_address),
    shippingDestinations: shippingAddresses.map((address) => ({
      id: String(address.id),
      method: address.shipping_method,
      address: normalizeAddress(address),
      itemsTotal: address.items_total,
      itemsShipped: address.items_shipped,
      cost: toNumber(address.cost_inc_tax ?? address.base_cost),
    })),
    lineItems: products.map((product) => ({
      id: String(product.id),
      productId: product.product_id,
      variantId: product.variant_id,
      name: product.name,
      sku: product.sku,
      quantity: product.quantity,
      unitPrice: toNumber(product.price_inc_tax ?? product.price_ex_tax),
      total: toNumber(product.total_inc_tax ?? product.total_ex_tax),
      options:
        product.product_options
          ?.map((option) => ({
            label: option.display_name ?? '',
            value: option.display_value ?? '',
          }))
          .filter((option) => option.label || option.value) ?? [],
    })),
    totals: {
      subtotal: toNumber(order.subtotal_inc_tax ?? order.subtotal_ex_tax),
      discount: toNumber(order.discount_amount) + toNumber(order.coupon_discount),
      shipping: toNumber(order.shipping_cost_inc_tax ?? order.base_shipping_cost),
      tax: toNumber(order.tax_total),
      total: toNumber(order.total_inc_tax),
    },
    payment: {
      method: order.payment_method,
      providerId: order.payment_provider_id,
    },
    fulfillment: {
      itemsTotal: order.items_total,
      itemsShipped: order.items_shipped,
    },
  };
}
