import type {
  BlogPostSummary,
  CategorySummary,
  PageSummary,
  ProductSummary,
  SlateDataSource,
} from '@integer/slate-runtime';

/**
 * The BigCommerce implementation of `SlateDataSource`.
 *
 * This file is the *only* place Integer code meets BigCommerce, and it lives in the client's
 * repo rather than in our package — which is what ADR 6 buys. When Catalyst changes its data
 * layer, this file changes and nothing else does: published pages, the runtime, and every other
 * client are untouched.
 *
 * Plain `fetch` against the Storefront GraphQL API rather than Catalyst's typed client, so this
 * carries no dependency on `gql.tada` codegen and survives a Catalyst upgrade that reshapes it.
 * Swap it for the native client if you prefer — components never see either.
 */

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH;
const CHANNEL_ID = process.env.BIGCOMMERCE_CHANNEL_ID;
const TOKEN = process.env.BIGCOMMERCE_STOREFRONT_TOKEN;

const ENDPOINT = `https://store-${STORE_HASH}-${CHANNEL_ID}.mybigcommerce.com/graphql`;

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  if (!STORE_HASH || !CHANNEL_ID || !TOKEN) {
    console.warn('[slate] BigCommerce env vars missing — data-backed components render empty');

    return null;
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ query, variables }),
      // Commerce data is BigCommerce's to age; layout is ours and comes from the repo. Keeping
      // the two cache lifetimes independent means a price refresh never waits on a deploy.
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      console.error('[slate] BigCommerce HTTP', res.status);

      return null;
    }

    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };

    if (body.errors?.length) {
      console.error('[slate] BigCommerce GraphQL', body.errors.map((e) => e.message).join('; '));

      return null;
    }

    return body.data ?? null;
  } catch (cause) {
    // A storefront that loses BigCommerce should lose the products on a page, not the page.
    // The runtime collects this as a failure and renders the component's empty state.
    console.error('[slate] BigCommerce unreachable', cause);

    return null;
  }
}

interface ProductNode {
  entityId: number;
  name: string;
  path: string;
  defaultImage?: { url: string } | null;
  prices?: { price?: { formatted: string } } | null;
}

const toProduct = ({ node }: { node: ProductNode }): ProductSummary => ({
  id: String(node.entityId),
  name: node.name,
  path: node.path,
  priceFormatted: node.prices?.price?.formatted ?? '',
  imageAssetId: node.defaultImage?.url,
});

export function makeCatalystDataSource(): SlateDataSource {
  return {
    async getProducts({ categoryId, limit = 8 }): Promise<ProductSummary[]> {
      const data = await gql<{
        site: { category: { products: { edges: Array<{ node: ProductNode }> } } | null };
      }>(
        `query SlateCategoryProducts($id: Int!, $first: Int!) {
          site { category(entityId: $id) { products(first: $first) {
            edges { node {
              entityId name path
              defaultImage { url(width: 400) }
              prices { price { formatted } }
            } }
          } } }
        }`,
        { id: Number(categoryId), first: limit },
      );

      return (data?.site.category?.products.edges ?? []).map(toProduct);
    },

    async getCategory(id): Promise<CategorySummary | null> {
      const data = await gql<{
        site: { category: { entityId: number; name: string; path: string } | null };
      }>(`query SlateCategory($id: Int!) { site { category(entityId: $id) { entityId name path } } }`, {
        id: Number(id),
      });

      const category = data?.site.category;

      return category
        ? { id: String(category.entityId), name: category.name, path: category.path }
        : null;
    },

    async getPage(): Promise<PageSummary | null> {
      // BigCommerce Web Pages are not referenceable from a layout — a page body owned by two
      // systems goes stale in one of them (docs/bigcommerce-content-types.md). Import-once is
      // the supported path, so nothing resolves this at render time.
      return null;
    },

    async getBlogPost(id): Promise<BlogPostSummary | null> {
      const posts = await this.getBlogPosts({ limit: 50 });

      return posts.find((p) => p.id === id) ?? null;
    },

    async getBlogPosts({ limit = 6 }): Promise<BlogPostSummary[]> {
      interface PostNode {
        entityId: number;
        name: string;
        path: string;
        plainTextSummary?: string;
        publishedDate?: { utc: string };
      }

      const data = await gql<{
        site: { content: { blog: { posts: { edges: Array<{ node: PostNode }> } } | null } };
      }>(
        `query SlateBlogPosts($first: Int!) {
          site { content { blog { posts(first: $first) {
            edges { node {
              entityId name path
              plainTextSummary(characterLimit: 180)
              publishedDate { utc }
            } }
          } } } }
        }`,
        { first: limit },
      );

      return (data?.site.content.blog?.posts.edges ?? []).map(({ node }) => ({
        id: String(node.entityId),
        title: node.name,
        path: node.path,
        excerpt: node.plainTextSummary,
        publishedAt: node.publishedDate?.utc,
      }));
    },

    /**
     * Synchronous by contract — an await here would make every image-bearing component async,
     * which is exactly what the declared-data design exists to avoid.
     *
     * BigCommerce returns absolute CDN URLs, so an asset id from the catalogue is usually
     * already a URL. Uploaded assets (ADR 15) will be ids and resolve through the configured
     * storage driver instead.
     */
    getImageUrl(assetId, opts) {
      if (/^https?:\/\//.test(assetId)) return assetId;

      // Uploaded assets (ADR 15): a path under /content on the store's own domain. Domain-free
      // in the JSON so a custom-domain move never invalidates published pages.
      if (assetId.startsWith('slate/')) {
        return `https://store-${STORE_HASH}.mybigcommerce.com/content/${assetId}`;
      }

      const width = opts?.width ? `${opts.width}w` : 'original';

      return `https://cdn11.bigcommerce.com/s-${STORE_HASH}/images/stencil/${width}/${assetId}`;
    },
  };
}
