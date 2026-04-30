'use client';

/**
 * HostedCardFields
 *
 * Renders BC Checkout SDK hosted card fields — card data is collected inside
 * BC-hosted iframes and tokenized directly with BC's payment processor.
 * The card number, expiry and CVV never touch our server or JavaScript context.
 *
 * PCI DSS SAQ A compliant: all cardholder data stays inside the iframes.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  createCheckoutService,
  HostedFieldType,
  type CheckoutService,
} from '@bigcommerce/checkout-sdk';

export interface HostedCardFieldsHandle {
  /** Creates the BC order and submits payment. Returns the BC order ID. */
  submitPayment(): Promise<{ orderId: number }>;
}

interface Props {
  checkoutId: string;
  /** BC gateway method ID for the credit-card method (e.g. "authorizenet") */
  methodId: string;
  gatewayId?: string;
  onReady?: () => void;
  onError?: (error: string) => void;
}

const HostedCardFields = forwardRef<HostedCardFieldsHandle, Props>(
  function HostedCardFields({ checkoutId, methodId, gatewayId, onReady, onError }, ref) {
    const serviceRef = useRef<CheckoutService | null>(null);
    const mountedRef = useRef(false);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // Expose submitPayment to parent via ref
    useImperativeHandle(ref, () => ({
      async submitPayment() {
        const service = serviceRef.current;
        if (!service) throw new Error('Payment not initialized');

        // submitOrder with hosted card data — the SDK pulls the tokenized card
        // from the BC-hosted iframes. Raw card data never passes through our code.
        const state = await service.submitOrder({
          payment: {
            methodId,
            gatewayId,
            paymentData: { shouldSaveInstrument: false },
          },
        });

        const orderId = state.data.getOrder()?.orderId;
        if (!orderId) throw new Error('Order ID not returned after payment');
        return { orderId };
      },
    }));

    const init = useCallback(async () => {
      if (mountedRef.current) return;
      mountedRef.current = true;

      try {
        // The BC Checkout SDK will call /api/storefront/* which our proxy
        // forwards to the BC storefront origin via core/app/api/storefront/[...path]/route.ts
        const service = createCheckoutService();
        serviceRef.current = service;

        await service.loadCheckout(checkoutId);
        await service.loadPaymentMethods();

        await service.initializePayment({
          methodId,
          gatewayId,
          creditCard: {
            form: {
              fields: {
                [HostedFieldType.CardName]: { containerId: 'hf-card-name' },
                [HostedFieldType.CardNumber]: { containerId: 'hf-card-number' },
                [HostedFieldType.CardExpiry]: { containerId: 'hf-card-expiry' },
                [HostedFieldType.CardCode]: { containerId: 'hf-card-cvv' },
              },
              styles: {
                default: {
                  color: 'var(--ink, #1a1a1a)',
                  fontSize: '16px',
                  fontFamily:
                    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                },
                error: { color: '#dc2626' },
                focus: { color: 'var(--ink, #1a1a1a)' },
              },
            },
          },
        });

        setStatus('ready');
        onReady?.();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Payment fields failed to load';
        console.error('[HostedCardFields] init error:', err);
        setStatus('error');
        setErrorMessage(msg);
        onError?.(msg);
      }
    }, [checkoutId, methodId, gatewayId, onReady, onError]);

    useEffect(() => {
      void init();

      return () => {
        serviceRef.current
          ?.deinitializePayment({ methodId, gatewayId })
          .catch(() => {/* cleanup — ignore errors on unmount */});
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const isLoading = status === 'loading';
    const isError = status === 'error';

    return (
      <div className="hosted-fields-wrap">
        {isLoading && (
          <div className="hosted-fields-loading">Loading secure card fields…</div>
        )}

        {isError && (
          <div className="hosted-fields-unavailable">
            <p><strong>Could not load secure card fields</strong></p>
            {errorMessage && <p style={{ fontSize: 13, marginTop: 4 }}>{errorMessage}</p>}
          </div>
        )}

        {/* Containers are always in the DOM so the SDK can mount into them */}
        <div style={{ display: isError ? 'none' : 'block' }}>
          <div className="form-row">
            <label className="form-field form-field-full">
              <span className="field-label">Name on card</span>
              <div
                id="hf-card-name"
                className="field-input hosted-field-container"
                aria-label="Name on card"
              />
            </label>
          </div>

          <div className="form-row">
            <label className="form-field form-field-full">
              <span className="field-label">Card number</span>
              <div
                id="hf-card-number"
                className="field-input hosted-field-container"
                aria-label="Card number"
              />
            </label>
          </div>

          <div className="form-row form-row-cols">
            <label className="form-field">
              <span className="field-label">Expiry</span>
              <div
                id="hf-card-expiry"
                className="field-input hosted-field-container"
                aria-label="Expiry date"
              />
            </label>
            <label className="form-field">
              <span className="field-label">Security code</span>
              <div
                id="hf-card-cvv"
                className="field-input hosted-field-container"
                aria-label="CVV"
              />
            </label>
          </div>
        </div>
      </div>
    );
  },
);

export default HostedCardFields;
