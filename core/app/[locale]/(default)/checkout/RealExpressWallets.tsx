'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  createCheckoutService,
  type CheckoutService,
  type CustomerInitializeOptions,
} from '@bigcommerce/checkout-sdk';
import {
  createBigCommercePaymentsCustomerStrategy,
  createBigCommercePaymentsPayLaterCustomerStrategy,
  createBigCommercePaymentsVenmoCustomerStrategy,
} from '@bigcommerce/checkout-sdk/integrations/bigcommerce-payments';
import {
  createBraintreeFastlaneCustomerStrategy,
  createBraintreePaypalCreditCustomerStrategy,
  createBraintreePaypalCustomerStrategy,
  createBraintreeVisaCheckoutCustomerStrategy,
} from '@bigcommerce/checkout-sdk/integrations/braintree';
import {
  createPayPalCommerceCreditCustomerStrategy,
  createPayPalCommerceCustomerStrategy,
  createPayPalCommerceFastlaneCustomerStrategy,
  createPayPalCommerceVenmoCustomerStrategy,
} from '@bigcommerce/checkout-sdk/integrations/paypal-commerce';
import {
  createStripeLinkV2CustomerStrategy,
  createStripeUPECustomerStrategy,
} from '@bigcommerce/checkout-sdk/integrations/stripe';

export interface ExpressCheckoutAddressSnapshot {
  firstName?: string;
  lastName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  email?: string;
}

export interface ExpressCheckoutShippingOptionSnapshot {
  id: string;
  description: string;
  cost: number;
  transitTime?: string;
  isRecommended?: boolean;
  selected?: boolean;
}

export interface ExpressCheckoutSyncPayload {
  billingAddress?: ExpressCheckoutAddressSnapshot;
  guestEmail?: string;
  selectedShippingOptionId?: string;
  shippingAddress?: ExpressCheckoutAddressSnapshot;
  shippingOptions?: ExpressCheckoutShippingOptionSnapshot[];
  totals?: {
    grandTotal: number;
    outstandingBalance: number;
    shipping: number;
    subtotal: number;
    tax: number;
  };
}

interface RealExpressWalletsProps {
  checkoutId: string;
  currencyCode: string;
  disabled?: boolean;
  onError(message: string | null): void;
  onInteraction?(methodId: string): void;
  onSync(payload: ExpressCheckoutSyncPayload): void;
}

const SUPPORTED_METHODS: string[] = [
  'amazonpay',
  'applepay',
  'bigcommerce_payments',
  'bigcommerce_payments_paylater',
  'bigcommerce_payments_venmo',
  'braintreepaypal',
  'braintreepaypalcredit',
  'braintreevisacheckout',
  'paypalcommerce',
  'paypalcommercecredit',
  'paypalcommercevenmo',
  'googlepayadyenv2',
  'googlepayadyenv3',
  'googlepayauthorizenet',
  'googlepaybnz',
  'googlepaybraintree',
  'googlepaycheckoutcom',
  'googlepaycybersourcev2',
  'googlepayorbital',
  'googlepaystripe',
  'googlepaystripeupe',
  'googlepayworldpayaccess',
  'googlepaypaypalcommerce',
  'googlepaytdonlinemart',
  'stripeocs',
  'googlepaystripeocs',
  'googlepay_bigcommerce_payments',
];

const INTEGRATIONS = [
  createBigCommercePaymentsCustomerStrategy,
  createBigCommercePaymentsPayLaterCustomerStrategy,
  createBigCommercePaymentsVenmoCustomerStrategy,
  createBraintreePaypalCustomerStrategy,
  createBraintreePaypalCreditCustomerStrategy,
  createBraintreeFastlaneCustomerStrategy,
  createBraintreeVisaCheckoutCustomerStrategy,
  createPayPalCommerceCustomerStrategy,
  createPayPalCommerceCreditCustomerStrategy,
  createPayPalCommerceVenmoCustomerStrategy,
  createPayPalCommerceFastlaneCustomerStrategy,
  createStripeUPECustomerStrategy,
  createStripeLinkV2CustomerStrategy,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getWalletGroup(methodId: string): string {
  if (methodId === 'applepay') {
    return 'applepay';
  }

  if (methodId === 'amazonpay') {
    return 'amazonpay';
  }

  if (methodId.startsWith('googlepay')) {
    return 'googlepay';
  }

  if (methodId.includes('venmo')) {
    return 'venmo';
  }

  if (methodId.includes('paylater')) {
    return 'paylater';
  }

  if (methodId === 'stripeocs') {
    return 'stripe';
  }

  return methodId;
}

function getWalletSortWeight(methodId: string): number {
  switch (getWalletGroup(methodId)) {
    case 'applepay':
      return 10;
    case 'googlepay':
      return 20;
    case 'paypalcommerce':
    case 'bigcommerce_payments':
    case 'braintreepaypal':
    case 'braintreepaypalcredit':
      return 30;
    case 'amazonpay':
      return 40;
    case 'paylater':
      return 50;
    case 'venmo':
      return 60;
    case 'stripe':
      return 70;
    default:
      return 80;
  }
}

function selectVisibleWalletMethods(methodIds: string[]): string[] {
  const seenGroups = new Set<string>();

  return [...methodIds]
    .filter((methodId) => SUPPORTED_METHODS.includes(methodId))
    .sort((left, right) => getWalletSortWeight(left) - getWalletSortWeight(right))
    .filter((methodId) => {
      const group = getWalletGroup(methodId);

      if (seenGroups.has(group)) {
        return false;
      }

      seenGroups.add(group);
      return true;
    });
}

function mapAddressSnapshot(value: unknown): ExpressCheckoutAddressSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    firstName: readString(value.firstName),
    lastName: readString(value.lastName),
    address1: readString(value.address1),
    address2: readString(value.address2),
    city: readString(value.city),
    state:
      readString(value.stateOrProvinceCode) ??
      readString(value.stateOrProvince) ??
      readString(value.state),
    postalCode: readString(value.postalCode),
    country: readString(value.countryCode) ?? readString(value.country),
    phone: readString(value.phone),
    email: readString(value.email),
  };
}

function mapShippingOptionSnapshot(value: unknown): ExpressCheckoutShippingOptionSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readString(value.id);
  const description = readString(value.description);
  const cost = readNumber(value.costAfterDiscount) ?? readNumber(value.cost);

  if (!id || !description || typeof cost !== 'number') {
    return null;
  }

  return {
    id,
    description,
    cost,
    transitTime: readString(value.transitTime),
    isRecommended: value.isRecommended === true,
  };
}

function getSharedCustomerOptions(
  methodId: string,
  container: string,
  onClick: () => void,
  onError: (error?: Error) => void,
  onComplete: () => void,
): Record<string, unknown> {
  const shared: Record<string, unknown> = {
    container,
    onClick,
    onError,
  };

  if (methodId === 'applepay') {
    shared.shippingLabel = 'Shipping';
    shared.subtotalLabel = 'Subtotal';
    shared.onPaymentAuthorize = onComplete;
  }

  if (methodId === 'paypalcommerce' || methodId === 'bigcommerce_payments') {
    shared.onComplete = onComplete;
  }

  if (methodId.startsWith('googlepay')) {
    shared.buttonColor = 'black';
    shared.buttonType = 'pay';
  }

  return shared;
}

function buildCustomerInitializeOptions(
  methodId: string,
  checkoutId: string,
  onClick: (methodId: string) => void,
  onError: (message: string) => void,
  onComplete: () => void,
): CustomerInitializeOptions {
  const containerId = `catalyst-express-${checkoutId}-${methodId}`;

  return {
    methodId,
    integrations: INTEGRATIONS,
    [methodId]: getSharedCustomerOptions(
      methodId,
      containerId,
      () => onClick(methodId),
      (error?: Error) => {
        onError(error?.message ?? `Unable to initialize ${methodId}.`);
      },
        onComplete,
      ),
  } as CustomerInitializeOptions;
}

export function RealExpressWallets({
  checkoutId,
  currencyCode,
  disabled = false,
  onError,
  onInteraction,
  onSync,
}: RealExpressWalletsProps) {
  const serviceRef = useRef<CheckoutService | null>(null);
  const initializedMethodIdsRef = useRef<string[]>([]);
  const [methodIds, setMethodIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const visibleMethods = useMemo(() => selectVisibleWalletMethods(methodIds), [methodIds]);

  useEffect(() => {
    const service = serviceRef.current ?? createCheckoutService();
    serviceRef.current = service;

    const syncState = () => {
      const state = service.getState();
      const data = state.data;
      const checkout = data.getCheckout?.();
      const customer = data.getCustomer?.();
      const shippingAddress = data.getShippingAddress?.();
      const billingAddress = data.getBillingAddress?.();
      const consignments = data.getConsignments?.() ?? checkout?.consignments ?? [];
      const firstConsignment = Array.isArray(consignments) ? consignments[0] : undefined;
      const availableShippingOptions = Array.isArray(firstConsignment?.availableShippingOptions)
        ? firstConsignment.availableShippingOptions
            .map(mapShippingOptionSnapshot)
            .filter((option): option is ExpressCheckoutShippingOptionSnapshot => option !== null)
        : undefined;
      const selectedShippingOptionId = readString(firstConsignment?.selectedShippingOption?.id);
      const providers = data.getConfig?.()?.checkoutSettings?.remoteCheckoutProviders;

      if (Array.isArray(providers)) {
        const nextMethodIds = providers.filter(
          (provider): provider is string => typeof provider === 'string',
        );

        setMethodIds((prev) => (areStringArraysEqual(prev, nextMethodIds) ? prev : nextMethodIds));
      }

      onSync({
        guestEmail: readString(customer?.email),
        shippingAddress: mapAddressSnapshot(shippingAddress ?? firstConsignment?.shippingAddress),
        billingAddress: mapAddressSnapshot(billingAddress ?? checkout?.billingAddress),
        selectedShippingOptionId,
        shippingOptions: availableShippingOptions,
        totals: checkout
          ? {
              subtotal: readNumber(checkout.subtotal) ?? 0,
              shipping: readNumber(checkout.shippingCostTotal) ?? 0,
              tax: readNumber(checkout.taxTotal) ?? 0,
              grandTotal: readNumber(checkout.grandTotal) ?? 0,
              outstandingBalance: readNumber(checkout.outstandingBalance) ?? 0,
            }
          : undefined,
      });
    };

    const unsubscribe = service.subscribe(() => {
      syncState();
    });

    let mounted = true;

    void (async () => {
      try {
        await service.loadCheckout(checkoutId);
        await service.loadPaymentMethods();
        if (mounted) {
          syncState();
          onError(null);
        }
      } catch (error) {
        if (mounted) {
          onError(
            error instanceof Error
              ? error.message
              : 'Unable to load BigCommerce express checkout buttons.',
          );
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    })();

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [checkoutId, onError, onSync]);

  useEffect(() => {
    const service = serviceRef.current;

    if (!service || visibleMethods.length === 0 || disabled) {
      return;
    }

    let disposed = false;

    const initializeButtons = async () => {
      const handleComplete = async () => {
        try {
          await service.loadCheckout(checkoutId);
        } catch {
          // The state subscription will surface any follow-up issues.
        }
      };

      for (const methodId of visibleMethods) {
        if (disposed) {
          return;
        }

        try {
          await service.initializeCustomer(
            buildCustomerInitializeOptions(
              methodId,
              checkoutId,
              (clickedMethodId) => {
                onInteraction?.(clickedMethodId);
                onError(null);
              },
              (message) => {
                onError(message);
              },
              handleComplete,
            ),
          );
        } catch (error) {
          onError(
            error instanceof Error
              ? error.message
              : `Unable to initialize ${methodId} express checkout.`,
          );
        }
      }

      initializedMethodIdsRef.current = visibleMethods;
    };

    void initializeButtons();

    return () => {
      disposed = true;

      for (const methodId of initializedMethodIdsRef.current) {
        void service.deinitializeCustomer({ methodId }).catch(() => undefined);
      }

      initializedMethodIdsRef.current = [];
    };
  }, [checkoutId, disabled, onError, onInteraction, visibleMethods]);

  if (!loading && visibleMethods.length === 0) {
    return null;
  }

  return (
    <div className="card section-gap">
      <p className="section-label">Express checkout</p>

      <div className="express-wallets" aria-live="polite">
        {visibleMethods.map((methodId) => (
          <div
            key={methodId}
            className={`express-wallet-slot express-wallet-slot-${getWalletGroup(methodId)}`}
          >
            <div id={`catalyst-express-${checkoutId}-${methodId}`} />
          </div>
        ))}

        {loading &&
          [...Array(4)].map((_, index) => (
            <div key={`skeleton-${index}`} className="express-wallet-slot express-wallet-slot-skeleton" />
          ))}
      </div>

      <div className="divider-row">
        <span className="divider-line" />
        <span className="divider-text">or continue with details below</span>
        <span className="divider-line" />
      </div>

      <span className="sr-only">Express checkout uses your BigCommerce-configured wallet methods in {currencyCode}.</span>
    </div>
  );
}
