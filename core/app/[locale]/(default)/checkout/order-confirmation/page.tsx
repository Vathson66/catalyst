import { Link } from '~/components/link';
import type {
  OrderConfirmationDetails,
  OrderConfirmationLineItem,
} from '~/lib/checkout/bc-api/order';
import { loadVerifiedOrderConfirmation } from '~/lib/checkout/order-confirmation';

import '../checkout.css';

type SearchParams = Record<string, string | string[] | undefined>;

interface Props {
  searchParams: Promise<SearchParams>;
}

interface UpsellOffer {
  title: string;
  eyebrow: string;
  body: string;
  href: string;
  cta: string;
}

const DEFAULT_RETURN_TOKEN_PARAM = 'catalyst_order_token';
const TIMELINE_STEPS = [
  { label: 'Order placed', note: 'Complete', active: true },
  { label: 'Payment verified', note: 'Usually within a few minutes', active: false },
  {
    label: 'Fulfillment begins',
    note: 'Warehouse and service teams prepare the order',
    active: false,
  },
  { label: 'On its way', note: 'Tracking details arrive by email', active: false },
];

function readParam(params: SearchParams, key: string): string {
  const value = params[key];

  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function parseOrderId(value: string): number | null {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function formatMoney(currencyCode: string, value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
  }).format(value);
}

function formatDate(value?: string): string {
  if (!value) {
    return 'Today';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Today';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function formatName(address: OrderConfirmationDetails['billingAddress']): string {
  return [address.firstName, address.lastName].filter(Boolean).join(' ');
}

function formatAddress(address: OrderConfirmationDetails['billingAddress']): string[] {
  const cityStatePostal = [address.city, address.state, address.postalCode]
    .filter(Boolean)
    .join(', ');

  return [
    formatName(address),
    address.company,
    address.street1,
    address.street2,
    cityStatePostal,
    address.country,
  ].filter((value): value is string => Boolean(value));
}

function itemInitial(item: OrderConfirmationLineItem): string {
  return item.name.trim().charAt(0).toUpperCase() || 'P';
}

function buildUpsellOffers(order?: OrderConfirmationDetails): UpsellOffer[] {
  const firstItem = order?.lineItems[0];
  const searchTerm = encodeURIComponent(firstItem?.sku || firstItem?.name || 'accessories');

  return [
    {
      eyebrow: 'Complete the order',
      title: firstItem ? `Accessories for ${firstItem.name}` : 'Recommended accessories',
      body: 'Keep the momentum going with add-ons that match what you just bought.',
      href: `/search?term=${searchTerm}`,
      cta: 'Shop add-ons',
    },
    {
      eyebrow: 'Post-purchase offer',
      title: 'Save on your next order',
      body: 'Create a follow-up cart now and keep this shopper in the buying journey.',
      href: '/cart',
      cta: 'Start another cart',
    },
    {
      eyebrow: 'Service moment',
      title: 'Need setup or support?',
      body: 'Point customers toward installation, onboarding, warranty, or service programs.',
      href: '/contact-us',
      cta: 'Explore services',
    },
  ];
}

async function loadOrder(params: SearchParams): Promise<{
  order: OrderConfirmationDetails | null;
  error: string | null;
}> {
  const orderId = parseOrderId(readParam(params, 'orderId'));
  const tokenParam =
    process.env.NEXT_PUBLIC_CHECKOUT_HOSTED_RETURN_TOKEN_PARAM?.trim() ||
    DEFAULT_RETURN_TOKEN_PARAM;
  const returnToken =
    readParam(params, tokenParam) || readParam(params, DEFAULT_RETURN_TOKEN_PARAM);

  if (!orderId || !returnToken) {
    return {
      order: null,
      error: 'Order details are not available yet.',
    };
  }

  try {
    return {
      order: await loadVerifiedOrderConfirmation({ orderId, returnToken }),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to load order details.';

    console.error(`[order-confirmation] ${message}`);

    return {
      order: null,
      error: 'We received the order, but could not verify the full details for this session.',
    };
  }
}

export default async function OrderConfirmationPage({ searchParams }: Props) {
  const params = await searchParams;
  const { order, error } = await loadOrder(params);
  const orderId = order ? String(order.id) : readParam(params, 'orderId') || '-';
  const currency = (order?.currencyCode ?? readParam(params, 'currency')) || 'USD';
  const email = order?.billingAddress.email ?? readParam(params, 'email');
  const offers = buildUpsellOffers(order ?? undefined);
  const orderedAt = order ? formatDate(order.orderedAt) : formatDate();

  return (
    <div className="checkout-shell">
      <main className="page confirmation-page">
        <section className="confirmation-hero">
          <div className="confirmation-hero-copy">
            <div className="confirmation-status-pill">Order confirmed</div>
            <h1 className="confirmation-title">Thank you. Your order is in.</h1>
            <p className="confirmation-subtitle">
              {email
                ? `A receipt and order updates will be sent to ${email}.`
                : 'A receipt and order updates will be sent shortly.'}
            </p>
            <div className="confirmation-hero-actions">
              <Link className="confirmation-primary-link" href="/">
                Continue shopping
              </Link>
              <Link className="confirmation-secondary-link" href="/account/orders">
                View order history
              </Link>
            </div>
          </div>
          <div className="confirmation-hero-card">
            <span className="confirmation-card-label">Order number</span>
            <strong>#{orderId}</strong>
            <span>{orderedAt}</span>
            {order?.status ? (
              <span className="confirmation-status-text">{order.status}</span>
            ) : null}
          </div>
        </section>

        {error ? (
          <section className="confirmation-alert">
            <strong>Details are still syncing</strong>
            <span>{error} Your email receipt remains the source of truth.</span>
          </section>
        ) : null}

        <section className="confirmation-layout">
          <div className="confirmation-main">
            <section className="confirmation-panel">
              <div className="confirmation-panel-header">
                <p className="section-label">What happens next</p>
                <h2>We will keep this moving</h2>
              </div>
              <div className="confirmation-timeline">
                {TIMELINE_STEPS.map((step) => (
                  <div className="confirmation-timeline-step" key={step.label}>
                    <span
                      className={step.active ? 'timeline-dot timeline-dot-active' : 'timeline-dot'}
                    />
                    <div>
                      <strong>{step.label}</strong>
                      <span>{step.note}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {order ? (
              <section className="confirmation-panel">
                <div className="confirmation-panel-header">
                  <p className="section-label">Order recap</p>
                  <h2>
                    {order.lineItems.length} item
                    {order.lineItems.length === 1 ? '' : 's'} confirmed
                  </h2>
                </div>
                <div className="confirmation-items">
                  {order.lineItems.map((item) => (
                    <div className="confirmation-item" key={item.id}>
                      <div className="confirmation-item-thumb">{itemInitial(item)}</div>
                      <div className="confirmation-item-body">
                        <strong>{item.name}</strong>
                        {item.sku ? <span>SKU {item.sku}</span> : null}
                        {item.options.map((option) => (
                          <span key={`${item.id}-${option.label}`}>
                            {option.label}: {option.value}
                          </span>
                        ))}
                      </div>
                      <div className="confirmation-item-price">
                        <span>Qty {item.quantity}</span>
                        <strong>{formatMoney(order.currencyCode, item.total)}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="confirmation-panel confirmation-upsell-panel">
              <div className="confirmation-panel-header">
                <p className="section-label">Recommended next steps</p>
                <h2>Keep the customer engaged</h2>
              </div>
              <div className="confirmation-offers">
                {offers.map((offer) => (
                  <article className="confirmation-offer" key={offer.title}>
                    <span>{offer.eyebrow}</span>
                    <h3>{offer.title}</h3>
                    <p>{offer.body}</p>
                    <Link href={offer.href}>{offer.cta}</Link>
                  </article>
                ))}
              </div>
            </section>
          </div>

          <aside className="confirmation-sidebar">
            {order ? (
              <>
                <section className="confirmation-panel">
                  <p className="section-label">Payment summary</p>
                  <div className="confirmation-total-row">
                    <span>Subtotal</span>
                    <strong>{formatMoney(order.currencyCode, order.totals.subtotal)}</strong>
                  </div>
                  {order.totals.discount > 0 ? (
                    <div className="confirmation-total-row confirmation-savings-row">
                      <span>Discounts</span>
                      <strong>-{formatMoney(order.currencyCode, order.totals.discount)}</strong>
                    </div>
                  ) : null}
                  <div className="confirmation-total-row">
                    <span>Shipping</span>
                    <strong>{formatMoney(order.currencyCode, order.totals.shipping)}</strong>
                  </div>
                  <div className="confirmation-total-row">
                    <span>Tax</span>
                    <strong>{formatMoney(order.currencyCode, order.totals.tax)}</strong>
                  </div>
                  <div className="confirmation-total-row confirmation-grand-total">
                    <span>Total</span>
                    <strong>{formatMoney(order.currencyCode, order.totals.total)}</strong>
                  </div>
                  {order.payment.method ? (
                    <p className="confirmation-payment-note">Paid with {order.payment.method}</p>
                  ) : null}
                </section>

                <section className="confirmation-panel">
                  <p className="section-label">Ship to</p>
                  {(order.shippingDestinations[0]
                    ? formatAddress(order.shippingDestinations[0].address)
                    : formatAddress(order.billingAddress)
                  ).map((line) => (
                    <span className="confirmation-address-line" key={line}>
                      {line}
                    </span>
                  ))}
                  {order.shippingDestinations[0]?.method ? (
                    <p className="confirmation-payment-note">
                      Method: {order.shippingDestinations[0].method}
                    </p>
                  ) : null}
                </section>
              </>
            ) : (
              <section className="confirmation-panel">
                <p className="section-label">Order summary</p>
                <div className="confirmation-total-row confirmation-grand-total">
                  <span>Total</span>
                  <strong>{formatMoney(currency, Number(readParam(params, 'total')) || 0)}</strong>
                </div>
              </section>
            )}

            <section className="confirmation-panel confirmation-care-card">
              <p className="section-label">Customer care</p>
              <h2>Questions after checkout?</h2>
              <p>
                Use this space for merchant support, installation help, warranty registration, or
                high-value service follow-up.
              </p>
              <Link href="/contact-us">Contact support</Link>
            </section>
          </aside>
        </section>
      </main>
    </div>
  );
}
