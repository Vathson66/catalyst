# Checkout Restart Plan

## Goal
Build a checkout experience where shoppers stay in our headless flow through shipping and billing, and complete payment with the least friction possible.

Target storefront route:
- https://store-vwxr0mrjlq-1852707.catalyst-sandbox-vercel.store/checkout

## Constraints
- Do not bypass BigCommerce payment processing.
- Keep BigCommerce checkout/cart objects as the source of truth.
- Support card payments safely (hosted fields/tokenization, no raw PAN handling).

## Current Status
- Added BigCommerce checkout-js source as a git submodule at `checkout-js/`.
- Submodule points to upstream commit `a18b55e` (tag lineage v1.782.3).

## Architecture Tracks

### Track A (Preferred): Fully Headless Payment On Same Domain
Use BigCommerce checkout SDK payment strategies directly in our custom payment step.

What this means:
- Keep guest/sign-in, shipping, shipping option selection, and billing in current headless UI.
- Render payment method UI in our app.
- For card methods, mount provider hosted fields in our page and submit through BC checkout SDK.
- Place order from our page without redirecting to hosted checkout.

Why preferred:
- Single-domain continuity.
- No second UI handoff.
- Best match for the product requirement.

Risks:
- Gateway-specific strategy wiring and validation details.
- Wallets may still require external flows depending on provider.

### Track B (Fallback): Payment-Only checkout-js On Subdomain
Use a customized checkout-js deployment that focuses on payment and place-order only.

What this means:
- Keep headless page for customer, shipping, and billing.
- After "Continue to payment", redirect to custom checkout-js domain with checkout context.
- checkout-js page is stripped to payment review/place-order surfaces.

Why fallback:
- Uses battle-tested BC payment orchestration with less custom payment logic.
- Faster route if Track A hits gateway limitations.

Risks:
- Domain handoff still exists.
- Requires separate build/deploy and theme-level customization.

## Execution Plan

### Phase 1: Implement Track A Prototype
1. Replace non-manual redirect path with BC SDK payment submission in payment step.
2. Introduce hosted fields renderer for card strategy.
3. Validate with test card mode in BC.
4. Verify full order placement without hosted-checkout redirect.

Exit criteria:
- Card payment success/failure handled fully in headless page.
- No redirect for card flow.

### Phase 2: Decide Keep Track A or Switch to Track B
- If Track A passes gateway and UX constraints, continue Track A to production.
- If blocked, move to Track B with payment-only checkout-js customization.

## Immediate Next Actions
1. Create a feature branch for restart implementation.
2. Build card strategy spike in existing payment step.
3. Keep checkout-js submodule ready as fallback implementation base.
