import { notFound } from 'next/navigation';

import {
  createBuiltinRegistry,
  createEnvironment,
  emptyDataSource,
  RenderPage,
} from '@integer/slate-runtime';

import { loadLayoutForPath } from '~/lib/slate/load-layout';

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

// The scheduling proof needs no commerce data, so the data source is the empty one. Wiring the
// real BigCommerce implementation is a separate step and a separate risk.
const env = createEnvironment({
  registry,
  dataSource: emptyDataSource,
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

  const document = await loadLayoutForPath(slug);

  if (!document) notFound();

  return <RenderPage document={document} env={env} />;
}
