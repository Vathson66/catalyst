import Link from 'next/link';

import '../checkout.css';

interface Props {
  searchParams: Promise<{
    orderId?: string;
    total?: string;
    paid?: string;
    loanApplied?: string;
    email?: string;
    currency?: string;
    source?: string;
  }>;
}

export default async function OrderConfirmationPage({ searchParams }: Props) {
  const p = await searchParams;
  const orderId = p.orderId ?? '—';
  const currency = p.currency ?? 'USD';
  const total = parseFloat(p.total ?? '0');
  const paid = parseFloat(p.paid ?? '0');
  const loanApplied = parseFloat(p.loanApplied ?? '0');
  const email = p.email ?? '';
  const source = p.source ?? '';
  const hasBreakdown = total > 0 || paid > 0 || loanApplied > 0;

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);

  return (
    <div className="checkout-shell">
      <main className="page">
      <section className="card confirmation-header">
        <div className="confirmation-icon" aria-hidden="true">✓</div>
        <div className="kicker">Order confirmed</div>
        <h1 className="page-title" style={{ marginTop: 4 }}>
          Thank you — you&apos;re all set.
        </h1>
        {email ? (
          <p className="confirmation-sub">
            Order <strong>#{orderId}</strong> confirmation has been sent to{' '}
            <strong>{email}</strong>
          </p>
        ) : (
          <p className="confirmation-sub">
            Order <strong>#{orderId}</strong> is confirmed.
          </p>
        )}
      </section>

      {hasBreakdown ? (
        <section className="card" style={{ maxWidth: 600, marginTop: 16 }}>
          <p className="section-label">Payment breakdown</p>

          <div className="summary-line">
            <span>Order total</span>
            <span>{fmt(total)}</span>
          </div>

          {loanApplied > 0 && (
            <div className="summary-line summary-positive">
              <span>Merchant loan applied</span>
              <span>−{fmt(loanApplied)}</span>
            </div>
          )}

          <div className="summary-divider" />

          <div className="summary-total">
            <span>Charged to card</span>
            <span>{fmt(paid)}</span>
          </div>
        </section>
      ) : source === 'hosted-checkout' ? (
        <section className="card" style={{ maxWidth: 600, marginTop: 16 }}>
          <p className="section-label">Payment received</p>
          <p className="confirmation-sub" style={{ margin: 0 }}>
            Your secure payment was completed on hosted checkout. We will email your receipt and
            order details shortly.
          </p>
        </section>
      ) : null}

      <p style={{ marginTop: 20 }}>
        <Link href="/" className="kicker back-link">
          ← Continue shopping
        </Link>
      </p>
    </main>
    </div>
  );
}
