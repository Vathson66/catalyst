'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CheckoutSdkAdapter } from '~/lib/checkout/sdk-adapter';
import type { SdkPaymentMethod, SdkShippingOption } from '~/lib/checkout/sdk-adapter';
import type { CheckoutSession } from '~/lib/checkout/types';

type Step = 'guest' | 'shipping' | 'payment';
type PaymentMethod = 'card' | 'paypal' | 'google-pay' | 'apple-pay' | 'amazon-pay' | 'bank-deposit' | 'cash-on-delivery' | 'check';

interface SavedAddress {
  id: number;
  firstName: string;
  lastName: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  phone: string;
}

interface SignedInCustomer {
  customerId: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addresses: SavedAddress[];
}

interface LoanState {
  appliedLoan: number;
  residual: number;
}

interface Props {
  session: CheckoutSession;
  initialLoan: LoanState;
}

export function CheckoutClient({ session, initialLoan }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  // Extract locale prefix for router.push (e.g. '/en' from '/en/checkout')
  const localePrefix = `/${pathname.split('/')[1]}`;

  // Multi-step flow
  const [step, setStep] = useState<Step>('guest');

  // Guest / Sign-in
  const [guestEmail, setGuestEmail] = useState('');
  const [signInPassword, setSignInPassword] = useState('');
  const [showSignIn, setShowSignIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signedInCustomer, setSignedInCustomer] = useState<SignedInCustomer | null>(null);
  const [selectedAddressId, setSelectedAddressId] = useState<number | 'new' | null>(null);

  const [foundCustomer, setFoundCustomer] = useState<{
    customerId: number;
    firstName: string;
    lastName: string;
  } | null>(null);

  const [lookupStatus, setLookupStatus] = useState<'idle' | 'checking' | 'found' | 'not-found'>('idle');
  const [smsConsent, setSmsConsent] = useState(false);

  // Shipping address
  const [shippingAddr, setShippingAddr] = useState({
    firstName: '',
    lastName: '',
    email: guestEmail,
    phone: '',
    address1: '',
    address2: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'US',
  });

  // Billing address
  const [sameAsShipping, setSameAsShipping] = useState(true);
  const [billingAddr, setBillingAddr] = useState({ ...shippingAddr });

  // Payment & Loan
  const [useLoan, setUseLoan] = useState(false);
  const [loan, setLoan] = useState<LoanState>(initialLoan);
  const [loanAmount, setLoanAmount] = useState(Math.min(session.loan.approvedAmount, session.grandTotal));
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('card');

  // Inline card form state
  const [cardName, setCardName] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvv, setCardCvv] = useState('');

  // Shipping options
  const [shippingConfirmed, setShippingConfirmed] = useState(false);
  const [shippingOptions, setShippingOptions] = useState<SdkShippingOption[]>([]);
  const [selectedShipping, setSelectedShipping] = useState('');
  const [loadingShippingOpts, setLoadingShippingOpts] = useState(false);

  // Payment methods
  const [availableMethods, setAvailableMethods] = useState<SdkPaymentMethod[]>([]);

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SDK adapter
  const sdkRef = useRef<CheckoutSdkAdapter | null>(null);

  useEffect(() => {
    const adapter = new CheckoutSdkAdapter(session.checkoutId, session.storeUrl ?? '');
    sdkRef.current = adapter;
    void adapter.init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: session.currencyCode }).format(n);

  /** Check if email has a BC account on blur */
  const handleEmailBlur = useCallback(async () => {
    if (!guestEmail || !guestEmail.includes('@')) return;
    if (signedInCustomer) return;
    setLookupStatus('checking');
    try {
      const res = await fetch('/api/checkout/auth/customer-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: guestEmail }),
      });
      const data = (await res.json()) as {
        found: boolean;
        customerId?: number;
        firstName?: string;
        lastName?: string;
      };
      if (data.found && data.customerId) {
        setFoundCustomer({
          customerId: data.customerId,
          firstName: data.firstName ?? '',
          lastName: data.lastName ?? '',
        });
        setLookupStatus('found');
        setShowSignIn(true);
      } else {
        setFoundCustomer(null);
        setLookupStatus('not-found');
      }
    } catch {
      setLookupStatus('idle');
    }
  }, [guestEmail, signedInCustomer]);

  // ── Guest flow ──────────────────────────────────────────────────────────

  const handleContinueAsGuest = useCallback(() => {
    if (!guestEmail) {
      setError('Please enter your email address');
      return;
    }
    setShippingAddr((prev) => ({ ...prev, email: guestEmail }));
    setFoundCustomer(null);
    setSignedInCustomer(null);
    setError(null);
    setStep('shipping');
  }, [guestEmail]);

  const handleSignIn = useCallback(async () => {
    if (!guestEmail || !guestEmail.includes('@')) {
      setError('Please enter a valid email address first');
      return;
    }
    if (!showSignIn) {
      setShowSignIn(true);
      setError(null);
      return;
    }
    if (!signInPassword) {
      setError('Please enter your password');
      return;
    }

    setError(null);
    setSigningIn(true);
    try {
      const res = await fetch('/api/checkout/auth/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: guestEmail, password: signInPassword }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        customerId?: number;
        firstName?: string;
        lastName?: string;
        email?: string;
        phone?: string;
        addresses?: SavedAddress[];
        error?: string;
      };

      if (!data.success) {
        setError(data.error ?? 'Invalid email or password.');
        return;
      }

      const customer: SignedInCustomer = {
        customerId: data.customerId!,
        firstName: data.firstName ?? '',
        lastName: data.lastName ?? '',
        email: data.email ?? guestEmail,
        phone: data.phone ?? '',
        addresses: data.addresses ?? [],
      };
      setSignedInCustomer(customer);
      setFoundCustomer({
        customerId: customer.customerId,
        firstName: customer.firstName,
        lastName: customer.lastName,
      });
      setSignInPassword('');
      setShowSignIn(false);

      if (customer.addresses.length > 0) {
        const first = customer.addresses[0]!;
        setSelectedAddressId(first.id);
        setShippingAddr({
          firstName: first.firstName,
          lastName: first.lastName,
          email: customer.email,
          phone: first.phone || customer.phone,
          address1: first.address1,
          address2: first.address2,
          city: first.city,
          state: first.state,
          postalCode: first.postalCode,
          country: first.countryCode,
        });
      } else {
        setSelectedAddressId('new');
        setShippingAddr((prev) => ({
          ...prev,
          email: customer.email,
          firstName: prev.firstName || customer.firstName,
          lastName: prev.lastName || customer.lastName,
          phone: prev.phone || customer.phone,
        }));
      }
    } catch {
      setError('Could not sign in. Please try again.');
    } finally {
      setSigningIn(false);
    }
  }, [guestEmail, signInPassword, showSignIn]);

  const handleContinueAsCustomer = useCallback(() => {
    if (!signedInCustomer) return;
    setShippingAddr((prev) => ({ ...prev, email: prev.email || signedInCustomer.email }));
    setError(null);
    setStep('shipping');
  }, [signedInCustomer]);

  // ── Auto-fetch shipping options ────────────────────────────────────────
  const fetchShippingOptions = useCallback(async (addr: typeof shippingAddr) => {
    if (!addr.firstName || !addr.address1 || !addr.city || !addr.state || !addr.postalCode) return;
    setShippingConfirmed(false);
    setShippingOptions([]);
    setSelectedShipping('');
    setLoadingShippingOpts(true);
    setError(null);
    try {
      const sdk = sdkRef.current!;
      await sdk.updateShippingAddress({
        firstName: addr.firstName,
        lastName: addr.lastName,
        address1: addr.address1,
        address2: addr.address2 || undefined,
        city: addr.city,
        stateOrProvinceCode: addr.state,
        postalCode: addr.postalCode,
        countryCode: addr.country,
        phone: addr.phone || undefined,
      });
      const options = await sdk.loadShippingOptions();
      setShippingOptions(options);
      setShippingConfirmed(true);
      if (options.length > 0) {
        const best = options.find((o) => o.isRecommended) ?? options[0];
        if (best) setSelectedShipping(best.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load shipping options');
    } finally {
      setLoadingShippingOpts(false);
    }
  }, []);

  const handleSelectSavedAddress = useCallback(
    (addressId: number | 'new') => {
      setSelectedAddressId(addressId);
      setShippingConfirmed(false);
      setShippingOptions([]);
      setSelectedShipping('');

      if (addressId === 'new') {
        setShippingAddr((prev) => ({
          ...prev,
          address1: '',
          address2: '',
          city: '',
          state: '',
          postalCode: '',
        }));
        return;
      }

      const saved = signedInCustomer?.addresses.find((a) => a.id === addressId);
      if (!saved) return;

      const next = {
        firstName: saved.firstName,
        lastName: saved.lastName,
        email: shippingAddr.email,
        phone: saved.phone || shippingAddr.phone,
        address1: saved.address1,
        address2: saved.address2,
        city: saved.city,
        state: saved.state,
        postalCode: saved.postalCode,
        country: saved.countryCode,
      };
      setShippingAddr(next);
      void fetchShippingOptions(next);
    },
    [signedInCustomer, shippingAddr.email, shippingAddr.phone, fetchShippingOptions],
  );

  // ── Loan toggle ────────────────────────────────────────────────────────

  const handleLoanToggle = useCallback(
    (checked: boolean) => {
      setError(null);
      setUseLoan(checked);
      if (!checked) {
        setLoan({ appliedLoan: 0, residual: session.grandTotal });
      }
    },
    [session.grandTotal],
  );

  // ── Submit ─────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setSubmitting(true);

      try {
        if (session.loanEnabled && session.loan.eligible && useLoan) {
          const res = await fetch('/api/checkout/apply-loan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              checkoutId: session.checkoutId,
              useLoan: true,
              customAmount: loanAmount,
            }),
          });
          if (!res.ok) throw new Error('Could not apply financing. Please try again.');
          const data = (await res.json()) as { appliedLoan: number; residual: number };
          setLoan({ appliedLoan: data.appliedLoan, residual: data.residual });
        }

        if (paymentMethod === 'card') {
          if (!cardNumber.replace(/\s/g, '')) throw new Error('Please enter your card number.');
          if (!cardExpiry) throw new Error('Please enter the card expiry date.');
          if (!cardCvv) throw new Error('Please enter the security code.');
        }

        const sdkMethod = availableMethods.find((m) => mapMethodId(m) === paymentMethod);
        const methodId = sdkMethod?.id ?? paymentMethod;
        const gatewayId = sdkMethod?.gateway;

        const submitRes = await fetch('/api/checkout/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            checkoutId: session.checkoutId,
            methodId,
            gatewayId,
            ...(paymentMethod === 'card' && {
              card: { name: cardName, number: cardNumber, expiry: cardExpiry, cvv: cardCvv },
            }),
          }),
        });
        const submitData = (await submitRes.json()) as { orderId?: number; error?: string };
        if (!submitRes.ok || !submitData.orderId) {
          throw new Error(submitData.error ?? 'Order submission failed. Please try again.');
        }
        const orderId = submitData.orderId;

        const finalLoan = useLoan && session.loanEnabled && session.loan.eligible ? loanAmount : 0;
        const confirmationEmail = shippingAddr.email || signedInCustomer?.email || guestEmail;
        const params = new URLSearchParams({
          orderId: String(orderId),
          total: String(session.grandTotal),
          paid: String(session.grandTotal - finalLoan),
          loanApplied: String(finalLoan),
          email: confirmationEmail,
          currency: session.currencyCode,
        });

        router.push(`${localePrefix}/checkout/order-confirmation?${params.toString()}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong placing your order. Please try again.');
      } finally {
        setSubmitting(false);
      }
    },
    [paymentMethod, loan, session, useLoan, loanAmount, shippingAddr.email, router, localePrefix, availableMethods, cardName, cardNumber, cardExpiry, cardCvv, signedInCustomer, guestEmail],
  );

  const maxLoan = Math.min(session.loan.approvedAmount, session.grandTotal);
  const loanPct = maxLoan > 0 ? (loanAmount / maxLoan) * 100 : 0;
  const previewDue = Math.max(session.grandTotal - loanAmount, 0);
  // These are used inside deeply-nested JSX conditionals; void suppresses noUnusedLocals.
  void loanPct;
  void previewDue;

  // ── STEP: Guest ──────────────────────────────────────────────────

  if (step === 'guest') {
    return (
      <main className="page">
        <div className="page-header">
          <h1 className="page-title">Checkout</h1>
        </div>

        <div className="checkout-grid">
          <section className="checkout-main">
            <div className="card section-gap">
              <p className="section-label">Express checkout</p>

              <div className="express-row">
                <button type="button" className="express-btn express-btn-apple" aria-label="Express checkout with Apple Pay">
                  <ApplePayLogo />
                </button>
                <button type="button" className="express-btn express-btn-google" aria-label="Express checkout with Google Pay">
                  <GooglePayLogo />
                </button>
                <button type="button" className="express-btn express-btn-paypal" aria-label="Express checkout with PayPal">
                  <PayPalLogo />
                </button>
                <button type="button" className="express-btn express-btn-amazon" aria-label="Express checkout with Amazon Pay">
                  <AmazonPayLogo />
                </button>
              </div>

              <div className="divider-row">
                <span className="divider-line" />
                <span className="divider-text">or continue with details below</span>
                <span className="divider-line" />
              </div>
            </div>

            <div className="card section-gap">
              <p className="section-label">Contact</p>

              <div className="form-row">
                <label className="form-field form-field-full">
                  <span className="field-label">Email address</span>
                  <input
                    className="field-input"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={guestEmail}
                    onChange={(e) => {
                      setGuestEmail(e.target.value);
                      setFoundCustomer(null);
                      setSignedInCustomer(null);
                      setShowSignIn(false);
                      setSignInPassword('');
                      setError(null);
                      setLookupStatus('idle');
                    }}
                    onBlur={() => { void handleEmailBlur(); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleEmailBlur(); } }}
                  />
                </label>
              </div>

              {lookupStatus === 'checking' && (
                <p className="lookup-checking">Checking your account…</p>
              )}

              {error && <div className="error-banner">{error}</div>}

              {signedInCustomer ? (
                <div className="customer-welcome">
                  <span className="customer-welcome-text">
                    Signed in as <strong>{signedInCustomer.firstName} {signedInCustomer.lastName}</strong>
                    <button
                      type="button"
                      className="signin-link"
                      style={{ marginLeft: 10 }}
                      onClick={() => {
                        setSignedInCustomer(null);
                        setFoundCustomer(null);
                        setSelectedAddressId(null);
                        setShowSignIn(false);
                        setSignInPassword('');
                        setGuestEmail('');
                        setLookupStatus('idle');
                      }}
                    >
                      Sign out
                    </button>
                  </span>

                  {signedInCustomer.addresses.length > 0 && (
                    <div className="saved-address-tiles">
                      {signedInCustomer.addresses.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          role="radio"
                          aria-checked={selectedAddressId === a.id}
                          className={`address-tile${selectedAddressId === a.id ? ' address-tile-selected' : ''}`}
                          onClick={() => handleSelectSavedAddress(a.id)}
                        >
                          <span className={`method-radio-circle${selectedAddressId === a.id ? ' method-radio-circle-selected' : ''}`} />
                          <span className="address-tile-text">
                            <span className="address-tile-name">{a.firstName} {a.lastName}</span>
                            <span className="address-tile-line">{a.address1}{a.address2 ? `, ${a.address2}` : ''}</span>
                            <span className="address-tile-line">{a.city}, {a.state} {a.postalCode}</span>
                          </span>
                        </button>
                      ))}
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selectedAddressId === 'new'}
                        className={`address-tile address-tile-new${selectedAddressId === 'new' ? ' address-tile-selected' : ''}`}
                        onClick={() => handleSelectSavedAddress('new')}
                      >
                        <span className={`method-radio-circle${selectedAddressId === 'new' ? ' method-radio-circle-selected' : ''}`} />
                        <span className="address-tile-text">
                          <span className="address-tile-name">+ Ship to a different address</span>
                        </span>
                      </button>
                    </div>
                  )}

                  {selectedAddressId === 'new' && (
                    <div className="new-address-inline">
                      <div className="form-row form-row-cols">
                        <label className="form-field">
                          <span className="field-label">First name *</span>
                          <input className="field-input" type="text" autoComplete="given-name"
                            value={shippingAddr.firstName}
                            onChange={(e) => setShippingAddr((p) => ({ ...p, firstName: e.target.value }))} />
                        </label>
                        <label className="form-field">
                          <span className="field-label">Last name *</span>
                          <input className="field-input" type="text" autoComplete="family-name"
                            value={shippingAddr.lastName}
                            onChange={(e) => setShippingAddr((p) => ({ ...p, lastName: e.target.value }))} />
                        </label>
                      </div>
                      <div className="form-row">
                        <label className="form-field form-field-full">
                          <span className="field-label">Street address *</span>
                          <input className="field-input" type="text" autoComplete="address-line1" placeholder="123 Main St"
                            value={shippingAddr.address1}
                            onChange={(e) => setShippingAddr((p) => ({ ...p, address1: e.target.value }))} />
                        </label>
                      </div>
                      <div className="form-row form-row-cols">
                        <label className="form-field">
                          <span className="field-label">City *</span>
                          <input className="field-input" type="text" autoComplete="address-level2"
                            value={shippingAddr.city}
                            onChange={(e) => setShippingAddr((p) => ({ ...p, city: e.target.value }))} />
                        </label>
                        <label className="form-field">
                          <span className="field-label">State *</span>
                          <input className="field-input" type="text" autoComplete="address-level1" placeholder="CA" maxLength={2}
                            value={shippingAddr.state}
                            onChange={(e) => setShippingAddr((p) => ({ ...p, state: e.target.value }))} />
                        </label>
                      </div>
                      <div className="form-row">
                        <label className="form-field form-field-full">
                          <span className="field-label">ZIP code *</span>
                          <input className="field-input" type="text" autoComplete="postal-code" placeholder="90210"
                            value={shippingAddr.postalCode}
                            onChange={(e) => setShippingAddr((p) => ({ ...p, postalCode: e.target.value }))}
                            onBlur={() => void fetchShippingOptions(shippingAddr)} />
                        </label>
                      </div>
                    </div>
                  )}

                  <button type="button" className="cta-btn" onClick={handleContinueAsCustomer}>
                    Continue
                  </button>
                </div>
              ) : lookupStatus === 'found' && foundCustomer ? (
                <div className="account-found-banner">
                  <p className="account-found-title">
                    👋 We found your account, <strong>{foundCustomer.firstName}</strong>!
                  </p>
                  <p className="account-found-sub">
                    Sign in for faster checkout — your saved addresses will be ready to use.
                  </p>
                  <div className="form-row">
                    <label className="form-field form-field-full">
                      <span className="field-label">Password</span>
                      <input
                        className="field-input"
                        type="password"
                        autoComplete="current-password"
                        placeholder="Your password"
                        value={signInPassword}
                        onChange={(e) => setSignInPassword(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void handleSignIn(); }
                        }}
                        // eslint-disable-next-line jsx-a11y/no-autofocus
                        autoFocus
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="cta-btn"
                    onClick={() => void handleSignIn()}
                    disabled={signingIn || !signInPassword}
                  >
                    {signingIn ? 'Signing in…' : `Sign in as ${foundCustomer.firstName} →`}
                  </button>
                  <button type="button" className="cta-btn-ghost" onClick={handleContinueAsGuest}>
                    Continue as guest instead
                  </button>
                </div>
              ) : lookupStatus === 'not-found' ? (
                <>
                  <div className="account-nudge">
                    <p className="account-nudge-title">Save time on your next order</p>
                    <ul className="benefit-list">
                      <li>Skip this form on every future order</li>
                      <li>Track all your orders in one place</li>
                      <li>Get SMS shipping &amp; delivery updates</li>
                    </ul>
                    <label className="sms-consent-row">
                      <input
                        type="checkbox"
                        checked={smsConsent}
                        onChange={(e) => setSmsConsent(e.target.checked)}
                      />
                      <span>Yes — send me order &amp; shipping updates by SMS</span>
                    </label>
                  </div>
                  <button
                    type="button"
                    className="cta-btn"
                    onClick={handleContinueAsGuest}
                    disabled={!guestEmail}
                  >
                    Continue as guest
                  </button>
                  <div className="signin-row">
                    <span className="signin-hint">Have a password from a previous order?</span>
                    <button
                      type="button"
                      className="signin-link"
                      disabled={!guestEmail}
                      onClick={() => {
                        setLookupStatus('found');
                        setShowSignIn(true);
                        setFoundCustomer(null);
                      }}
                    >
                      Sign in
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {showSignIn && (
                    <div className="form-row">
                      <label className="form-field form-field-full">
                        <span className="field-label">Password</span>
                        <input
                          className="field-input"
                          type="password"
                          autoComplete="current-password"
                          placeholder="Your BC account password"
                          value={signInPassword}
                          onChange={(e) => setSignInPassword(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); void handleSignIn(); }
                          }}
                          // eslint-disable-next-line jsx-a11y/no-autofocus
                          autoFocus
                        />
                      </label>
                    </div>
                  )}
                  {guestEmail && (
                    <div className="signin-row">
                      <span className="signin-hint">Already have an account?</span>
                      <button
                        type="button"
                        className="signin-link"
                        onClick={() => void handleSignIn()}
                        disabled={signingIn || !guestEmail}
                      >
                        {signingIn ? 'Signing in…' : showSignIn ? 'Confirm sign in →' : 'Sign in'}
                      </button>
                      {showSignIn && (
                        <button
                          type="button"
                          className="signin-link"
                          style={{ color: 'var(--muted)' }}
                          onClick={() => { setShowSignIn(false); setSignInPassword(''); setError(null); }}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="cta-btn"
                    onClick={handleContinueAsGuest}
                    disabled={!guestEmail}
                  >
                    Continue
                  </button>
                </>
              )}
            </div>
          </section>

          <aside className="order-summary-rail">
            <OrderSummaryCard session={session} loan={loan} fmt={fmt} />
          </aside>
        </div>
      </main>
    );
  }

  // ── STEP: Shipping + Billing ────────────────────────────────────────────

  if (step === 'shipping') {
    return (
      <main className="page">
        <div className="page-header">
          <h1 className="page-title">Delivery &amp; billing</h1>
        </div>

        <form
          className="checkout-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              if (!shippingAddr.firstName || !shippingAddr.address1 || !shippingAddr.city || !shippingAddr.postalCode) {
                setError('Please fill in all required shipping fields');
                return;
              }
              if (!sameAsShipping && (!billingAddr.firstName || !billingAddr.address1)) {
                setError('Please fill in all required billing fields');
                return;
              }
              if (shippingOptions.length > 0 && !selectedShipping) {
                setError('Please select a shipping method');
                return;
              }

              setError(null);
              setLoadingShippingOpts(true);

              try {
                const sdk = sdkRef.current!;

                if (!shippingConfirmed) {
                  await sdk.updateShippingAddress({
                    firstName: shippingAddr.firstName,
                    lastName: shippingAddr.lastName,
                    address1: shippingAddr.address1,
                    address2: shippingAddr.address2 || undefined,
                    city: shippingAddr.city,
                    stateOrProvinceCode: shippingAddr.state,
                    postalCode: shippingAddr.postalCode,
                    countryCode: shippingAddr.country,
                    phone: shippingAddr.phone || undefined,
                  });
                  const options = await sdk.loadShippingOptions();
                  setShippingOptions(options);
                  setShippingConfirmed(true);
                  if (options.length > 0) {
                    const best = options.find((o) => o.isRecommended) ?? options[0];
                    if (best) setSelectedShipping(best.id);
                    setLoadingShippingOpts(false);
                    return;
                  }
                }

                if (selectedShipping) {
                  await sdk.selectShippingOption(selectedShipping);
                }

                const billing = sameAsShipping ? shippingAddr : billingAddr;
                await sdk.updateBillingAddress({
                  firstName: billing.firstName,
                  lastName: billing.lastName,
                  address1: billing.address1,
                  address2: billing.address2 || undefined,
                  city: billing.city,
                  stateOrProvinceCode: billing.state,
                  postalCode: billing.postalCode,
                  countryCode: billing.country,
                  phone: billing.phone || undefined,
                  email: shippingAddr.email || guestEmail,
                });

                const methods = await sdk.loadPaymentMethods();
                setAvailableMethods(methods);

                setStep('payment');
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not process shipping details. Please try again.');
              } finally {
                setLoadingShippingOpts(false);
              }
            })();
          }}
        >
          <section className="checkout-main">
            <div className="card section-gap">
              <p className="section-label">Shipping address</p>

              <div className="form-row form-row-cols">
                <label className="form-field">
                  <span className="field-label">First name *</span>
                  <input
                    className="field-input"
                    type="text"
                    value={shippingAddr.firstName}
                    onChange={(e) => {
                      setShippingAddr((prev) => ({ ...prev, firstName: e.target.value }));
                      setShippingConfirmed(false); setShippingOptions([]); setSelectedShipping('');
                    }}
                    required
                  />
                </label>
                <label className="form-field">
                  <span className="field-label">Last name *</span>
                  <input
                    className="field-input"
                    type="text"
                    value={shippingAddr.lastName}
                    onChange={(e) => {
                      setShippingAddr((prev) => ({ ...prev, lastName: e.target.value }));
                      setShippingConfirmed(false); setShippingOptions([]); setSelectedShipping('');
                    }}
                    required
                  />
                </label>
              </div>

              <div className="form-row">
                <label className="form-field form-field-full">
                  <span className="field-label">Street address *</span>
                  <input
                    className="field-input"
                    type="text"
                    placeholder="123 Main St"
                    value={shippingAddr.address1}
                    onChange={(e) => {
                      setShippingAddr((prev) => ({ ...prev, address1: e.target.value }));
                      setShippingConfirmed(false); setShippingOptions([]); setSelectedShipping('');
                    }}
                    required
                  />
                </label>
              </div>

              <div className="form-row">
                <label className="form-field form-field-full">
                  <span className="field-label">Apt, suite, etc. (optional)</span>
                  <input
                    className="field-input"
                    type="text"
                    placeholder="Suite 100"
                    value={shippingAddr.address2}
                    onChange={(e) => setShippingAddr((prev) => ({ ...prev, address2: e.target.value }))}
                  />
                </label>
              </div>

              <div className="form-row form-row-cols">
                <label className="form-field">
                  <span className="field-label">City *</span>
                  <input
                    className="field-input"
                    type="text"
                    value={shippingAddr.city}
                    onChange={(e) => {
                      setShippingAddr((prev) => ({ ...prev, city: e.target.value }));
                      setShippingConfirmed(false); setShippingOptions([]); setSelectedShipping('');
                    }}
                    required
                  />
                </label>
                <label className="form-field">
                  <span className="field-label">State *</span>
                  <input
                    className="field-input"
                    type="text"
                    placeholder="CA"
                    maxLength={2}
                    value={shippingAddr.state}
                    onChange={(e) => {
                      setShippingAddr((prev) => ({ ...prev, state: e.target.value }));
                      setShippingConfirmed(false); setShippingOptions([]); setSelectedShipping('');
                    }}
                    required
                  />
                </label>
              </div>

              <div className="form-row form-row-cols">
                <label className="form-field">
                  <span className="field-label">ZIP Code *</span>
                  <input
                    className="field-input"
                    type="text"
                    placeholder="90210"
                    value={shippingAddr.postalCode}
                    onChange={(e) => {
                      setShippingAddr((prev) => ({ ...prev, postalCode: e.target.value }));
                      setShippingConfirmed(false); setShippingOptions([]); setSelectedShipping('');
                    }}
                    onBlur={() => void fetchShippingOptions(shippingAddr)}
                    required
                  />
                </label>
                <label className="form-field">
                  <span className="field-label">Phone</span>
                  <input
                    className="field-input"
                    type="tel"
                    placeholder="(555) 000-0000"
                    value={shippingAddr.phone}
                    onChange={(e) => setShippingAddr((prev) => ({ ...prev, phone: e.target.value }))}
                  />
                </label>
              </div>
            </div>

            {shippingConfirmed && shippingOptions.length > 0 && (
              <div className="card section-gap">
                <p className="section-label">Shipping method</p>
                <div className="shipping-options-list">
                  {shippingOptions.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={selectedShipping === opt.id}
                      className={`shipping-option-item${selectedShipping === opt.id ? ' shipping-option-selected' : ''}`}
                      onClick={() => setSelectedShipping(opt.id)}
                    >
                      <div className="shipping-option-details">
                        <span className="shipping-option-name">{opt.description}</span>
                        {opt.transitTime && (
                          <span className="shipping-option-transit">{opt.transitTime}</span>
                        )}
                      </div>
                      <span className="shipping-option-cost">
                        {opt.cost === 0 ? 'Free' : fmt(opt.cost)}
                      </span>
                      <span className={`method-radio-circle${selectedShipping === opt.id ? ' method-radio-circle-selected' : ''}`} />
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="card section-gap">
              <p className="section-label">Billing address</p>

              <button
                type="button"
                role="switch"
                aria-checked={sameAsShipping}
                className="billing-same-toggle"
                onClick={() => {
                  const next = !sameAsShipping;
                  setSameAsShipping(next);
                  if (next) setBillingAddr({ ...shippingAddr });
                }}
              >
                <span className={`toggle-switch${sameAsShipping ? ' toggle-switch-on' : ''}`}>
                  <span className="toggle-thumb" />
                </span>
                <span className="billing-same-label">Same as shipping address</span>
              </button>

              {!sameAsShipping && (
                <>
                  <div className="form-row form-row-cols">
                    <label className="form-field">
                      <span className="field-label">First name *</span>
                      <input className="field-input" type="text" value={billingAddr.firstName}
                        onChange={(e) => setBillingAddr((p) => ({ ...p, firstName: e.target.value }))} required />
                    </label>
                    <label className="form-field">
                      <span className="field-label">Last name *</span>
                      <input className="field-input" type="text" value={billingAddr.lastName}
                        onChange={(e) => setBillingAddr((p) => ({ ...p, lastName: e.target.value }))} required />
                    </label>
                  </div>
                  <div className="form-row">
                    <label className="form-field form-field-full">
                      <span className="field-label">Street address *</span>
                      <input className="field-input" type="text" placeholder="123 Main St"
                        value={billingAddr.address1}
                        onChange={(e) => setBillingAddr((p) => ({ ...p, address1: e.target.value }))} required />
                    </label>
                  </div>
                  <div className="form-row form-row-cols">
                    <label className="form-field">
                      <span className="field-label">City *</span>
                      <input className="field-input" type="text" value={billingAddr.city}
                        onChange={(e) => setBillingAddr((p) => ({ ...p, city: e.target.value }))} required />
                    </label>
                    <label className="form-field">
                      <span className="field-label">State *</span>
                      <input className="field-input" type="text" placeholder="CA" maxLength={2}
                        value={billingAddr.state}
                        onChange={(e) => setBillingAddr((p) => ({ ...p, state: e.target.value }))} required />
                    </label>
                  </div>
                </>
              )}
            </div>

            {error && <div className="error-banner">{error}</div>}

            {loadingShippingOpts && (
              <p className="lookup-checking"><Spinner /> Fetching shipping options…</p>
            )}

            {!loadingShippingOpts && shippingConfirmed && (shippingOptions.length === 0 || selectedShipping) && (
              <button type="submit" className="cta-btn">
                Continue to payment →
              </button>
            )}
          </section>

          <aside className="order-summary-rail">
            <OrderSummaryCard session={session} loan={loan} fmt={fmt} />
          </aside>
        </form>
      </main>
    );
  }

  // ── STEP: Payment ──────────────────────────────────────────────────────

  if (step === 'payment') {
    const showLoan = session.loanEnabled && session.loan.eligible;
    const dueTodayWithLoan = Math.max(session.grandTotal - loanAmount, 0);
    const loanPct2 = maxLoan > 0 ? (loanAmount / maxLoan) * 100 : 0;

    return (
      <main className="page">
        <div className="page-header">
          <h1 className="page-title">Payment</h1>
          <p className="page-subtitle">
            <button type="button" className="link-button" onClick={() => setStep('shipping')}>
              ← {shippingAddr.firstName} {shippingAddr.lastName}, {shippingAddr.city}
            </button>
          </p>
        </div>

        <form className="checkout-grid" onSubmit={handleSubmit}>
          <section className="checkout-main">

            {showLoan && (
              <div className="financing-card">
                <div className="financing-header">
                  <div className="financing-badge">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <circle cx="7" cy="7" r="7" fill="#197a47" />
                      <path d="M4 7.5l2 2 4-4" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Pre-Approved
                  </div>
                  <h2 className="financing-title">Merchant Financing Available</h2>
                  <p className="financing-subtitle">
                    You&apos;re approved for up to{' '}
                    <strong>{fmt(session.loan.approvedAmount)}</strong>{' '}
                    — apply it to reduce what you pay by card today.
                  </p>
                </div>

                <div className="financing-toggle-row">
                  <div className="financing-toggle-text">
                    <div className="financing-toggle-main">Apply financing to this order</div>
                    <div className="financing-toggle-sub">Reduces the amount charged to your card today</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={useLoan}
                    className={`toggle-switch${useLoan ? ' toggle-switch-on' : ''}`}
                    onClick={() => handleLoanToggle(!useLoan)}
                    aria-label="Toggle financing"
                  >
                    <span className="toggle-thumb" />
                  </button>
                </div>

                {useLoan && (
                  <div className="financing-expanded">
                    <div className="financing-amount-header">
                      <span className="financing-amount-label">Financing amount</span>
                      <span className="financing-amount-value">{fmt(loanAmount)}</span>
                    </div>
                    <input
                      type="range"
                      className="financing-slider"
                      min={0}
                      max={maxLoan}
                      step={10}
                      value={loanAmount}
                      onChange={(e) => setLoanAmount(parseFloat(e.target.value))}
                      style={{ '--loan-pct': `${loanPct2}%` } as React.CSSProperties}
                      aria-label="Financing amount"
                    />
                    <div className="financing-slider-bounds">
                      <span>{fmt(0)}</span>
                      <span>{fmt(maxLoan)}</span>
                    </div>
                    <div className="financing-split-preview">
                      <div className="financing-split-bar-wrap">
                        <div
                          className="financing-split-bar-loan"
                          style={{ width: `${(loanAmount / session.grandTotal) * 100}%` }}
                        />
                      </div>
                      <div className="financing-split-amounts">
                        <div className="financing-split-item financing-split-left">
                          <span className="financing-split-dot financing-split-dot-green" />
                          <div>
                            <div className="financing-split-label">Loan covers</div>
                            <div className="financing-split-value financing-split-value-green">{fmt(loanAmount)}</div>
                          </div>
                        </div>
                        <div className="financing-split-item financing-split-right">
                          <span className="financing-split-dot financing-split-dot-ink" />
                          <div>
                            <div className="financing-split-label">You pay today</div>
                            <div className="financing-split-value">{fmt(dueTodayWithLoan)}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="card section-gap">
              <p className="section-label">
                {showLoan && useLoan
                  ? `Pay remaining ${fmt(dueTodayWithLoan)} by`
                  : `Pay ${fmt(session.grandTotal)} by`}
              </p>
              <div className="method-grid">
                {resolvePaymentMethods(availableMethods, showLoan && useLoan).map(({ key, label, icon }) => (
                  <MethodRadio
                    key={key}
                    checked={paymentMethod === key}
                    onChange={() => setPaymentMethod(key)}
                    label={label}
                  >
                    {icon}
                  </MethodRadio>
                ))}
              </div>
            </div>

            {(paymentMethod === 'bank-deposit' || paymentMethod === 'cash-on-delivery' || paymentMethod === 'check') && (
              <div className="card section-gap">
                <p className="section-label">Payment instructions</p>
                <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.6 }}>
                  {paymentMethod === 'bank-deposit' && 'Our bank details will be emailed to you after placing your order. Your order will be processed once payment is received.'}
                  {paymentMethod === 'cash-on-delivery' && 'Pay in cash when your order is delivered. Please have the exact amount ready.'}
                  {paymentMethod === 'check' && 'Please make your check payable to the store. Mail it to the address in your confirmation email.'}
                </p>
              </div>
            )}

            {paymentMethod === 'card' && (
              <div className="card section-gap">
                <p className="section-label">Secure card entry</p>

                <div className="form-row">
                  <label className="form-field form-field-full">
                    <span className="field-label">Name on card</span>
                    <input
                      className="field-input"
                      type="text"
                      autoComplete="cc-name"
                      placeholder="Jane Smith"
                      value={cardName}
                      onChange={(e) => setCardName(e.target.value)}
                    />
                  </label>
                </div>

                <div className="form-row">
                  <label className="form-field form-field-full">
                    <span className="field-label">Card number</span>
                    <input
                      className="field-input"
                      type="text"
                      autoComplete="cc-number"
                      inputMode="numeric"
                      placeholder="1234 5678 9012 3456"
                      maxLength={19}
                      value={cardNumber}
                      onChange={(e) => {
                        const raw = e.target.value.replace(/\D/g, '').slice(0, 16);
                        setCardNumber(raw.replace(/(\d{4})(?=\d)/g, '$1 '));
                      }}
                    />
                  </label>
                </div>

                <div className="form-row form-row-cols">
                  <label className="form-field">
                    <span className="field-label">Expiry (MM / YY)</span>
                    <input
                      className="field-input"
                      type="text"
                      autoComplete="cc-exp"
                      inputMode="numeric"
                      placeholder="MM / YY"
                      maxLength={7}
                      value={cardExpiry}
                      onChange={(e) => {
                        const raw = e.target.value.replace(/\D/g, '').slice(0, 4);
                        setCardExpiry(raw.length > 2 ? raw.slice(0, 2) + ' / ' + raw.slice(2) : raw);
                      }}
                    />
                  </label>
                  <label className="form-field">
                    <span className="field-label">Security code</span>
                    <input
                      className="field-input"
                      type="text"
                      autoComplete="cc-csc"
                      inputMode="numeric"
                      placeholder="CVV"
                      maxLength={4}
                      value={cardCvv}
                      onChange={(e) => setCardCvv(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    />
                  </label>
                </div>
              </div>
            )}

            <div className="card section-gap">
              <p className="section-label">Billing address</p>
              <button
                type="button"
                role="switch"
                aria-checked={sameAsShipping}
                className="billing-same-toggle"
                onClick={() => {
                  const next = !sameAsShipping;
                  setSameAsShipping(next);
                  if (next) setBillingAddr({ ...shippingAddr });
                }}
              >
                <span className={`toggle-switch${sameAsShipping ? ' toggle-switch-on' : ''}`}>
                  <span className="toggle-thumb" />
                </span>
                <span className="billing-same-label">Same as shipping address</span>
              </button>

              {!sameAsShipping && (
                <>
                  <div className="form-row form-row-cols">
                    <label className="form-field">
                      <span className="field-label">First name *</span>
                      <input className="field-input" type="text" value={billingAddr.firstName}
                        onChange={(e) => setBillingAddr((p) => ({ ...p, firstName: e.target.value }))} required />
                    </label>
                    <label className="form-field">
                      <span className="field-label">Last name *</span>
                      <input className="field-input" type="text" value={billingAddr.lastName}
                        onChange={(e) => setBillingAddr((p) => ({ ...p, lastName: e.target.value }))} required />
                    </label>
                  </div>
                  <div className="form-row">
                    <label className="form-field form-field-full">
                      <span className="field-label">Street address *</span>
                      <input className="field-input" type="text" placeholder="123 Main St"
                        value={billingAddr.address1}
                        onChange={(e) => setBillingAddr((p) => ({ ...p, address1: e.target.value }))} required />
                    </label>
                  </div>
                  <div className="form-row form-row-cols">
                    <label className="form-field">
                      <span className="field-label">City *</span>
                      <input className="field-input" type="text" value={billingAddr.city}
                        onChange={(e) => setBillingAddr((p) => ({ ...p, city: e.target.value }))} required />
                    </label>
                    <label className="form-field">
                      <span className="field-label">State *</span>
                      <input className="field-input" type="text" placeholder="CA" maxLength={2}
                        value={billingAddr.state}
                        onChange={(e) => setBillingAddr((p) => ({ ...p, state: e.target.value }))} required />
                    </label>
                  </div>
                </>
              )}
            </div>

            {error && <div className="error-banner">{error}</div>}

            <button
              type="submit"
              className={`cta-btn${submitting ? ' cta-btn-loading' : ''}`}
              disabled={submitting}
            >
              {submitting ? (
                <><Spinner /> Processing…</>
              ) : paymentMethod === 'paypal' ? (
                'Pay with PayPal →'
              ) : paymentMethod === 'apple-pay' ? (
                'Pay with Apple Pay →'
              ) : paymentMethod === 'google-pay' ? (
                'Pay with Google Pay →'
              ) : paymentMethod === 'amazon-pay' ? (
                'Pay with Amazon Pay →'
              ) : paymentMethod === 'bank-deposit' ? (
                'Place order — pay by bank transfer'
              ) : paymentMethod === 'cash-on-delivery' ? (
                'Place order — pay on delivery'
              ) : paymentMethod === 'check' ? (
                'Place order — pay by check'
              ) : (
                `Place order — ${fmt(useLoan && showLoan ? dueTodayWithLoan : session.grandTotal)}`
              )}
            </button>
          </section>

          <aside className="order-summary-rail">
            <OrderSummaryCard session={session} loan={loan} fmt={fmt} />
          </aside>
        </form>
      </main>
    );
  }

  return null;
}

// ── Payment method helpers ───────────────────────────────────────────────────

type PaymentKey = 'card' | 'paypal' | 'google-pay' | 'apple-pay' | 'amazon-pay' | 'bank-deposit' | 'cash-on-delivery' | 'check';

interface PaymentMethodDisplay {
  key: PaymentKey;
  label: string;
  icon: React.ReactElement;
}

function mapMethodId(m: SdkPaymentMethod): PaymentKey | null {
  const id = m.id.toLowerCase();
  const method = m.method.toLowerCase();
  if (method === 'bank-deposit' || id === 'bank_deposit') return 'bank-deposit';
  if (method === 'cash-on-delivery' || id === 'cash_on_delivery') return 'cash-on-delivery';
  if (method === 'check' || id === 'check_money_order') return 'check';
  if (method === 'credit-card' || method === 'card' || id === 'card' || id === 'bigpaypay') return 'card';
  if (id === 'paypalcommerce' || id === 'paypalcommercecredit') return 'paypal';
  if (id.includes('paypal')) return 'paypal';
  if (id.includes('google') || id.includes('googlepay')) return 'google-pay';
  if (id.includes('apple') || id.includes('applepay')) return 'apple-pay';
  if (id.includes('amazon') || id.includes('amazonpay')) return 'amazon-pay';
  return null;
}

const FALLBACK_METHODS: PaymentMethodDisplay[] = [
  { key: 'card', label: 'Credit / Debit Card', icon: <CardIcon /> },
  { key: 'paypal', label: 'PayPal', icon: <PayPalIcon /> },
  { key: 'google-pay', label: 'Google Pay', icon: <GooglePayIcon /> },
  { key: 'apple-pay', label: 'Apple Pay', icon: <ApplePayIcon /> },
  { key: 'amazon-pay', label: 'Amazon Pay', icon: <AmazonPayIcon /> },
];

const OFFLINE_ICONS: Record<string, React.ReactElement> = {
  'bank-deposit': <span style={{ fontSize: 18 }}>🏦</span>,
  'cash-on-delivery': <span style={{ fontSize: 18 }}>💵</span>,
  'check': <span style={{ fontSize: 18 }}>📋</span>,
};

function resolvePaymentMethods(
  sdkMethods: SdkPaymentMethod[],
  hasLoan: boolean,
): PaymentMethodDisplay[] {
  const mapped: PaymentMethodDisplay[] =
    sdkMethods.length === 0
      ? FALLBACK_METHODS
      : (sdkMethods
          .map((m) => {
            const key = mapMethodId(m);
            if (!key) return null;
            const label =
              key === 'card'
                ? hasLoan ? 'Credit / Debit Card (remaining balance)' : 'Credit / Debit Card'
                : m.name;
            const icon =
              key === 'card' ? <CardIcon /> :
              key === 'paypal' ? <PayPalIcon /> :
              key === 'google-pay' ? <GooglePayIcon /> :
              key === 'apple-pay' ? <ApplePayIcon /> :
              key in OFFLINE_ICONS ? OFFLINE_ICONS[key]! :
              <AmazonPayIcon />;
            return { key, label, icon } satisfies PaymentMethodDisplay;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .filter((m, i, arr) => arr.findIndex((n) => n.key === m.key) === i) as PaymentMethodDisplay[]);

  if (hasLoan) {
    return mapped.map((m) =>
      m.key === 'card' ? { ...m, label: 'Credit / Debit Card (remaining balance)' } : m,
    );
  }
  return mapped;
}

function OrderSummaryCard({
  session,
  loan,
  fmt,
}: {
  session: CheckoutSession;
  loan: LoanState;
  fmt: (n: number) => string;
}) {
  return (
    <div className="card order-summary-card">
      <p className="rail-summary-heading">Order summary</p>

      <div className="rail-items">
        {session.items.map((item) => (
          <div key={item.id} className="rail-item">
            <div className="rail-item-thumb">
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.imageUrl} alt={item.name} className="rail-item-img" />
              ) : null}
              <span className="rail-item-qty-badge">{item.quantity}</span>
            </div>
            <div className="rail-item-info">
              <div className="rail-item-name">{item.name}</div>
              <div className="rail-item-sku">{item.sku}</div>
            </div>
            <div className="rail-item-price">{fmt(item.price * item.quantity)}</div>
          </div>
        ))}
      </div>

      {session.discounts.length > 0 && (
        <div className="rail-discounts">
          {session.discounts.map((d, idx) => (
            <div key={idx} className="rail-discount-row">
              <span className="discount-chip">
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
                  <path d="M4.5.9l.9 1.8 2 .3-1.45 1.4.34 2L4.5 5.5l-1.79.9.34-2L1.6 3l2-.3z" fill="currentColor"/>
                </svg>
                {d.label}
              </span>
              <span className="rail-discount-amount">−{fmt(d.amount)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="summary-divider" />

      <div className="summary-line">
        <span>Subtotal</span>
        <span>{fmt(session.subtotal)}</span>
      </div>

      {session.discounts.map((d, idx) => (
        <div key={idx} className="summary-line summary-positive">
          <span>{d.label}</span>
          <span>−{fmt(d.amount)}</span>
        </div>
      ))}

      {session.shipping === 0 ? (
        <div className="summary-line summary-positive">
          <span>Shipping</span>
          <span>Free</span>
        </div>
      ) : (
        <div className="summary-line">
          <span>Shipping</span>
          <span>{fmt(session.shipping)}</span>
        </div>
      )}

      <div className="summary-line">
        <span>Tax</span>
        <span>{fmt(session.tax)}</span>
      </div>

      {loan.appliedLoan > 0 && (
        <div className="summary-line summary-positive">
          <span>Merchant loan</span>
          <span>−{fmt(loan.appliedLoan)}</span>
        </div>
      )}

      <div className="summary-divider" />

      <div className="summary-total">
        <span>{loan.appliedLoan > 0 ? 'Due today' : 'Total'}</span>
        <span>{fmt(loan.appliedLoan > 0 ? loan.residual : session.grandTotal)}</span>
      </div>

      {loan.appliedLoan > 0 && (
        <div className="rail-split">
          <div className="rail-split-bar">
            <div
              className="rail-split-bar-loan"
              style={{ width: `${(loan.appliedLoan / session.grandTotal) * 100}%` }}
            />
          </div>
          <div className="rail-split-legend">
            <div className="rail-split-row">
              <span className="split-dot split-dot-green" />
              <span>Loan</span>
              <span className="split-amt split-amt-green">{fmt(loan.appliedLoan)}</span>
            </div>
            <div className="rail-split-row">
              <span className="split-dot split-dot-ink" />
              <span>Card</span>
              <span className="split-amt">{fmt(loan.residual)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MethodRadio ──────────────────────────────────────────────────────────────

interface MethodRadioProps {
  checked: boolean;
  onChange: () => void;
  label: string;
  children: React.ReactNode;
}

function MethodRadio({ checked, onChange, label, children }: MethodRadioProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={`method-radio${checked ? ' method-radio-selected' : ''}`}
      onClick={onChange}
    >
      <span className="method-radio-icon">{children}</span>
      <span className="method-radio-label">{label}</span>
      <span className={`method-radio-circle${checked ? ' method-radio-circle-selected' : ''}`} />
    </button>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

function CardIcon() {
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="20" height="14" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1" y="5" width="20" height="3" fill="currentColor" opacity=".2" />
      <rect x="4" y="10" width="6" height="2" rx="1" fill="currentColor" opacity=".4" />
    </svg>
  );
}

function PayPalLogo() {
  return (
    <span className="paypal-wordmark" aria-label="PayPal" role="img">
      <span className="paypal-pay">Pay</span><span className="paypal-pal">Pal</span>
    </span>
  );
}

function ApplePayLogo() {
  return (
    <span className="apple-pay-wordmark" aria-label="Apple Pay" role="img">
      <svg width="10" height="13" viewBox="0 0 10 13" fill="none" aria-hidden="true" style={{ marginRight: 4 }}>
        <path d="M8.3 6.7c0-1.05.72-1.57.76-1.6-.42-.6-1.07-.68-1.3-.7-.56-.05-1.09.33-1.37.33s-.73-.32-1.2-.31c-.62.01-1.19.36-1.51.91-.65 1.12-.17 2.78.46 3.69.31.45.68 1.2 1.46 1.17.58-.02.81-.37 1.52-.37s.91.37 1.53.36c.63-.01 1.03-.57 1.41-1.13.45-.64.63-1.27.64-1.3-.01-.01-.94-.35-.94-1.25zm-1.1-2.48c.32-.39.53-1 .46-1.57-.44.02-1 .3-1.33.69-.29.33-.54.86-.48 1.38.49.04.99-.26 1.35-.5z" fill="currentColor"/>
      </svg>
      Pay
    </span>
  );
}

function GooglePayLogo() {
  return (
    <span className="google-pay-wordmark" aria-label="Google Pay" role="img">
      <span style={{ color: '#4285F4' }}>G</span><span style={{ color: '#EA4335' }}>o</span><span style={{ color: '#FBBC05' }}>o</span><span style={{ color: '#34A853' }}>g</span><span style={{ color: '#EA4335' }}>l</span><span style={{ color: '#4285F4' }}>e</span>
      <span style={{ color: '#5F6368', marginLeft: 3 }}>Pay</span>
    </span>
  );
}

function AmazonPayLogo() {
  return (
    <span className="amazon-pay-wordmark" aria-label="Amazon Pay" role="img">
      <span className="amazon-text">amazon</span>
      <span className="amazon-pay-text">pay</span>
    </span>
  );
}

function PayPalIcon() {
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'baseline', gap: 0, lineHeight: 1 }}>
      <span style={{ fontFamily: 'Arial Black, Arial, sans-serif', fontWeight: 900, fontSize: 11, color: '#003087' }}>Pay</span>
      <span style={{ fontFamily: 'Arial Black, Arial, sans-serif', fontWeight: 900, fontSize: 11, color: '#009cde' }}>Pal</span>
    </span>
  );
}

function ApplePayIcon() {
  return (
    <svg width="16" height="20" viewBox="0 0 16 20" fill="none" aria-hidden="true">
      <path d="M13.2 10.7c0-1.67 1.13-2.5 1.2-2.55-.66-.96-1.69-1.09-2.06-1.1-.88-.09-1.73.52-2.18.52-.45 0-1.15-.5-1.9-.49-.98.01-1.89.57-2.39 1.45-1.03 1.78-.27 4.41.73 5.86.5.71 1.08 1.51 1.85 1.48.74-.03 1.02-.47 1.92-.47.9 0 1.15.47 1.93.46.8-.01 1.3-.72 1.79-1.44.56-1.02.79-2.01.8-2.06-.01-.01-1.49-.56-1.49-1.98l.01-.22-.01.01.01-.06zM11.05 5.15c.41-.5.68-1.19.61-1.89-.59.02-1.31.39-1.73.88-.38.44-.72 1.14-.63 1.81.66.05 1.34-.33 1.75-.8z" fill="currentColor" opacity=".8"/>
    </svg>
  );
}

function GooglePayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="9.5" fill="white" stroke="#e0e0e0"/>
      <text x="6.5" y="14.5" fontFamily="sans-serif" fontSize="10" fontWeight="700" fill="#4285F4">G</text>
    </svg>
  );
}

function AmazonPayIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect width="22" height="22" rx="4" fill="#FF9900"/>
      <text x="6" y="15.5" fontFamily="Georgia, serif" fontSize="11" fontWeight="800" fill="#232F3E">a</text>
    </svg>
  );
}


