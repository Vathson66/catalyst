'use client';

import {
  createCheckoutService,
  type CheckoutService,
  type LegacyHostedFormOptions,
  type PaymentMethod as CheckoutSdkPaymentMethod,
} from '@bigcommerce/checkout-sdk';
import { createCBAMPGSPaymentStrategy } from '@bigcommerce/checkout-sdk/integrations/cba-mpgs';
import { createCreditCardPaymentStrategy } from '@bigcommerce/checkout-sdk/integrations/credit-card';
import {
  createCyberSourcePaymentStrategy,
  createCyberSourceV2PaymentStrategy,
} from '@bigcommerce/checkout-sdk/integrations/cybersource';
import { createNoPaymentStrategy } from '@bigcommerce/checkout-sdk/integrations/no-payment';
import { createSagePayPaymentStrategy } from '@bigcommerce/checkout-sdk/integrations/sagepay';
import { useLocale } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CheckoutSdkAdapter } from '~/lib/checkout/sdk-adapter';
import type { SdkPaymentMethod, SdkShippingOption } from '~/lib/checkout/sdk-adapter';
import type { CheckoutSession } from '~/lib/checkout/types';

type Step = 'guest' | 'shipping' | 'payment';
type PaymentKey = string;

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
  const locale = useLocale();
  // next-intl uses 'as-needed' — default locale has no prefix in the URL.
  // Detect by checking if the first path segment matches the locale code.
  const firstSegment = pathname.split('/')[1];
  const localePrefix = firstSegment === locale ? `/${locale}` : '';

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

  // Shipping options
  const [shippingConfirmed, setShippingConfirmed] = useState(false);
  const [shippingOptions, setShippingOptions] = useState<SdkShippingOption[]>([]);
  const [selectedShipping, setSelectedShipping] = useState('');
  const [loadingShippingOpts, setLoadingShippingOpts] = useState(false);

  // UI state
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

  // Auto-fetch shipping options when entering the shipping step with a pre-filled address
  // (e.g. continuing as a signed-in customer who has a saved address).
  useEffect(() => {
    if (
      step === 'shipping' &&
      !shippingConfirmed &&
      !loadingShippingOpts &&
      shippingAddr.firstName &&
      shippingAddr.address1 &&
      shippingAddr.city &&
      shippingAddr.state &&
      shippingAddr.postalCode
    ) {
      void fetchShippingOptions(shippingAddr);
    }
    // Only re-run when we enter the shipping step
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

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
            <OrderSummaryCard session={session} loan={initialLoan} fmt={fmt} />
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

                // All context is already in component state — just advance the step.
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
              <p className="lookup-checking">
                <Spinner /> {shippingConfirmed ? 'Confirming your order details…' : 'Fetching shipping options…'}
              </p>
            )}

            {!loadingShippingOpts && shippingConfirmed && (shippingOptions.length === 0 || selectedShipping) && (
              <button type="submit" className="cta-btn">
                Continue to payment →
              </button>
            )}
          </section>

          <aside className="order-summary-rail">
            <OrderSummaryCard session={session} loan={initialLoan} fmt={fmt} />
          </aside>
        </form>
      </main>
    );
  }

  // ── STEP: Payment ────────────────────────────────────────────────────────

  if (step === 'payment') {
    return (
      <PaymentStep
        session={session}
        email={shippingAddr.email || guestEmail}
        name={`${shippingAddr.firstName} ${shippingAddr.lastName}`.trim()}
        city={shippingAddr.city}
        onBack={() => setStep('shipping')}
        localePrefix={localePrefix}
      />
    );
  }

  return null;
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

// ── Payment Step ─────────────────────────────────────────────────────────────

interface PaymentStepProps {
  session: CheckoutSession;
  email: string;
  name: string;
  city: string;
  onBack: () => void;
  localePrefix: string;
}

interface HostedFieldErrors {
  cardNumber: string;
  cardExpiry: string;
  cardName: string;
  cardCode: string;
}

interface HostedFieldIds {
  cardNumber: string;
  cardExpiry: string;
  cardName: string;
  cardCode: string;
}

interface ActivePaymentMethodRef {
  methodId: string;
  gatewayId?: string;
}

const EMPTY_HOSTED_FIELD_ERRORS: HostedFieldErrors = {
  cardNumber: '',
  cardExpiry: '',
  cardName: '',
  cardCode: '',
};

function PaymentStep({ session, email, name, city, onBack, localePrefix }: PaymentStepProps) {
  const router = useRouter();

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: session.currencyCode }).format(n);

  // ── State ────────────────────────────────────────────────────────────────

  const [availableMethods, setAvailableMethods] = useState<SdkPaymentMethod[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentKey>('');
  const [loadingMethods, setLoadingMethods] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sdkReady, setSdkReady] = useState(false);
  const [cardFieldsLoading, setCardFieldsLoading] = useState(false);
  const [cardFieldsReady, setCardFieldsReady] = useState(false);
  const [headlessError, setHeadlessError] = useState<string | null>(null);
  const [hostedFieldErrors, setHostedFieldErrors] =
    useState<HostedFieldErrors>(EMPTY_HOSTED_FIELD_ERRORS);

  const checkoutServiceRef = useRef<CheckoutService | null>(null);
  const sdkPaymentMethodsRef = useRef<CheckoutSdkPaymentMethod[]>([]);
  const activePaymentMethodRef = useRef<ActivePaymentMethodRef | null>(null);
  const activePaymentMethodKeyRef = useRef<string | null>(null);

  const [useLoan, setUseLoan] = useState(false);
  const [loanAmount, setLoanAmount] = useState(
    Math.min(session.loan.approvedAmount, session.grandTotal),
  );

  const maxLoan = Math.min(session.loan.approvedAmount, session.grandTotal);
  const showLoan = session.loanEnabled && session.loan.eligible;
  const dueTodayWithLoan = Math.max(session.grandTotal - loanAmount, 0);

  const hostedFieldIds = useMemo<HostedFieldIds>(() => {
    const suffix = paymentMethod.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'card';

    return {
      cardNumber: `co-card-number-${suffix}`,
      cardExpiry: `co-card-expiry-${suffix}`,
      cardName: `co-card-name-${suffix}`,
      cardCode: `co-card-code-${suffix}`,
    };
  }, [paymentMethod]);

  useEffect(() => {
    const service = createCheckoutService({ host: window.location.origin });
    checkoutServiceRef.current = service;

    let cancelled = false;

    void (async () => {
      try {
        await service.loadCheckout(session.checkoutId);
        const state = await service.loadPaymentMethods();

        if (cancelled) {
          return;
        }

        sdkPaymentMethodsRef.current = state.data.getPaymentMethods() ?? [];
        setSdkReady(true);
        setHeadlessError(null);
      } catch (err) {
        if (cancelled) {
          return;
        }

        setSdkReady(false);
        setHeadlessError(
          err instanceof Error
            ? err.message
            : 'Could not initialize secure payment service.',
        );
      }
    })();

    return () => {
      cancelled = true;

      const active = activePaymentMethodRef.current;
      if (active) {
        void service.deinitializePayment(active).catch(() => undefined);
      }
    };
  }, [session.checkoutId]);

  // ── Load payment methods from BigCommerce payment settings ────────────────

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(
          `/api/checkout/payment-methods?checkoutId=${encodeURIComponent(session.checkoutId)}`,
        );
        const data = (await res.json()) as { methods?: SdkPaymentMethod[]; error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? 'Could not load payment options.');
        }

        const methods = data.methods ?? [];
        setAvailableMethods(methods);
        if (methods.length > 0 && methods[0]) {
          setPaymentMethod(methods[0].id);
        } else {
          setError('No payment methods are configured in BigCommerce for this checkout.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load payment options.');
      } finally {
        setLoadingMethods(false);
      }
    })();
  }, [session.checkoutId]);

  const resolveSdkMethod = useCallback((method: SdkPaymentMethod) => {
    return resolveSdkMethodForSelection(method, sdkPaymentMethodsRef.current);
  }, []);

  useEffect(() => {
    const selectedMethod = availableMethods.find((m) => m.id === paymentMethod);
    const service = checkoutServiceRef.current;

    if (!selectedMethod || isManualMethod(selectedMethod)) {
      setCardFieldsLoading(false);
      setCardFieldsReady(false);
      setHeadlessError(null);
      setHostedFieldErrors(EMPTY_HOSTED_FIELD_ERRORS);
      return;
    }

    const sdkMethod = resolveSdkMethod(selectedMethod);

    if (!sdkMethod) {
      setCardFieldsLoading(false);
      setCardFieldsReady(false);
      setHeadlessError('The selected method is unavailable for headless checkout.');
      return;
    }

    const cardSelected = isCardLikeMethod(selectedMethod) || isCardSdkMethod(sdkMethod);

    if (!cardSelected) {
      setCardFieldsLoading(false);
      setCardFieldsReady(false);
      setHeadlessError(null);
      setHostedFieldErrors(EMPTY_HOSTED_FIELD_ERRORS);
      return;
    }

    if (!service || !sdkReady) {
      setCardFieldsLoading(true);
      setCardFieldsReady(false);
      return;
    }

    const nextKey = getUniqueMethodKey(sdkMethod.id, sdkMethod.gateway);

    if (activePaymentMethodKeyRef.current === nextKey) {
      setCardFieldsLoading(false);
      setCardFieldsReady(true);
      return;
    }

    let cancelled = false;
    setCardFieldsLoading(true);
    setCardFieldsReady(false);
    setHeadlessError(null);
    setHostedFieldErrors(EMPTY_HOSTED_FIELD_ERRORS);

    void (async () => {
      try {
        const active = activePaymentMethodRef.current;
        if (active) {
          await service.deinitializePayment(active);
        }

        const formOptions: LegacyHostedFormOptions = {
          fields: {
            cardNumber: {
              accessibilityLabel: 'Card number',
              containerId: hostedFieldIds.cardNumber,
            },
            cardExpiry: {
              accessibilityLabel: 'Expiry date',
              containerId: hostedFieldIds.cardExpiry,
              placeholder: 'MM / YY',
            },
            cardName: {
              accessibilityLabel: 'Name on card',
              containerId: hostedFieldIds.cardName,
            },
            cardCode: {
              accessibilityLabel: 'Security code',
              containerId: hostedFieldIds.cardCode,
            },
          },
          onValidate: ({ errors = {} }) => {
            const nextErrors: HostedFieldErrors = { ...EMPTY_HOSTED_FIELD_ERRORS };
            const indexedErrors = errors as Record<string, Array<{ type?: string }> | undefined>;

            const resolveErrorType = (fieldType: string): string => {
              const fieldErrors = indexedErrors[fieldType];
              const firstErrorType = fieldErrors?.[0]?.type;

              return mapHostedFieldError(firstErrorType);
            };

            nextErrors.cardNumber = resolveErrorType('cardNumber');
            nextErrors.cardExpiry = resolveErrorType('cardExpiry');
            nextErrors.cardName = resolveErrorType('cardName');
            nextErrors.cardCode = resolveErrorType('cardCode');

            setHostedFieldErrors(nextErrors);
          },
        };

        await service.initializePayment({
          methodId: sdkMethod.id,
          gatewayId: sdkMethod.gateway,
          integrations: [
            createNoPaymentStrategy,
            createCreditCardPaymentStrategy,
            createCyberSourcePaymentStrategy,
            createCyberSourceV2PaymentStrategy,
            createSagePayPaymentStrategy,
            createCBAMPGSPaymentStrategy,
          ],
          creditCard: { form: formOptions },
        });

        if (cancelled) {
          return;
        }

        activePaymentMethodRef.current = {
          methodId: sdkMethod.id,
          gatewayId: sdkMethod.gateway,
        };
        activePaymentMethodKeyRef.current = nextKey;
        setCardFieldsReady(true);
      } catch (err) {
        if (cancelled) {
          return;
        }

        setCardFieldsReady(false);
        setHeadlessError(
          err instanceof Error
            ? err.message
            : 'Could not initialize secure card fields for this method.',
        );
      } finally {
        if (!cancelled) {
          setCardFieldsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [availableMethods, paymentMethod, resolveSdkMethod, hostedFieldIds, sdkReady]);

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setSubmitting(true);

      try {
        const selectedMethod = availableMethods.find((m) => m.id === paymentMethod);
        if (!selectedMethod) {
          throw new Error('Please select a payment method.');
        }

        if (isManualMethod(selectedMethod)) {
          let appliedLoan = 0;
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
            appliedLoan = loanAmount;
          }

          const submitRes = await fetch('/api/checkout/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              checkoutId: session.checkoutId,
              methodId: selectedMethod.id,
              gatewayId: selectedMethod.gateway,
            }),
          });

          const submitData = (await submitRes.json()) as { orderId?: number; error?: string };
          if (!submitRes.ok || !submitData.orderId) {
            throw new Error(submitData.error ?? 'Order submission failed.');
          }

          const params = new URLSearchParams({
            orderId: String(submitData.orderId),
            total: String(session.grandTotal),
            paid: String(session.grandTotal - appliedLoan),
            loanApplied: String(appliedLoan),
            email,
            currency: session.currencyCode,
          });
          router.push(`${localePrefix}/checkout/order-confirmation?${params.toString()}`);
          return;
        }

        const service = checkoutServiceRef.current;
        if (!service || !sdkReady) {
          throw new Error('Secure payment is still initializing. Please try again.');
        }

        const sdkMethod = resolveSdkMethod(selectedMethod);
        if (!sdkMethod) {
          throw new Error('Selected method is unavailable for headless checkout.');
        }

        const cardSelected = isCardLikeMethod(selectedMethod) || isCardSdkMethod(sdkMethod);
        if (cardSelected && !cardFieldsReady) {
          throw new Error(
            cardFieldsLoading
              ? 'Secure card fields are still loading. Please wait a moment.'
              : 'Secure card fields are not ready. Please reselect your payment method.',
          );
        }

        try {
          const state = await service.submitOrder({
            payment: {
              methodId: sdkMethod.id,
              gatewayId: sdkMethod.gateway,
            },
          });

          const orderId = state.data.getOrder()?.orderId;
          if (!orderId) {
            throw new Error('Order was submitted but no order ID was returned.');
          }

          const params = new URLSearchParams({
            orderId: String(orderId),
            total: String(session.grandTotal),
            paid: String(session.grandTotal),
            loanApplied: '0',
            email,
            currency: session.currencyCode,
          });
          router.push(`${localePrefix}/checkout/order-confirmation?${params.toString()}`);
          return;
        } catch (sdkErr) {
          const redirectUrl = getProviderRedirectUrl(sdkErr);
          if (redirectUrl) {
            window.location.assign(redirectUrl);
            return;
          }

          throw sdkErr;
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Something went wrong. Please try again.',
        );
      } finally {
        setSubmitting(false);
      }
    },
    [
      paymentMethod,
      session,
      useLoan,
      loanAmount,
      availableMethods,
      cardFieldsLoading,
      cardFieldsReady,
      sdkReady,
      resolveSdkMethod,
      router,
      localePrefix,
      email,
    ],
  );

  const selectedMethod = availableMethods.find((m) => m.id === paymentMethod);
  const manualSelected = selectedMethod ? isManualMethod(selectedMethod) : false;
  const cardSelected = selectedMethod ? isCardLikeMethod(selectedMethod) : false;
  const showLoanForSelection = showLoan && manualSelected;
  const disableSubmit =
    submitting ||
    !paymentMethod ||
    (!manualSelected && cardSelected && (cardFieldsLoading || !cardFieldsReady));

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="page">
      <div className="page-header">
        <h1 className="page-title">Payment</h1>
        <p className="page-subtitle">
          <button type="button" className="link-button" onClick={onBack}>
            ← {name}, {city}
          </button>
        </p>
      </div>

      <form className="checkout-grid" onSubmit={(e) => { void handleSubmit(e); }}>
        <section className="checkout-main">

          {/* ── Financing card ──────────────────────────────────────── */}
          {showLoanForSelection && (
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
                  <strong>{fmt(session.loan.approvedAmount)}</strong> — apply it to reduce what
                  you pay by card today.
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
                  onClick={() => setUseLoan(!useLoan)}
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
                    style={{ '--loan-pct': `${(loanAmount / maxLoan) * 100}%` } as React.CSSProperties}
                    aria-label="Financing amount"
                  />
                  <div className="financing-slider-bounds">
                    <span>{fmt(0)}</span>
                    <span>{fmt(maxLoan)}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Payment method selection ───────────────────────────── */}
          <div className="card section-gap">
            <p className="section-label">
              {showLoanForSelection && useLoan
                ? `Pay remaining ${fmt(dueTodayWithLoan)} by`
                : `Pay ${fmt(session.grandTotal)} by`}
            </p>
            {loadingMethods ? (
              <p className="lookup-checking"><Spinner /> Loading payment options…</p>
            ) : (
              <div className="method-grid">
                {resolvePaymentMethods(availableMethods, showLoanForSelection && useLoan).map((methodOption) => (
                  <MethodRadio
                    key={methodOption.id}
                    checked={paymentMethod === methodOption.id}
                    onChange={() => setPaymentMethod(methodOption.id)}
                    label={methodOption.label}
                  >
                    {methodOption.icon}
                  </MethodRadio>
                ))}
              </div>
            )}
          </div>

          {/* ── Offline instructions ────────────────────────────────── */}
          {manualSelected && selectedMethod && (
            <div className="card section-gap">
              <p className="section-label">Payment instructions</p>
              <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.6 }}>
                {manualInstruction(selectedMethod.method)}
              </p>
            </div>
          )}

          {!manualSelected && selectedMethod && cardSelected && (
            <div className="card section-gap">
              <p className="section-label">Card details</p>

              {cardFieldsLoading && (
                <p className="hosted-fields-loading">
                  <Spinner /> Loading secure card fields…
                </p>
              )}

              {headlessError ? (
                <div className="hosted-fields-unavailable">{headlessError}</div>
              ) : (
                <div className="card-form">
                  <label className="form-field form-field-full">
                    <span className="field-label">Card number</span>
                    <div id={hostedFieldIds.cardNumber} className="hosted-field-container" />
                    {hostedFieldErrors.cardNumber && (
                      <span className="hosted-field-error">{hostedFieldErrors.cardNumber}</span>
                    )}
                  </label>

                  <div className="form-row form-row-cols">
                    <label className="form-field">
                      <span className="field-label">Expiry</span>
                      <div id={hostedFieldIds.cardExpiry} className="hosted-field-container" />
                      {hostedFieldErrors.cardExpiry && (
                        <span className="hosted-field-error">{hostedFieldErrors.cardExpiry}</span>
                      )}
                    </label>
                    <label className="form-field">
                      <span className="field-label">Security code</span>
                      <div id={hostedFieldIds.cardCode} className="hosted-field-container" />
                      {hostedFieldErrors.cardCode && (
                        <span className="hosted-field-error">{hostedFieldErrors.cardCode}</span>
                      )}
                    </label>
                  </div>

                  <label className="form-field form-field-full">
                    <span className="field-label">Name on card</span>
                    <div id={hostedFieldIds.cardName} className="hosted-field-container" />
                    {hostedFieldErrors.cardName && (
                      <span className="hosted-field-error">{hostedFieldErrors.cardName}</span>
                    )}
                  </label>
                </div>
              )}
            </div>
          )}

          {!manualSelected && selectedMethod && !cardSelected && (
            <div className="card section-gap">
              <p className="section-label">Secure payment processing</p>
              <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.6 }}>
                You selected <strong>{selectedMethod.name}</strong>. This method is processed from the
                same checkout flow and may open a secure provider authorization window.
              </p>
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}

          <button
            type="submit"
            className={`cta-btn${submitting ? ' cta-btn-loading' : ''}`}
            disabled={disableSubmit}
          >
            {submitting ? (
              <><Spinner /> Processing…</>
            ) : manualSelected && selectedMethod?.method === 'bank-deposit' ? (
              'Place order — pay by bank transfer'
            ) : manualSelected && selectedMethod?.method === 'cash-on-delivery' ? (
              'Place order — pay on delivery'
            ) : manualSelected && selectedMethod?.method === 'check' ? (
              'Place order — pay by check'
            ) : manualSelected ? (
              `Place order — ${fmt(showLoanForSelection && useLoan ? dueTodayWithLoan : session.grandTotal)}`
            ) : cardSelected ? (
              'Place order securely'
            ) : (
              'Continue to secure authorization'
            )}
          </button>
        </section>

        <aside className="order-summary-rail">
          <OrderSummaryCard
            session={session}
            loan={{
              appliedLoan: showLoanForSelection && useLoan ? loanAmount : 0,
              residual: showLoanForSelection && useLoan ? dueTodayWithLoan : session.grandTotal,
            }}
            fmt={fmt}
          />
        </aside>
      </form>
    </main>
  );
}

// ── Payment method helpers ────────────────────────────────────────────────────

interface PaymentMethodDisplay {
  id: string;
  key: PaymentKey;
  label: string;
  icon: React.ReactElement;
  method: string;
  kind: 'manual' | 'card' | 'wallet' | 'online';
}

const FALLBACK_METHODS: PaymentMethodDisplay[] = [
  {
    id: 'fallback.credit-card',
    key: 'fallback.credit-card',
    label: 'Credit / Debit Card',
    icon: <CardIcon />,
    method: 'credit-card',
    kind: 'card',
  },
];

function resolvePaymentMethods(
  sdkMethods: SdkPaymentMethod[],
  hasLoan: boolean,
): PaymentMethodDisplay[] {
  const mapped =
    sdkMethods.length === 0
      ? FALLBACK_METHODS
      : (sdkMethods
          .map((m) => {
            const kind = inferMethodKind(m);
            const method = m.method || 'online-payment';
            const label =
              kind === 'card'
                ? hasLoan
                  ? `${m.name || 'Credit / Debit Card'} (remaining balance)`
                  : m.name || 'Credit / Debit Card'
                : m.name || method;

            let icon: React.ReactElement;
            if (method.includes('paypal')) {
              icon = <PayPalLogo />;
            } else if (method.includes('apple')) {
              icon = <ApplePayLogo />;
            } else if (method.includes('google')) {
              icon = <GooglePayLogo />;
            } else if (method.includes('amazon')) {
              icon = <AmazonPayLogo />;
            } else if (kind === 'manual') {
              if (method === 'bank-deposit') icon = <span style={{ fontSize: 18 }}>🏦</span>;
              else if (method === 'cash-on-delivery') icon = <span style={{ fontSize: 18 }}>💵</span>;
              else if (method === 'check') icon = <span style={{ fontSize: 18 }}>📋</span>;
              else icon = <span style={{ fontSize: 18 }}>🧾</span>;
            } else if (kind === 'card') {
              icon = <CardIcon />;
            } else {
              icon = <span style={{ fontSize: 18 }}>💳</span>;
            }

            return {
              id: m.id,
              key: m.id,
              label,
              icon,
              method,
              kind,
            } satisfies PaymentMethodDisplay;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .filter((m, i, arr) => arr.findIndex((n) => n.id === m.id) === i));

  return mapped;
}

function inferMethodKind(m: SdkPaymentMethod): 'manual' | 'card' | 'wallet' | 'online' {
  if (m.kind) return m.kind;

  const method = (m.method || '').toLowerCase();
  const id = m.id.toLowerCase();

  if (
    method === 'bank-deposit' ||
    method === 'cash-on-delivery' ||
    method === 'check' ||
    id === 'bank_deposit' ||
    id === 'cash_on_delivery' ||
    id === 'check_money_order'
  ) {
    return 'manual';
  }

  if (method.includes('card') || id.includes('.card') || id === 'bigpaypay') {
    return 'card';
  }

  if (method.includes('paypal')) {
    return 'online';
  }

  if (
    method.includes('google') ||
    method.includes('apple') ||
    method.includes('amazon')
  ) {
    return 'wallet';
  }

  return 'online';
}

function isManualMethod(m: SdkPaymentMethod): boolean {
  return inferMethodKind(m) === 'manual';
}

function isCardLikeMethod(m: SdkPaymentMethod): boolean {
  const method = (m.method || '').toLowerCase();
  const id = m.id.toLowerCase();

  return (
    method.includes('credit-card') ||
    method.includes('card') ||
    id.includes('.card') ||
    id.includes('credit') ||
    id === 'bigpaypay'
  );
}

function isCardSdkMethod(m: CheckoutSdkPaymentMethod): boolean {
  const method = (m.method || '').toLowerCase();
  const id = m.id.toLowerCase();

  return method === 'credit-card' || method.includes('card') || id.includes('card');
}

function normalizeMethodToken(value?: string): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getUniqueMethodKey(methodId: string, gatewayId?: string): string {
  return `${methodId}::${gatewayId ?? ''}`;
}

function resolveSdkMethodForSelection(
  selectedMethod: SdkPaymentMethod,
  sdkMethods: CheckoutSdkPaymentMethod[],
): CheckoutSdkPaymentMethod | undefined {
  if (sdkMethods.length === 0) {
    return undefined;
  }

  const byExactIdAndGateway = sdkMethods.find(
    (m) => m.id === selectedMethod.id && m.gateway === selectedMethod.gateway,
  );

  if (byExactIdAndGateway) {
    return byExactIdAndGateway;
  }

  const byExactId = sdkMethods.find((m) => m.id === selectedMethod.id);
  if (byExactId) {
    return byExactId;
  }

  const selectedId = normalizeMethodToken(selectedMethod.id);
  const selectedGateway = normalizeMethodToken(selectedMethod.gateway);

  const byNormalized = sdkMethods.find((m) => {
    const methodId = normalizeMethodToken(m.id);
    const gatewayId = normalizeMethodToken(m.gateway);

    if (selectedGateway) {
      return methodId === selectedId && gatewayId === selectedGateway;
    }

    return methodId === selectedId;
  });

  if (byNormalized) {
    return byNormalized;
  }

  const selectedType = (selectedMethod.method || '').toLowerCase();

  if (isCardLikeMethod(selectedMethod)) {
    return sdkMethods.find((m) => isCardSdkMethod(m));
  }

  if (selectedType.includes('paypal')) {
    return sdkMethods.find((m) => (m.method || '').toLowerCase().includes('paypal'));
  }

  if (selectedType.includes('google')) {
    return sdkMethods.find((m) => (m.method || '').toLowerCase().includes('google'));
  }

  if (selectedType.includes('apple')) {
    return sdkMethods.find((m) => (m.method || '').toLowerCase().includes('apple'));
  }

  if (selectedType.includes('amazon')) {
    return sdkMethods.find((m) => (m.method || '').toLowerCase().includes('amazon'));
  }

  return sdkMethods[0];
}

function mapHostedFieldError(errorType?: string): string {
  switch (errorType) {
    case 'required':
      return 'Required field.';
    case 'invalid_card_number':
      return 'Invalid card number.';
    case 'invalid_card_expiry':
      return 'Invalid expiry date.';
    case 'invalid_card_name':
      return 'Invalid cardholder name.';
    case 'invalid_card_code':
      return 'Invalid security code.';
    default:
      return '';
  }
}

function getProviderRedirectUrl(error: unknown): string | undefined {
  const maybeError = error as {
    body?: { type?: string };
    headers?: { location?: string };
  };

  if (maybeError.body?.type === 'provider_error' && maybeError.headers?.location) {
    return maybeError.headers.location;
  }

  return undefined;
}

function manualInstruction(method: string): string {
  if (method === 'bank-deposit') {
    return 'Our bank details will be emailed to you after placing your order. Your order is processed once payment is received.';
  }
  if (method === 'cash-on-delivery') {
    return 'Pay in cash when your order is delivered. Please have the exact amount ready.';
  }
  if (method === 'check') {
    return 'Please make your check payable to the store. Mailing instructions are included in your confirmation email.';
  }
  return 'Follow the payment instructions shown after placing your order.';
}

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