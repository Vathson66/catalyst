'use client';

import { useLocale } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CheckoutSdkAdapter } from '~/lib/checkout/sdk-adapter';
import type { SdkPaymentMethod, SdkShippingOption } from '~/lib/checkout/sdk-adapter';
import type { CheckoutSession } from '~/lib/checkout/types';

type Step = 'guest' | 'shipping' | 'payment';
type PaymentKey = string;

interface CheckoutAddress {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

interface PersistedCheckoutDraft {
  version: 1;
  savedAt: number;
  step: Step;
  guestEmail: string;
  smsConsent: boolean;
  shippingAddr: CheckoutAddress;
  sameAsShipping: boolean;
  billingAddr: CheckoutAddress;
  selectedShipping: string;
}

const HOSTED_CHECKOUT_RETRY_DELAY_MS = 350;
const HOSTED_CHECKOUT_MAX_ATTEMPTS = 2;
const DEFAULT_HOSTED_PAYMENT_FLOW_ENABLED = true;
const DEFAULT_HOSTED_PAYMENT_ONLY_MODE = true;
const DEFAULT_HOSTED_RETURN_URL_PARAM = 'catalyst_return_url';
const DEFAULT_HOSTED_PAYMENT_ONLY_PARAM = 'catalyst_payment_only';
const DEFAULT_HOSTED_CHECKOUT_URL_PARAM = 'catalyst_checkout_url';
const DEFAULT_HOSTED_CART_URL_PARAM = 'catalyst_cart_url';
const DEFAULT_HOSTED_RETURN_TOKEN_PARAM = 'catalyst_order_token';
const DEFAULT_HOSTED_RETURN_SOURCE = 'hosted-checkout';
const HOSTED_CHECKOUT_EDIT_SOURCE = 'hosted-checkout-edit';
const CHECKOUT_DRAFT_STORAGE_KEY_PREFIX = 'co-checkout-draft-v1';
const CHECKOUT_DRAFT_STORAGE_TTL_MS = 48 * 60 * 60 * 1000;

const EMPTY_CHECKOUT_ADDRESS: CheckoutAddress = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  postalCode: '',
  country: 'US',
};

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

interface CheckoutAuthMeResponse {
  authenticated: boolean;
  customerId?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  addresses?: SavedAddress[];
}

function readStringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '') {
        return trimmed;
      }
    }
  }

  return '';
}

function readNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normaliseSavedAddress(value: unknown): SavedAddress | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const id = readNumberValue(source.id);

  if (!id || id <= 0) {
    return null;
  }

  const stateCode = readStringValue(
    source.stateCode,
    source.state_code,
    source.stateAbbreviation,
    source.state_abbreviation,
    source.stateOrProvinceCode,
    source.state_or_province_code,
  );

  const stateName = readStringValue(source.state, source.stateOrProvince, source.state_or_province);
  const countryCode = readStringValue(
    source.countryCode,
    source.country_code,
    source.countryIso2,
    source.country_iso2,
  );

  return {
    id,
    firstName: readStringValue(source.firstName, source.first_name),
    lastName: readStringValue(source.lastName, source.last_name),
    address1: readStringValue(source.address1, source.address_1, source.street_1),
    address2: readStringValue(source.address2, source.address_2, source.street_2),
    city: readStringValue(source.city),
    state: stateCode || stateName,
    postalCode: readStringValue(source.postalCode, source.postal_code, source.zip),
    countryCode: countryCode || 'US',
    phone: readStringValue(source.phone),
  };
}

function normaliseSavedAddresses(addresses: unknown): SavedAddress[] {
  if (!Array.isArray(addresses)) {
    return [];
  }

  return addresses
    .map((address) => normaliseSavedAddress(address))
    .filter((address): address is SavedAddress => address !== null);
}

function isStepValue(value: unknown): value is Step {
  return value === 'guest' || value === 'shipping' || value === 'payment';
}

function normaliseCheckoutAddress(value: unknown, fallbackEmail = ''): CheckoutAddress {
  if (!value || typeof value !== 'object') {
    return {
      ...EMPTY_CHECKOUT_ADDRESS,
      email: fallbackEmail,
    };
  }

  const source = value as Record<string, unknown>;

  return {
    firstName: readStringValue(source.firstName, source.first_name),
    lastName: readStringValue(source.lastName, source.last_name),
    email: readStringValue(source.email, source.emailAddress, fallbackEmail),
    phone: readStringValue(source.phone),
    address1: readStringValue(source.address1, source.address_1, source.street_1),
    address2: readStringValue(source.address2, source.address_2, source.street_2),
    city: readStringValue(source.city),
    state: readStringValue(
      source.state,
      source.stateCode,
      source.state_code,
      source.stateOrProvince,
      source.state_or_province,
      source.stateOrProvinceCode,
      source.state_or_province_code,
    ),
    postalCode: readStringValue(source.postalCode, source.postal_code, source.zip),
    country: readStringValue(
      source.country,
      source.countryCode,
      source.country_code,
      source.countryIso2,
      source.country_iso2,
    ) || 'US',
  };
}

function hasRequiredShippingAddressFields(address: CheckoutAddress): boolean {
  return Boolean(
    address.firstName &&
      address.address1 &&
      address.city &&
      address.state &&
      address.postalCode,
  );
}

function hasRequiredBillingAddressFields(address: CheckoutAddress): boolean {
  return Boolean(
    address.firstName &&
      address.address1 &&
      address.city &&
      address.state &&
      address.postalCode,
  );
}

function formatDisplayName(firstName: string, lastName: string): string {
  return [firstName.trim(), lastName.trim()].filter(Boolean).join(' ');
}

function formatAddressSummary(address: CheckoutAddress): string {
  const cityState = [address.city.trim(), address.state.trim()].filter(Boolean).join(', ');

  return [
    address.address1.trim(),
    address.address2.trim(),
    cityState,
    address.postalCode.trim(),
  ]
    .filter(Boolean)
    .join(', ');
}

function formatContactSummary(name: string, email: string): string {
  const trimmedName = name.trim();
  const trimmedEmail = email.trim();

  if (trimmedName && trimmedEmail) {
    return `${trimmedName} · ${trimmedEmail}`;
  }

  return trimmedName || trimmedEmail;
}

function resolveCheckoutDraftStorageKey(checkoutId: string): string {
  return `${CHECKOUT_DRAFT_STORAGE_KEY_PREFIX}:${window.location.host}:${checkoutId}`;
}

function readPersistedCheckoutDraft(checkoutId: string): PersistedCheckoutDraft | null {
  try {
    const key = resolveCheckoutDraftStorageKey(checkoutId);
    const raw = window.localStorage.getItem(key);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedCheckoutDraft>;

    if (
      parsed.version !== 1 ||
      typeof parsed.savedAt !== 'number' ||
      !isStepValue(parsed.step)
    ) {
      window.localStorage.removeItem(key);

      return null;
    }

    if (Date.now() - parsed.savedAt > CHECKOUT_DRAFT_STORAGE_TTL_MS) {
      window.localStorage.removeItem(key);

      return null;
    }

    const guestEmail = readStringValue(parsed.guestEmail);

    return {
      version: 1,
      savedAt: parsed.savedAt,
      step: parsed.step,
      guestEmail,
      smsConsent: Boolean(parsed.smsConsent),
      shippingAddr: normaliseCheckoutAddress(parsed.shippingAddr, guestEmail),
      sameAsShipping: parsed.sameAsShipping ?? true,
      billingAddr: normaliseCheckoutAddress(parsed.billingAddr, guestEmail),
      selectedShipping: readStringValue(parsed.selectedShipping),
    };
  } catch {
    return null;
  }
}

function writePersistedCheckoutDraft(checkoutId: string, draft: PersistedCheckoutDraft): void {
  try {
    const key = resolveCheckoutDraftStorageKey(checkoutId);

    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Ignore storage failures and continue checkout without local draft support.
  }
}

function clearPersistedCheckoutDraft(checkoutId: string): void {
  try {
    const key = resolveCheckoutDraftStorageKey(checkoutId);

    window.localStorage.removeItem(key);
  } catch {
    // no-op
  }
}

function mapHostedEditTargetToStep(editTarget: string | null): Step {
  switch ((editTarget ?? '').toLowerCase()) {
    case 'customer':
      return 'guest';
    case 'payment':
      return 'payment';
    case 'shipping':
    case 'billing':
    case 'checkout':
    default:
      return 'shipping';
  }
}

interface LoanState {
  appliedLoan: number;
  residual: number;
}

interface Props {
  session: CheckoutSession;
  initialLoan: LoanState;
}

interface HostedCheckoutFlowConfig {
  enabled: boolean;
  paymentOnlyMode: boolean;
  returnUrlParam: string;
  paymentOnlyParam: string;
  checkoutUrlParam: string;
  cartUrlParam: string;
  returnTokenParam: string;
  returnUrlOverride?: string;
}

function parseBooleanValue(value: string | undefined, fallbackValue: boolean): boolean {
  if (!value) {
    return fallbackValue;
  }

  const normalised = value.trim().toLowerCase();

  if (normalised === 'true') {
    return true;
  }

  if (normalised === 'false') {
    return false;
  }

  return fallbackValue;
}

function sanitizeQueryParamName(value: string | undefined, fallbackValue: string): string {
  const safeValue = (value ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '');

  return safeValue || fallbackValue;
}

function resolveHostedCheckoutFlowConfig(): HostedCheckoutFlowConfig {
  const returnUrlOverride = process.env.NEXT_PUBLIC_CHECKOUT_HOSTED_RETURN_URL?.trim();

  return {
    enabled: parseBooleanValue(
      process.env.NEXT_PUBLIC_CHECKOUT_FORCE_HOSTED_PAYMENT_FLOW,
      DEFAULT_HOSTED_PAYMENT_FLOW_ENABLED,
    ),
    paymentOnlyMode: parseBooleanValue(
      process.env.NEXT_PUBLIC_CHECKOUT_HOSTED_PAYMENT_ONLY_MODE,
      DEFAULT_HOSTED_PAYMENT_ONLY_MODE,
    ),
    returnUrlParam: sanitizeQueryParamName(
      process.env.NEXT_PUBLIC_CHECKOUT_HOSTED_RETURN_URL_PARAM,
      DEFAULT_HOSTED_RETURN_URL_PARAM,
    ),
    paymentOnlyParam: sanitizeQueryParamName(
      process.env.NEXT_PUBLIC_CHECKOUT_HOSTED_PAYMENT_ONLY_PARAM,
      DEFAULT_HOSTED_PAYMENT_ONLY_PARAM,
    ),
    checkoutUrlParam: sanitizeQueryParamName(
      process.env.NEXT_PUBLIC_CHECKOUT_HOSTED_CHECKOUT_URL_PARAM,
      DEFAULT_HOSTED_CHECKOUT_URL_PARAM,
    ),
    cartUrlParam: sanitizeQueryParamName(
      process.env.NEXT_PUBLIC_CHECKOUT_HOSTED_CART_URL_PARAM,
      DEFAULT_HOSTED_CART_URL_PARAM,
    ),
    returnTokenParam: sanitizeQueryParamName(
      process.env.NEXT_PUBLIC_CHECKOUT_HOSTED_RETURN_TOKEN_PARAM,
      DEFAULT_HOSTED_RETURN_TOKEN_PARAM,
    ),
    returnUrlOverride: returnUrlOverride || undefined,
  };
}

const HOSTED_CHECKOUT_FLOW_CONFIG = resolveHostedCheckoutFlowConfig();

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
  const [guestEmail, setGuestEmail] = useState(session.customer.email ?? '');
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
  const [shippingAddr, setShippingAddr] = useState<CheckoutAddress>({
    ...EMPTY_CHECKOUT_ADDRESS,
    email: session.customer.email ?? '',
  });

  // Billing address
  const [sameAsShipping, setSameAsShipping] = useState(true);
  const [billingAddr, setBillingAddr] = useState<CheckoutAddress>({
    ...EMPTY_CHECKOUT_ADDRESS,
    email: session.customer.email ?? '',
  });

  // Shipping options
  const [shippingConfirmed, setShippingConfirmed] = useState(false);
  const [shippingOptions, setShippingOptions] = useState<SdkShippingOption[]>([]);
  const [selectedShipping, setSelectedShipping] = useState('');
  const [loadingShippingOpts, setLoadingShippingOpts] = useState(false);
  const [submittingShipping, setSubmittingShipping] = useState(false);
  const shippingSubmitLockRef = useRef(false);
  const [checkoutDraftHydrated, setCheckoutDraftHydrated] = useState(false);
  const [redirectingToHostedCheckout, setRedirectingToHostedCheckout] = useState(false);
  const redirectingToHostedCheckoutRef = useRef(false);
  const sessionCustomerBootstrapRef = useRef(false);

  // UI state
  const [error, setError] = useState<string | null>(null);

  // SDK adapter
  const sdkRef = useRef<CheckoutSdkAdapter | null>(null);

  useEffect(() => {
    const adapter = new CheckoutSdkAdapter(session.checkoutId, session.storeUrl ?? '');
    sdkRef.current = adapter;
    void adapter.init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const persistedDraft = readPersistedCheckoutDraft(session.checkoutId);
    let hydratedStep: Step = 'guest';
    let hydratedShippingAddr: CheckoutAddress = {
      ...EMPTY_CHECKOUT_ADDRESS,
      email: '',
    };

    if (persistedDraft) {
      const shippingFromDraft: CheckoutAddress = {
        ...persistedDraft.shippingAddr,
        email: persistedDraft.shippingAddr.email || persistedDraft.guestEmail,
      };
      const billingFromDraft: CheckoutAddress = persistedDraft.sameAsShipping
        ? { ...shippingFromDraft }
        : {
            ...persistedDraft.billingAddr,
            email:
              persistedDraft.billingAddr.email ||
              shippingFromDraft.email ||
              persistedDraft.guestEmail,
          };

      setGuestEmail(persistedDraft.guestEmail);
      setSmsConsent(persistedDraft.smsConsent);
      setShippingAddr(shippingFromDraft);
      setSameAsShipping(persistedDraft.sameAsShipping);
      setBillingAddr(billingFromDraft);
      setSelectedShipping(persistedDraft.selectedShipping);

      hydratedStep = persistedDraft.step;
      hydratedShippingAddr = shippingFromDraft;
    }

    const params = new URLSearchParams(window.location.search);
    const source = params.get('source')?.trim().toLowerCase();

    if (source === HOSTED_CHECKOUT_EDIT_SOURCE) {
      const requestedStep = mapHostedEditTargetToStep(params.get('edit'));

      hydratedStep =
        requestedStep === 'payment' && !hasRequiredShippingAddressFields(hydratedShippingAddr)
          ? 'shipping'
          : requestedStep;
    } else if (hydratedStep === 'payment' && !hasRequiredShippingAddressFields(hydratedShippingAddr)) {
      hydratedStep = 'shipping';
    }

    setStep(hydratedStep);
    setCheckoutDraftHydrated(true);
  }, [session.checkoutId]);

  useEffect(() => {
    if (!checkoutDraftHydrated) {
      return;
    }

    const shippingWithEmail: CheckoutAddress = {
      ...shippingAddr,
      email: shippingAddr.email || guestEmail,
    };
    const billingWithEmail: CheckoutAddress = sameAsShipping
      ? { ...shippingWithEmail }
      : {
          ...billingAddr,
          email: billingAddr.email || shippingWithEmail.email || guestEmail,
        };

    writePersistedCheckoutDraft(session.checkoutId, {
      version: 1,
      savedAt: Date.now(),
      step,
      guestEmail,
      smsConsent,
      shippingAddr: shippingWithEmail,
      sameAsShipping,
      billingAddr: billingWithEmail,
      selectedShipping,
    });
  }, [
    billingAddr,
    checkoutDraftHydrated,
    guestEmail,
    sameAsShipping,
    selectedShipping,
    session.checkoutId,
    shippingAddr,
    smsConsent,
    step,
  ]);

  useEffect(() => {
    if (!checkoutDraftHydrated || sessionCustomerBootstrapRef.current || signedInCustomer) {
      return;
    }

    sessionCustomerBootstrapRef.current = true;

    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch('/api/checkout/auth/me', {
          cache: 'no-store',
        });

        if (!res.ok) {
          return;
        }

        const data = (await res.json()) as CheckoutAuthMeResponse;

        if (cancelled || !data.authenticated) {
          return;
        }

        const email = readStringValue(data.email, guestEmail, session.customer.email);

        if (!email) {
          return;
        }

        const normalisedAddresses = normaliseSavedAddresses(data.addresses);
        const customerId = data.customerId;

        if (typeof customerId !== 'number' || customerId <= 0) {
          setGuestEmail((prev) => prev || email);
          setShippingAddr((prev) => ({
            ...prev,
            email: prev.email || email,
          }));
          setBillingAddr((prev) => ({
            ...prev,
            email: prev.email || email,
          }));

          return;
        }

        const customer: SignedInCustomer = {
          customerId,
          firstName: readStringValue(data.firstName),
          lastName: readStringValue(data.lastName),
          email,
          phone: readStringValue(data.phone),
          addresses: normalisedAddresses,
        };

        const hasCheckoutProgress =
          step !== 'guest' ||
          Boolean(guestEmail) ||
          Boolean(
            shippingAddr.firstName ||
              shippingAddr.lastName ||
              shippingAddr.address1 ||
              shippingAddr.city ||
              shippingAddr.postalCode,
          );

        setSignedInCustomer(customer);
        setFoundCustomer({
          customerId: customer.customerId,
          firstName: customer.firstName,
          lastName: customer.lastName,
        });
        setLookupStatus('idle');
        setShowSignIn(false);
        setSignInPassword('');
        setError(null);
        setGuestEmail((prev) => prev || customer.email);

        if (hasCheckoutProgress) {
          return;
        }

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

        setStep('shipping');
      } catch {
        // If this call fails, checkout still works via guest/manual sign in flows.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    checkoutDraftHydrated,
    guestEmail,
    session.customer.email,
    shippingAddr.address1,
    shippingAddr.city,
    shippingAddr.firstName,
    shippingAddr.lastName,
    shippingAddr.postalCode,
    signedInCustomer,
    step,
  ]);

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

      const normalisedAddresses = normaliseSavedAddresses(data.addresses);

      const customer: SignedInCustomer = {
        customerId: data.customerId!,
        firstName: data.firstName ?? '',
        lastName: data.lastName ?? '',
        email: data.email ?? guestEmail,
        phone: data.phone ?? '',
        addresses: normalisedAddresses,
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

    const selectedAddress =
      selectedAddressId && selectedAddressId !== 'new'
        ? signedInCustomer.addresses.find((address) => address.id === selectedAddressId)
        : signedInCustomer.addresses[0];

    if (selectedAddress) {
      setShippingAddr((prev) => ({
        ...prev,
        firstName: selectedAddress.firstName || prev.firstName || signedInCustomer.firstName,
        lastName: selectedAddress.lastName || prev.lastName || signedInCustomer.lastName,
        email: prev.email || signedInCustomer.email,
        phone: selectedAddress.phone || prev.phone || signedInCustomer.phone,
        address1: selectedAddress.address1 || prev.address1,
        address2: selectedAddress.address2 || prev.address2,
        city: selectedAddress.city || prev.city,
        state: selectedAddress.state || prev.state,
        postalCode: selectedAddress.postalCode || prev.postalCode,
        country: selectedAddress.countryCode || prev.country || 'US',
      }));

      if (selectedAddressId == null) {
        setSelectedAddressId(selectedAddress.id);
      }
    } else {
      setShippingAddr((prev) => ({
        ...prev,
        firstName: prev.firstName || signedInCustomer.firstName,
        lastName: prev.lastName || signedInCustomer.lastName,
        email: prev.email || signedInCustomer.email,
        phone: prev.phone || signedInCustomer.phone,
      }));
    }

    setError(null);
    setStep('shipping');
  }, [signedInCustomer, selectedAddressId]);

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

  const handleShippingSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();

      if (shippingSubmitLockRef.current) {
        return;
      }

      if (!hasRequiredShippingAddressFields(shippingAddr)) {
        setError('Please fill in all required shipping fields');

        return;
      }

      if (!sameAsShipping && !hasRequiredBillingAddressFields(billingAddr)) {
        setError('Please fill in all required billing fields');

        return;
      }

      if (shippingConfirmed && shippingOptions.length > 0 && !selectedShipping) {
        setError('Please select a shipping method');

        return;
      }

      shippingSubmitLockRef.current = true;
      setError(null);
      setSubmittingShipping(true);
      setLoadingShippingOpts(true);
      redirectingToHostedCheckoutRef.current = false;
      setRedirectingToHostedCheckout(false);

      try {
        const sdk = sdkRef.current;

        if (!sdk) {
          throw new Error('Checkout service is still initializing. Please try again.');
        }

        let nextShippingOptions = shippingOptions;
        let shippingOptionId = selectedShipping;

        if (!shippingConfirmed || shippingOptions.length === 0) {
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

          nextShippingOptions = await sdk.loadShippingOptions();
          setShippingOptions(nextShippingOptions);
          setShippingConfirmed(true);

          if (nextShippingOptions.length > 0) {
            const chosenOption =
              nextShippingOptions.find((option) => option.id === shippingOptionId) ??
              nextShippingOptions.find((option) => option.isRecommended) ??
              nextShippingOptions[0];

            shippingOptionId = chosenOption?.id ?? '';

            if (shippingOptionId) {
              setSelectedShipping(shippingOptionId);
            }
          } else {
            shippingOptionId = '';
            setSelectedShipping('');
          }
        }

        if (nextShippingOptions.length > 0 && !shippingOptionId) {
          throw new Error('Please select a shipping method');
        }

        if (shippingOptionId) {
          await sdk.selectShippingOption(shippingOptionId);
        }

        const hostedCheckoutUrlPromise = HOSTED_CHECKOUT_FLOW_CONFIG.enabled
          ? resolveHostedCheckoutUrl(session.checkoutId)
          : null;

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

        if (HOSTED_CHECKOUT_FLOW_CONFIG.enabled) {
          setRedirectingToHostedCheckout(true);
          redirectingToHostedCheckoutRef.current = true;

          const checkoutUrl = hostedCheckoutUrlPromise
            ? await hostedCheckoutUrlPromise
            : await resolveHostedCheckoutUrl(session.checkoutId);
          const returnToken = await resolveCheckoutReturnToken({
            checkoutId: session.checkoutId,
            email: shippingAddr.email || guestEmail,
            currency: session.currencyCode,
          });
          const hostedCheckoutUrl = buildHostedCheckoutLaunchUrl(checkoutUrl, {
            localePrefix,
            email: shippingAddr.email || guestEmail,
            currency: session.currencyCode,
            returnToken,
          });
          const hostedLaunchUrl = await resolveHostedLaunchUrl(hostedCheckoutUrl, session.checkoutId);

          window.location.assign(hostedLaunchUrl);

          return;
        }

        setStep('payment');
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Could not process shipping details. Please try again.',
        );
        redirectingToHostedCheckoutRef.current = false;
        setRedirectingToHostedCheckout(false);
      } finally {
        if (!redirectingToHostedCheckoutRef.current) {
          setLoadingShippingOpts(false);
          setSubmittingShipping(false);
        }
        shippingSubmitLockRef.current = false;
      }
    },
    [
      billingAddr,
      guestEmail,
      localePrefix,
      sameAsShipping,
      selectedShipping,
      session.checkoutId,
      session.currencyCode,
      shippingAddr,
      shippingConfirmed,
      shippingOptions,
    ],
  );

  const contactDisplayName = signedInCustomer
    ? formatDisplayName(signedInCustomer.firstName, signedInCustomer.lastName)
    : formatDisplayName(shippingAddr.firstName, shippingAddr.lastName);
  const contactEmail = shippingAddr.email || guestEmail || signedInCustomer?.email || '';
  const contactSummary =
    formatContactSummary(contactDisplayName, contactEmail) || 'Enter your email to begin checkout';

  const shippingAddressSummary = formatAddressSummary(shippingAddr);
  const selectedShippingOption = shippingOptions.find((option) => option.id === selectedShipping);
  const shippingMethodSummary = selectedShippingOption
    ? selectedShippingOption.description
    : shippingConfirmed
      ? 'Select a shipping method'
      : 'Shipping method appears after address confirmation';
  const deliverySummary = shippingAddressSummary
    ? `${shippingAddressSummary} · ${shippingMethodSummary}`
    : 'Add your delivery address';
  const billingSummary = sameAsShipping
    ? shippingAddressSummary
      ? `Same as delivery · ${shippingAddressSummary}`
      : 'Billing will match delivery address'
    : formatAddressSummary(billingAddr) || 'Add your billing address';

  const contactComplete = Boolean(contactEmail);
  const deliveryComplete =
    Boolean(shippingAddressSummary) &&
    (shippingConfirmed ? shippingOptions.length === 0 || Boolean(selectedShipping) : false);
  const billingComplete = sameAsShipping
    ? Boolean(shippingAddressSummary)
    : hasRequiredBillingAddressFields(billingAddr);

  // ── STEP: Guest ──────────────────────────────────────────────────

  if (step === 'guest') {
    return (
      <main className="page">
        <div className="page-header">
          <h1 className="page-title">Checkout</h1>
        </div>

        <CheckoutFlowOverview
          step="guest"
          localePrefix={localePrefix}
          contactSummary={contactSummary}
          deliverySummary={deliverySummary}
          billingSummary={billingSummary}
          paymentSummary="Payment starts after delivery details are confirmed"
          contactComplete={contactComplete}
          deliveryComplete={deliveryComplete}
          billingComplete={billingComplete}
          paymentComplete={false}
        />

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

        <CheckoutFlowOverview
          step="shipping"
          localePrefix={localePrefix}
          contactSummary={contactSummary}
          deliverySummary={deliverySummary}
          billingSummary={billingSummary}
          paymentSummary="Secure payment unlocks once delivery and billing are ready"
          contactComplete={contactComplete}
          deliveryComplete={deliveryComplete}
          billingComplete={billingComplete}
          paymentComplete={false}
          onEditContact={() => setStep('guest')}
        />

        <form
          className="checkout-grid"
          onSubmit={(e) => {
            void handleShippingSubmit(e);
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

            <div className="card section-gap billing-preference-card">
              <p className="section-label">Billing preference</p>

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
                <span className="billing-same-label">Use shipping address for billing</span>
              </button>
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

              {sameAsShipping && (
                <p className="billing-same-summary">
                  Billing will match your shipping address for this order.
                </p>
              )}

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

            {redirectingToHostedCheckout && (
              <p className="lookup-checking">
                <Spinner /> Redirecting to secure hosted checkout…
              </p>
            )}

            {loadingShippingOpts && !redirectingToHostedCheckout && (
              <p className="lookup-checking">
                <Spinner /> {shippingConfirmed ? 'Confirming your order details…' : 'Fetching shipping options…'}
              </p>
            )}

            <button
              type="submit"
              className={`cta-btn${submittingShipping || redirectingToHostedCheckout ? ' cta-btn-loading' : ''}`}
              disabled={submittingShipping || loadingShippingOpts || redirectingToHostedCheckout}
            >
              {redirectingToHostedCheckout ? (
                <><Spinner /> Redirecting to secure hosted checkout…</>
              ) : submittingShipping || loadingShippingOpts ? (
                <><Spinner /> {shippingConfirmed ? 'Confirming details…' : 'Preparing checkout…'}</>
              ) : HOSTED_CHECKOUT_FLOW_CONFIG.enabled ? (
                'Continue to secure payment →'
              ) : (
                'Continue to payment →'
              )}
            </button>
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
        contactSummary={contactSummary}
        deliverySummary={deliverySummary}
        billingSummary={billingSummary}
        contactComplete={contactComplete}
        deliveryComplete={deliveryComplete}
        billingComplete={billingComplete}
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

interface CheckoutFlowOverviewProps {
  step: Step;
  localePrefix: string;
  contactSummary: string;
  deliverySummary: string;
  billingSummary: string;
  paymentSummary: string;
  contactComplete: boolean;
  deliveryComplete: boolean;
  billingComplete: boolean;
  paymentComplete: boolean;
  onEditContact?: () => void;
  onEditDelivery?: () => void;
}

function CheckoutFlowOverview({
  step,
  localePrefix,
  contactSummary,
  deliverySummary,
  billingSummary,
  paymentSummary,
  contactComplete,
  deliveryComplete,
  billingComplete,
  paymentComplete,
  onEditContact,
  onEditDelivery,
}: CheckoutFlowOverviewProps) {
  const wizardSteps: Array<{ key: Step; label: string }> = [
    { key: 'guest', label: 'Contact' },
    { key: 'shipping', label: 'Delivery' },
    { key: 'payment', label: 'Payment' },
  ];
  const currentWizardIndex = wizardSteps.findIndex((wizardStep) => wizardStep.key === step);
  const currentSnapshotKey = step === 'guest' ? 'contact' : step === 'shipping' ? 'delivery' : 'payment';

  const wizardNodes = wizardSteps.flatMap((wizardStep, index) => {
    const state =
      index < currentWizardIndex
        ? 'complete'
        : index === currentWizardIndex
          ? 'current'
          : 'upcoming';
    const nodes: React.ReactNode[] = [
      <div
        key={`step-${wizardStep.key}`}
        className={`checkout-progress-step checkout-progress-step-${state}`}
        role="listitem"
      >
        <span className={`checkout-progress-badge checkout-progress-badge-${state}`}>
          {state === 'complete' ? '✓' : index + 1}
        </span>
        <span className="checkout-progress-label">{wizardStep.label}</span>
      </div>,
    ];

    if (index < wizardSteps.length - 1) {
      nodes.push(
        <span
          key={`connector-${wizardStep.key}`}
          className={`checkout-progress-connector${index < currentWizardIndex ? ' checkout-progress-connector-complete' : ''}`}
          aria-hidden="true"
        />,
      );
    }

    return nodes;
  });

  type SnapshotRowKey = 'contact' | 'delivery' | 'billing' | 'payment';

  const snapshotRows: Array<{
    key: SnapshotRowKey;
    label: string;
    summary: string;
    complete: boolean;
    onEdit?: () => void;
  }> = [
    {
      key: 'contact',
      label: 'Contact',
      summary: contactSummary,
      complete: contactComplete,
      onEdit: onEditContact,
    },
    {
      key: 'delivery',
      label: 'Delivery',
      summary: deliverySummary,
      complete: deliveryComplete,
      onEdit: onEditDelivery,
    },
    {
      key: 'billing',
      label: 'Billing',
      summary: billingSummary,
      complete: billingComplete,
      onEdit: onEditDelivery,
    },
    {
      key: 'payment',
      label: 'Payment',
      summary: paymentSummary,
      complete: paymentComplete,
    },
  ];

  const resolveSnapshotState = (
    rowKey: SnapshotRowKey,
    complete: boolean,
  ): 'complete' | 'current' | 'pending' => {
    if (complete) {
      return 'complete';
    }

    if (rowKey === currentSnapshotKey || (step === 'shipping' && rowKey === 'billing')) {
      return 'current';
    }

    return 'pending';
  };

  return (
    <section className="card section-gap checkout-flow-overview" aria-label="Checkout progress">
      <div className="checkout-progress-track" role="list" aria-label="Checkout steps">
        {wizardNodes}
      </div>

      <div className="checkout-snapshot-grid">
        {snapshotRows.map((row) => {
          const state = resolveSnapshotState(row.key, row.complete);

          return (
            <article key={row.key} className={`checkout-snapshot-row checkout-snapshot-row-${state}`}>
              <div className="checkout-snapshot-row-top">
                <p className="checkout-snapshot-label">{row.label}</p>
                <span className={`checkout-snapshot-state checkout-snapshot-state-${state}`}>
                  {state === 'complete' ? 'Completed' : state === 'current' ? 'In progress' : 'Pending'}
                </span>
              </div>

              <p className="checkout-snapshot-value">{row.summary}</p>

              {row.onEdit && row.complete && (
                <button
                  type="button"
                  className="checkout-snapshot-edit"
                  onClick={row.onEdit}
                >
                  Edit
                </button>
              )}
            </article>
          );
        })}
      </div>

      <div className="checkout-flow-actions">
        <a className="checkout-flow-link" href={`${localePrefix}/cart`}>
          Edit cart
        </a>
        <a className="checkout-flow-link" href={localePrefix || '/'}>
          Continue shopping
        </a>
      </div>
    </section>
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
  contactSummary: string;
  deliverySummary: string;
  billingSummary: string;
  contactComplete: boolean;
  deliveryComplete: boolean;
  billingComplete: boolean;
  onBack: () => void;
  localePrefix: string;
}

interface CachedPaymentMethods {
  methods: SdkPaymentMethod[];
  cachedAt: number;
}

const DEFAULT_PAYMENT_METHODS_CACHE_PREFIX = 'co-payment-methods-v1';
const DEFAULT_PAYMENT_METHODS_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_PAYMENT_METHODS_CACHE_ENABLED = true;

function resolvePaymentMethodsCacheConfig() {
  const configuredPrefix = process.env.NEXT_PUBLIC_CHECKOUT_PAYMENT_METHODS_CACHE_PREFIX?.trim();
  const configuredTtlMs = Number(process.env.NEXT_PUBLIC_CHECKOUT_PAYMENT_METHODS_CACHE_TTL_MS);
  const enabled = parseBooleanValue(
    process.env.NEXT_PUBLIC_CHECKOUT_PAYMENT_METHODS_CACHE_ENABLED,
    DEFAULT_PAYMENT_METHODS_CACHE_ENABLED,
  );

  return {
    prefix: configuredPrefix || DEFAULT_PAYMENT_METHODS_CACHE_PREFIX,
    ttlMs:
      Number.isFinite(configuredTtlMs) && configuredTtlMs >= 0
        ? configuredTtlMs
        : DEFAULT_PAYMENT_METHODS_CACHE_TTL_MS,
    enabled,
  };
}

const PAYMENT_METHODS_CACHE_CONFIG = resolvePaymentMethodsCacheConfig();

function getPaymentMethodsCacheKey(checkoutId: string): string {
  return `${PAYMENT_METHODS_CACHE_CONFIG.prefix}:${window.location.host}:${checkoutId}`;
}

function readCachedPaymentMethods(checkoutId: string): SdkPaymentMethod[] | null {
  if (!PAYMENT_METHODS_CACHE_CONFIG.enabled || PAYMENT_METHODS_CACHE_CONFIG.ttlMs <= 0) {
    return null;
  }

  try {
    const cacheKey = getPaymentMethodsCacheKey(checkoutId);
    const raw = window.sessionStorage.getItem(cacheKey);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<CachedPaymentMethods>;
    const methods = parsed.methods;
    const cachedAt = parsed.cachedAt;

    if (!Array.isArray(methods) || typeof cachedAt !== 'number') {
      window.sessionStorage.removeItem(cacheKey);
      return null;
    }

    if (Date.now() - cachedAt > PAYMENT_METHODS_CACHE_CONFIG.ttlMs) {
      window.sessionStorage.removeItem(cacheKey);
      return null;
    }

    return methods;
  } catch {
    return null;
  }
}

function writeCachedPaymentMethods(checkoutId: string, methods: SdkPaymentMethod[]): void {
  if (!PAYMENT_METHODS_CACHE_CONFIG.enabled || PAYMENT_METHODS_CACHE_CONFIG.ttlMs <= 0) {
    return;
  }

  try {
    const cacheKey = getPaymentMethodsCacheKey(checkoutId);

    if (methods.length === 0) {
      window.sessionStorage.removeItem(cacheKey);
      return;
    }

    const value: CachedPaymentMethods = {
      methods,
      cachedAt: Date.now(),
    };

    window.sessionStorage.setItem(cacheKey, JSON.stringify(value));
  } catch {
    // Ignore storage failures (private mode, quota, etc.) and continue without cache.
  }
}

function PaymentStep({
  session,
  email,
  name,
  city,
  contactSummary,
  deliverySummary,
  billingSummary,
  contactComplete,
  deliveryComplete,
  billingComplete,
  onBack,
  localePrefix,
}: PaymentStepProps) {
  const router = useRouter();

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: session.currencyCode }).format(n);

  // ── State ────────────────────────────────────────────────────────────────

  const [availableMethods, setAvailableMethods] = useState<SdkPaymentMethod[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentKey>('');
  const [loadingMethods, setLoadingMethods] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitLockRef = useRef(false);

  const [useLoan, setUseLoan] = useState(false);
  const [loanAmount, setLoanAmount] = useState(
    Math.min(session.loan.approvedAmount, session.grandTotal),
  );

  const maxLoan = Math.min(session.loan.approvedAmount, session.grandTotal);
  const showLoan = session.loanEnabled && session.loan.eligible;
  const dueTodayWithLoan = Math.max(session.grandTotal - loanAmount, 0);

  // ── Load payment methods from BigCommerce payment settings ────────────────

  useEffect(() => {
    let cancelled = false;

    const applyMethods = (methods: SdkPaymentMethod[]) => {
      setAvailableMethods(methods);
      setPaymentMethod((current) => {
        if (current && methods.some((method) => method.id === current)) {
          return current;
        }

        return methods[0]?.id ?? '';
      });

      if (methods.length > 0) {
        setError(null);
      } else {
        setError('No payment methods are configured in BigCommerce for this checkout.');
      }
    };

    void (async () => {
      try {
        const cachedMethods = readCachedPaymentMethods(session.checkoutId);

        if (cachedMethods) {
          if (!cancelled) {
            applyMethods(cachedMethods);
          }

          return;
        }

        const res = await fetch(
          `/api/checkout/payment-methods?checkoutId=${encodeURIComponent(session.checkoutId)}`,
        );
        const data = (await res.json()) as { methods?: SdkPaymentMethod[]; error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? 'Could not load payment options.');
        }

        const methods = data.methods ?? [];
        writeCachedPaymentMethods(session.checkoutId, methods);

        if (!cancelled) {
          applyMethods(methods);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load payment options.');
        }
      } finally {
        if (!cancelled) {
          setLoadingMethods(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session.checkoutId]);

  const redirectToHostedCheckout = useCallback(async () => {
    const checkoutUrl = await resolveHostedCheckoutUrl(session.checkoutId);
    const returnToken = await resolveCheckoutReturnToken({
      checkoutId: session.checkoutId,
      email,
      currency: session.currencyCode,
    });
    const hostedCheckoutUrl = buildHostedCheckoutLaunchUrl(checkoutUrl, {
      localePrefix,
      email,
      currency: session.currencyCode,
      returnToken,
    });
    const hostedLaunchUrl = await resolveHostedLaunchUrl(hostedCheckoutUrl, session.checkoutId);

    window.location.assign(hostedLaunchUrl);
  }, [email, localePrefix, session.checkoutId, session.currencyCode]);

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (submitLockRef.current) {
        return;
      }

      submitLockRef.current = true;
      setError(null);
      setSubmitting(true);

      try {
        const selectedMethod = availableMethods.find((m) => m.id === paymentMethod);
        if (!selectedMethod) {
          throw new Error('Please select a payment method.');
        }

        if (isManualMethod(selectedMethod)) {
          let appliedLoan = 0;
          const returnToken = await resolveCheckoutReturnToken({
            checkoutId: session.checkoutId,
            email,
            currency: session.currencyCode,
          });

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
          params.set(HOSTED_CHECKOUT_FLOW_CONFIG.returnTokenParam, returnToken);
          clearPersistedCheckoutDraft(session.checkoutId);
          router.push(`${localePrefix}/checkout/order-confirmation?${params.toString()}`);
          return;
        }

        await redirectToHostedCheckout();
        return;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Something went wrong. Please try again.',
        );
      } finally {
        submitLockRef.current = false;
        setSubmitting(false);
      }
    },
    [
      paymentMethod,
      session,
      useLoan,
      loanAmount,
      availableMethods,
      redirectToHostedCheckout,
      router,
      localePrefix,
      email,
    ],
  );

  const selectedMethod = availableMethods.find((m) => m.id === paymentMethod);
  const manualSelected = selectedMethod ? isManualMethod(selectedMethod) : false;
  const showLoanForSelection = showLoan && manualSelected;
  const disableSubmit =
    submitting ||
    !paymentMethod;
  const selectedMethodLabel = selectedMethod?.name || selectedMethod?.method || 'Selected method';
  const paymentSummary = loadingMethods
    ? 'Loading payment options…'
    : selectedMethod
      ? manualSelected
        ? `${selectedMethodLabel} selected`
        : `${selectedMethodLabel} · Continue in secure hosted checkout`
      : 'Choose your payment method';
  const paymentComplete = Boolean(selectedMethod);

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

      <CheckoutFlowOverview
        step="payment"
        localePrefix={localePrefix}
        contactSummary={contactSummary}
        deliverySummary={deliverySummary}
        billingSummary={billingSummary}
        paymentSummary={paymentSummary}
        contactComplete={contactComplete}
        deliveryComplete={deliveryComplete}
        billingComplete={billingComplete}
        paymentComplete={paymentComplete}
        onEditDelivery={onBack}
      />

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

          {!manualSelected && selectedMethod && (
            <div className="card section-gap">
              <p className="section-label">Secure payment</p>
              <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.6 }}>
                You selected <strong>{selectedMethod.name}</strong>. Payment details are finalized in
                BigCommerce&apos;s secure payment step, then you&apos;ll return here for your order
                confirmation.
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
            ) : (
              'Continue in secure hosted checkout'
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

interface HostedCheckoutLaunchOptions {
  localePrefix: string;
  email?: string;
  currency?: string;
  returnToken?: string;
}

interface CheckoutReturnTokenRequest {
  checkoutId: string;
  email?: string;
  currency?: string;
}

function resolveHostedReturnUrl({
  localePrefix,
  email,
  currency,
  returnToken,
}: HostedCheckoutLaunchOptions): string {
  const fallbackPath = `${localePrefix}/checkout/order-confirmation`;
  const target = new URL(
    HOSTED_CHECKOUT_FLOW_CONFIG.returnUrlOverride ?? fallbackPath,
    window.location.origin,
  );

  if (email) {
    target.searchParams.set('email', email);
  }

  if (currency) {
    target.searchParams.set('currency', currency);
  }

  if (returnToken) {
    target.searchParams.set(HOSTED_CHECKOUT_FLOW_CONFIG.returnTokenParam, returnToken);
  }

  target.searchParams.set('source', DEFAULT_HOSTED_RETURN_SOURCE);

  return target.toString();
}

function buildHostedCheckoutLaunchUrl(
  checkoutUrl: string,
  options: HostedCheckoutLaunchOptions,
): string {
  const target = new URL(checkoutUrl);
  const returnUrl = resolveHostedReturnUrl(options);
  const catalystCheckoutUrl = new URL(`${options.localePrefix}/checkout`, window.location.origin);
  const catalystCartUrl = new URL(`${options.localePrefix}/cart`, window.location.origin);

  target.searchParams.set(HOSTED_CHECKOUT_FLOW_CONFIG.returnUrlParam, returnUrl);
  target.searchParams.set(
    HOSTED_CHECKOUT_FLOW_CONFIG.checkoutUrlParam,
    catalystCheckoutUrl.toString(),
  );
  target.searchParams.set(
    HOSTED_CHECKOUT_FLOW_CONFIG.cartUrlParam,
    catalystCartUrl.toString(),
  );

  if (HOSTED_CHECKOUT_FLOW_CONFIG.paymentOnlyMode) {
    target.searchParams.set(HOSTED_CHECKOUT_FLOW_CONFIG.paymentOnlyParam, '1');
  }

  return target.toString();
}

interface HostedCheckoutUrlResponse {
  checkoutUrl?: string;
  error?: string;
  detail?: string;
}

interface HostedLaunchUrlResponse {
  launchUrl?: string;
  identityCarried?: boolean;
  error?: string;
  detail?: string;
}

interface CheckoutReturnTokenResponse {
  token?: string;
  error?: string;
}

async function resolveCheckoutReturnToken({
  checkoutId,
  email,
  currency,
}: CheckoutReturnTokenRequest): Promise<string> {
  const res = await fetch('/api/checkout/return-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ checkoutId, email, currency }),
  });
  const payload = (await res.json()) as CheckoutReturnTokenResponse;

  if (res.ok && payload.token) {
    return payload.token;
  }

  throw new Error(
    payload.error ?? `Could not prepare secure checkout return [${res.status}].`,
  );
}

async function resolveHostedCheckoutUrl(checkoutId: string): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= HOSTED_CHECKOUT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(
        `/api/checkout/checkout-url?checkoutId=${encodeURIComponent(checkoutId)}`,
      );
      const payload = await parseHostedCheckoutResponse(res);

      if (res.ok && payload.checkoutUrl) {
        return payload.checkoutUrl;
      }

      const message =
        payload.error ??
        payload.detail ??
        `Could not open secure hosted checkout [${res.status}].`;
      const retryable = res.status === 429 || res.status >= 500;

      if (!retryable || attempt === HOSTED_CHECKOUT_MAX_ATTEMPTS) {
        throw new Error(message);
      }

      lastError = new Error(message);
    } catch (err) {
      const nextError =
        err instanceof Error
          ? err
          : new Error('Could not open secure hosted checkout.');

      if (attempt === HOSTED_CHECKOUT_MAX_ATTEMPTS) {
        throw nextError;
      }

      lastError = nextError;
    }

    await sleep(HOSTED_CHECKOUT_RETRY_DELAY_MS * attempt);
  }

  throw lastError ?? new Error('Could not open secure hosted checkout.');
}

async function parseHostedCheckoutResponse(
  res: Response,
): Promise<HostedCheckoutUrlResponse> {
  const bodyText = await res.text();

  if (!bodyText) {
    return {};
  }

  try {
    return JSON.parse(bodyText) as HostedCheckoutUrlResponse;
  } catch {
    return { detail: bodyText };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

async function resolveHostedLaunchUrl(checkoutUrl: string, checkoutId: string): Promise<string> {
  const response = await fetch('/api/checkout/auth/hosted-login-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ checkoutUrl, checkoutId }),
  });

  const payload = await parseHostedLaunchUrlResponse(response);

  if (response.ok && payload.launchUrl) {
    return payload.launchUrl;
  }

  throw new Error(
    payload.error ??
      payload.detail ??
      `Could not launch secure hosted checkout [${response.status}].`,
  );
}

async function parseHostedLaunchUrlResponse(
  res: Response,
): Promise<HostedLaunchUrlResponse> {
  const bodyText = await res.text();

  if (!bodyText) {
    return {};
  }

  try {
    return JSON.parse(bodyText) as HostedLaunchUrlResponse;
  } catch {
    return { detail: bodyText };
  }
}
