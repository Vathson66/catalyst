'use client';

import { useEffect, useMemo, useState } from 'react';

import type { SdkPaymentMethod } from '~/lib/checkout/sdk-adapter';

interface HostedExpressWalletsProps {
  checkoutId: string;
  disabled?: boolean;
  onError(message: string | null): void;
  onLaunch(method: SdkPaymentMethod): void | Promise<void>;
}

const EXPRESS_METHOD_ORDER = ['applepay', 'googlepay', 'paypal'] as const;

function isSupportedExpressMethod(method: SdkPaymentMethod): boolean {
  return (
    method.method === 'applepay' ||
    method.method === 'googlepay' ||
    method.method === 'paypal'
  );
}

function dedupeExpressMethods(methods: SdkPaymentMethod[]): SdkPaymentMethod[] {
  const seen = new Set<string>();

  return methods
    .filter(isSupportedExpressMethod)
    .sort((left, right) => {
      return (
        EXPRESS_METHOD_ORDER.indexOf(left.method as (typeof EXPRESS_METHOD_ORDER)[number]) -
        EXPRESS_METHOD_ORDER.indexOf(right.method as (typeof EXPRESS_METHOD_ORDER)[number])
      );
    })
    .filter((method) => {
      if (seen.has(method.method)) {
        return false;
      }

      seen.add(method.method);
      return true;
    });
}

function getButtonLabel(method: SdkPaymentMethod): string {
  switch (method.method) {
    case 'applepay':
      return 'Apple Pay';
    case 'googlepay':
      return 'Google Pay';
    case 'paypal':
      return 'PayPal';
    default:
      return method.name;
  }
}

function getButtonClassName(method: SdkPaymentMethod): string {
  switch (method.method) {
    case 'applepay':
      return 'express-wallet-launch-applepay';
    case 'googlepay':
      return 'express-wallet-launch-googlepay';
    case 'paypal':
      return 'express-wallet-launch-paypal';
    default:
      return '';
  }
}

export function HostedExpressWallets({
  checkoutId,
  disabled = false,
  onError,
  onLaunch,
}: HostedExpressWalletsProps) {
  const [loading, setLoading] = useState(true);
  const [methods, setMethods] = useState<SdkPaymentMethod[]>([]);

  const visibleMethods = useMemo(() => dedupeExpressMethods(methods), [methods]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(
          `/api/checkout/payment-methods?checkoutId=${encodeURIComponent(checkoutId)}`,
        );
        const payload = (await res.json()) as {
          methods?: SdkPaymentMethod[];
          error?: string;
        };

        if (!res.ok) {
          throw new Error(payload.error ?? 'Could not load express checkout options.');
        }

        if (!cancelled) {
          setMethods(payload.methods ?? []);
          onError(null);
        }
      } catch (error) {
        if (!cancelled) {
          onError(
            error instanceof Error
              ? error.message
              : 'Could not load express checkout options.',
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checkoutId, onError]);

  if (!loading && visibleMethods.length === 0) {
    return null;
  }

  return (
    <div className="card section-gap">
      <p className="section-label">Express checkout</p>

      <div className="express-wallets" aria-live="polite">
        {loading
          ? EXPRESS_METHOD_ORDER.map((method) => (
              <div
                key={`express-skeleton-${method}`}
                className="express-wallet-slot express-wallet-slot-skeleton"
              />
            ))
          : visibleMethods.map((method) => (
              <div
                key={method.id}
                className={`express-wallet-slot express-wallet-slot-${method.method}`}
              >
                <button
                  type="button"
                  className={`express-wallet-launch ${getButtonClassName(method)}`.trim()}
                  disabled={disabled}
                  onClick={() => {
                    onError(null);
                    void onLaunch(method);
                  }}
                >
                  {getButtonLabel(method)}
                </button>
              </div>
            ))}
      </div>

      <div className="divider-row">
        <span className="divider-line" />
        <span className="divider-text">or continue with details below</span>
        <span className="divider-line" />
      </div>
    </div>
  );
}
