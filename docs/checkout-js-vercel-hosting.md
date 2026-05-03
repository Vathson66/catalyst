# Checkout-js Hosting on Vercel

## Decision

Custom checkout-js assets are hosted from the Catalyst Vercel deployment, not WebDAV.

## How it works

During `core` build, the script `core/scripts/prepare-checkout-assets.cjs`:

1. Ensures checkout-js is built (or reuses existing `checkout-js/dist` output).
2. Copies full checkout-js `dist` contents to `core/public/checkout-js`.
3. Logs the recommended BigCommerce Custom Checkout script URL path.

Because files are under `core/public`, Next.js serves them as static assets from the Catalyst domain.

## BigCommerce Custom Checkout field

Enter the full URL to the auto-loader script file, for example:

- `https://catalyst-core-arizondigital.vercel.app/checkout-js/auto-loader-1.782.3.js`

Do not enter:

- storefront page URLs
- folder-only URLs
- non-autoloader files

## Local validation

Run:

```sh
cd core
npm run checkout:prepare-assets
```

Then check:

- `core/public/checkout-js/auto-loader-1.782.3.js`
- `core/public/checkout-js/manifest-1.782.3.json`

## Notes

- Full `dist` copy is required because the autoloader fetches manifests and chunks dynamically.
- `core/public/checkout-js` is generated at build time and should not be edited manually.
- Set `SKIP_CHECKOUT_JS_ASSETS=true` to skip this step when needed.
