import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  blogPostsFromDocuments,
  migrateToCurrent,
  validatePageDocument,
  type BlogPostSummary,
  type PageDocument,
} from '@integer/slate-runtime';

/**
 * Slate-authored blog posts, read from the repo (ADR 26).
 *
 * A post is a page document under content/pages/blog/ whose activeFrom is its publish date.
 * The runtime turns those into the same BlogPostSummary shape BigCommerce produces, so
 * `blogPostList` never knows which source an article came from — that is what lets a store
 * migrate from BC-authored to Slate-authored one post at a time.
 */

// This storefront mounts Slate at /slate (Makeswift owns the root catch-all), so a post whose
// slug is /blog/x is reachable at /slate/blog/x. On a stock Catalyst repo this prefix is ''.
const MOUNT = '/slate';

export async function loadRepoBlogPosts(limit = 20): Promise<BlogPostSummary[]> {
  const dir = join(process.cwd(), 'content', 'pages', 'blog');

  let files: string[];

  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no blog folder yet = no Slate-authored posts, not an error
  }

  const documents: PageDocument[] = [];

  for (const file of files) {
    try {
      const migrated = migrateToCurrent(JSON.parse(await readFile(join(dir, file), 'utf8')));
      if (!migrated.success) continue;

      const validated = validatePageDocument(migrated.data);
      if (validated.success) documents.push(validated.data as PageDocument);
    } catch {
      // One malformed post must not empty the blog.
    }
  }

  return blogPostsFromDocuments(documents, { limit }).map((post) => ({
    ...post,
    path: `${MOUNT}${post.path}`,
  }));
}
