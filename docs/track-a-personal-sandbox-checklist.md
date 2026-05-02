# Track A Hardening + Personal Sandbox Deployment Checklist

## Scope
This checklist is for validating Track A in a personal GitHub + personal Vercel environment before promoting to client sandbox.

## Code Hardening Included
- Hosted checkout fallback now retries transient failures when requesting `/api/checkout/checkout-url`.
- Headless submit now auto-falls back to hosted checkout for known checkout-session failures.
- Storefront proxy now has timeout + retry handling and safer forwarded headers.
- Checkout submit route now validates payload shape and handles stale checkout IDs cleanly.
- Checkout URL route now validates input, uses timeout + retry, and returns traceable `requestId` on failures.

## Pre-Deployment Guardrails
1. Confirm all secrets are stored in Vercel environment variables, not committed files.
2. Rotate any token that has ever been shared in chat, logs, screenshots, or commits.
3. Keep `BC_MANAGEMENT_TOKEN` server-only.
4. Confirm checkout routes remain server-mediated for BigCommerce APIs.

## Personal GitHub Flow
1. Create a feature branch for hardening:
   - `git checkout -b feat/track-a-hardening`
2. Commit only checkout-related files.
3. Push to your personal fork/repo:
   - `git remote add personal <your-personal-repo-url>` (one time)
   - `git push personal feat/track-a-hardening`
4. Open a PR in personal repo and attach smoke-test evidence.

## Personal Vercel Setup
1. Import your personal repo into Vercel.
2. Set Root Directory to `core`.
3. Add environment variables for Preview + Production:
   - `BIGCOMMERCE_STORE_HASH`
   - `BIGCOMMERCE_CHANNEL_ID`
   - `BIGCOMMERCE_STOREFRONT_API_TOKEN`
   - `BIGCOMMERCE_STOREFRONT_TOKEN`
   - `BC_MANAGEMENT_TOKEN`
   - `BC_STOREFRONT_URL`
   - `CHECKOUT_OFFLINE_METHODS`
   - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
   - `NEXT_PUBLIC_CHECKOUT_GATEWAY_PUBLIC_KEY`
   - `AUTH_SECRET`
4. Redeploy after setting all variables.

## Smoke Test Matrix (Personal Sandbox)
1. Guest checkout reaches shipping and payment.
2. Payment list shows: 1 online + 1 wallet + 3 manual.
3. Manual method order placement succeeds to confirmation page.
4. Online method with headless preflight failure redirects to hosted checkout.
5. Hosted checkout loads payment UI without preview/password gate.
6. Stale checkout ID shows a graceful recovery message (not server crash).

## Promote to Client Sandbox (Cleaner Version)
1. Keep Track A fallback behavior unchanged.
2. Remove temporary diagnostics and tighten user-facing messages.
3. Keep only essential logs (requestId-based errors).
4. Re-run smoke matrix in client sandbox.
5. Cut a clean PR focused on production polish only.
