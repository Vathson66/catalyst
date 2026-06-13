# Loan Checkout Process

This document explains how the implemented loan checkout flow moves from a BigCommerce customer metafield to the final hosted checkout payment step, and how rollback protects the merchant from a shopper using temporary loan-backed store credit in another order.

## 1. Loan Source of Truth

Loan eligibility is stored on the BigCommerce customer record as a single customer metafield.

- Namespace: `loan_details`
- Key: `portfolio`
- Value: JSON string

Example:

```json
{
  "active_loan": {
    "loan_reference": "1223456",
    "approved_amount": 1000,
    "status": "Active"
  },
  "history": []
}
```

The storefront only evaluates `active_loan`. Historical loans are not used to approve checkout credit.

Supported operational statuses:

- `Active`: loan is available for selection.
- `Under Processing`: loan has been temporarily converted to BigCommerce store credit for the current checkout handoff.
- `Used`: loan has been consumed by a completed order and should live in `history`.

## 2. Customer Sign-In and Session Persistence

1. Shopper signs in on the Catalyst checkout screen.
2. Catalyst validates the customer credentials through the checkout auth endpoint.
3. After validation succeeds, the checkout client also signs in through the site-wide Auth.js `password` provider.
4. Auth.js writes the storefront session cookie.
5. Header, PLP, home, account pages, and checkout now see the shopper as the same logged-in customer.

This prevents the checkout-only login state from disappearing when the shopper leaves checkout and returns to normal storefront pages.

## 3. Loan Eligibility Load

1. Catalyst loads the BigCommerce checkout session.
2. Catalyst identifies the customer ID from the checkout/auth session.
3. `fetchLoanApproval(customerId)` reads `loan_details.portfolio`.
4. The JSON is parsed and only `active_loan` is evaluated.
5. If the loan is available, the checkout session includes:
   - eligibility flag
   - approved amount
   - current status
   - loan reference
6. The Catalyst checkout UI shows the loan consent/amount controls only when the loan feature is enabled and the customer has an eligible loan.

## 4. Final Total Before Loan Decision

The loan amount is selected only after the checkout has the final customer-facing total.

1. Shopper enters or confirms shipping address.
2. Catalyst posts the shipping address to BigCommerce.
3. Shopper selects a shipping method.
4. Catalyst selects the shipping option and receives updated shipping totals.
5. Catalyst posts the billing address.
6. The billing address route reloads the checkout session from BigCommerce.
7. The refreshed session includes tax, shipping, discounts, coupons already applied before this point, and the final grand total.
8. Loan maximum is calculated against this refreshed grand total.

This means the loan decision is not based on subtotal alone. It is based on the final known checkout amount before hosted payment handoff.

## 5. Applying the Loan

When the shopper continues to payment with loan selected, Catalyst calls `/api/checkout/apply-loan`.

Server sequence:

1. Validate request payload:
   - checkout ID is required
   - requested loan amount is required
   - customer ID must resolve to a signed-in customer
2. Reload the latest checkout session from BigCommerce.
3. Read the customer `loan_details.portfolio` metafield.
4. Validate:
   - `active_loan` exists
   - `active_loan.status` is `Active`
   - requested amount is no more than approved amount
   - requested amount is no more than current checkout grand total
5. Read the customer current BigCommerce store credit balance.
6. If the customer has existing store credit, post a negative store-credit adjustment to bring the balance to zero.
7. Post a BigCommerce store-credit adjustment for exactly the requested loan amount.
8. Update `active_loan.status` in the metafield to `Under Processing`.
9. Return applied amount, residual amount, loan reference, and status to the checkout client.

Important guard: if store credit is created but the metafield cannot be updated to `Under Processing`, Catalyst clears the store credit back to zero and returns an error. This avoids leaving spendable store credit on the customer record without a matching locked loan state.

## 6. Hosted Checkout Handoff

1. After `/api/checkout/apply-loan` succeeds, Catalyst creates the hosted checkout handoff token.
2. Shopper is redirected to the hosted checkout assets served from `core/public/checkout-js`.
3. Customized checkout-js loads the BigCommerce checkout.
4. Because the customer now has temporary store credit equal to the selected loan amount, checkout-js auto-applies it.
5. The UI labels this as `Loan Amount` / `Loan Adjustment`, not `Store Credit`.
6. The manual store-credit control is hidden.
7. The final payment-step coupon/gift redeemable field is hidden so the shopper cannot change the payable amount after the loan decision.
8. The shopper pays any remaining residual balance through the normal payment method.

Applied discounts and summaries can still display, but the final payment step does not provide a new coupon entry point.

## 7. Merchant Protection Rollback

Temporary loan-backed store credit is risky because BigCommerce store credit belongs to the customer account, not only to one checkout. Without cleanup, the shopper could abandon the loan checkout and try to spend that credit in a different cart/order.

The implementation protects against that with reset paths.

### Page Abandonment Reset

After a loan is applied, the checkout client registers a `pagehide` handler.

If the shopper leaves the Catalyst checkout page and the app is not intentionally redirecting to hosted checkout, the client sends a keepalive reset request:

```json
{
  "checkoutId": "current checkout id",
  "customerId": 1
}
```

The reset endpoint then:

1. Resolves the customer ID from the request, or from the checkout session if needed.
2. Reads the current BigCommerce customer store credit balance.
3. Posts a negative store-credit adjustment to clear the balance to zero.
4. Updates `active_loan.status` back to `Active`.
5. Returns applied amount `0`.

### Explicit Reset Endpoint

`/api/checkout/reset-loan` can also be called by future cart-modification or checkout-cancel flows. Its job is always the same:

1. zero out customer store credit
2. restore the active loan status to `Active`

### Checkout Guard

`/api/checkout/apply-loan` always clears existing store credit before applying the selected amount. This protects the merchant if a prior reset did not complete because of network interruption or browser shutdown.

The next attempt does not stack a new loan amount on top of stale customer credit.

## 8. Successful Order Completion

The current checkout implementation prepares and locks the loan for payment. Final one-and-done completion belongs to the post-order process described in the loan specification.

Expected order-created process:

1. External loan/order listener receives `order.created`.
2. Listener reads the customer `loan_details.portfolio` metafield.
3. Listener confirms the relevant `active_loan` is `Under Processing`.
4. Listener moves `active_loan` into `history`.
5. Listener records the utilized amount from the actual order/store-credit usage.
6. Listener marks the history record as `Used`.
7. Listener sets top-level `active_loan` to `null`.

That final step enforces the one-and-done rule: unused approved funds do not roll over after the order is completed.

## 9. Failure and Recovery Rules

- If credentials validate in checkout but Auth.js sign-in fails, the shopper is not allowed to continue as a persisted logged-in customer.
- If no signed-in customer ID is available, loan application is rejected.
- If loan status is not `Active`, loan application is rejected.
- If requested amount exceeds approval or final grand total, loan application is rejected.
- If stale store credit exists, it is cleared before the new amount is applied.
- If metafield locking fails after store credit is applied, store credit is cleared immediately.
- If the shopper abandons before hosted checkout handoff, reset clears store credit and restores loan status.
- If hosted checkout handoff is intentional, reset is skipped so checkout-js can use the temporary credit.

## 10. Implementation Map

Catalyst files:

- `core/app/[locale]/(default)/checkout/CheckoutClient.tsx`: checkout UI, Auth.js persistence, final handoff, reset beacon.
- `core/app/api/checkout/billing-address/route.ts`: billing update and final session reload.
- `core/app/api/checkout/apply-loan/route.ts`: loan validation, store-credit creation, loan status lock.
- `core/app/api/checkout/reset-loan/route.ts`: rollback store credit and loan status.
- `core/lib/checkout/bc-api/customer-metafields.ts`: loan metafield read/update.
- `core/lib/checkout/bc-api/customer-store-credit.ts`: BigCommerce customer store-credit read/adjust/clear.
- `core/lib/checkout/sdk-adapter.ts`: client SDK wrapper for checkout API calls.

checkout-js files:

- `checkout-js/packages/core/src/app/payment/Payment.tsx`: auto-applies usable customer store credit.
- `checkout-js/packages/core/src/app/payment/PaymentRedeemables.tsx`: hides final payment-step redeemable entry.
- `checkout-js/packages/locale/src/translations/en.json`: labels store credit as loan amount/loan adjustment.
- `core/public/checkout-js`: built hosted checkout assets served by Catalyst/Vercel.
