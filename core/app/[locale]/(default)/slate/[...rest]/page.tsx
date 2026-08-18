import { notFound } from 'next/navigation';

import {
  collectDataRequests,
  createBuiltinRegistry,
  createEnvironment,
  emptyDataSource,
  RenderPage,
  resolvePageData,
  SlateBaseStyles,
  SlateTokens,
} from '@integer/slate-runtime';

import { makeCatalystDataSource } from '~/lib/slate/data-source';
import { loadLayoutForPath } from '~/lib/slate/load-layout';
import { loadTokens } from '~/lib/slate/tokens';

/**
 * Integer Slate boundary route (Phase 3 proof).
 *
 * Mounted under /slate/* rather than at the site catch-all, because this repo is
 * catalyst-makeswift and Makeswift already owns `[...rest]`. Nothing here touches that route.
 *
 * Rendered on demand rather than statically with ISR. Catalyst's `(default)` storefront layout
 * reads cookies and headers (cart, auth, customer group), so a page underneath it cannot be
 * statically generated — `export const revalidate` produces DYNAMIC_SERVER_USAGE at request
 * time. Every other storefront route in this app is dynamic for the same reason.
 *
 * Clock-based scheduling (ADR 2) is unaffected, and in fact sharper: each request re-reads the
 * layout files and re-checks the clock, so a scheduled page activates on the first request
 * after `activeFrom` instead of within an ISR window.
 */
export const dynamic = 'force-dynamic';

const registry = createBuiltinRegistry();

// Real BigCommerce. The Slate canvas reads the same catalogue through its own implementation,
// so what a merchant approves in the builder is what a shopper gets (ADR 14).
const env = createEnvironment({
  registry,
  dataSource: makeCatalystDataSource(),
  onWarning: (event) => console.warn('[slate]', event.message, event),
});

interface PageParams {
  locale: string;
  rest: string[];
}

export async function generateStaticParams(): Promise<PageParams[]> {
  // Deliberately empty: pages are resolved on demand so a scheduled variant can activate
  // without a rebuild. Returning a fixed list here would freeze which slugs exist at build.
  return [];
}

export default async function SlatePage({ params }: { params: Promise<PageParams> }) {
  const { rest } = await params;
  const slug = `/${(rest ?? []).join('/')}`;

  const [document, tokens] = await Promise.all([loadLayoutForPath(slug), loadTokens()]);

  if (!document) notFound();

  // Components declare their data needs in their manifests; the runtime resolves everything in
  // one parallel pass. This is the only await in the render path -- everything after it is
  // synchronous, which is what lets the Slate canvas render the identical tree client-side.
  const requests = collectDataRequests(document, registry);
  const data = await resolvePageData(requests, env.dataSource);

  for (const { request, error } of data.failures) {
    console.error('[slate] data request failed', { slug, request, error });
  }

  return (
    <>
      {/* The client's brand, as CSS custom properties. Scoped to :root so nested nodes inherit. */}
      <SlateTokens tokens={tokens} />
      {/* Baseline presentation for the built-in components — every value falls back, so this
          renders coherently even before tokens exist. */}
      <SlateBaseStyles />
      <RenderPage document={document} env={env} data={data} />
    </>
  );
}
