import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  candidateFilePaths,
  migrateToCurrent,
  resolveActiveDocument,
  validatePageDocument,
  type PageDocument,
} from '@integer/slate-runtime';

// Layout files ship in the repo, so they are on disk — no fetch, no database, nothing on
// Integer infrastructure (ADR 4).
const REPO_ROOT = process.cwd();

async function readDocument(relativePath: string): Promise<PageDocument | null> {
  let raw: string;

  try {
    raw = await readFile(join(REPO_ROOT, relativePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const migrated = migrateToCurrent(JSON.parse(raw) as unknown);

  if (!migrated.success) {
    console.error('[slate] cannot migrate', { relativePath, errors: migrated.errors });

    return null;
  }

  const validated = validatePageDocument(migrated.data);

  if (!validated.success) {
    console.error('[slate] invalid document', { relativePath, errors: validated.errors });

    return null;
  }

  return validated.data as PageDocument;
}

export async function loadCandidates(slug: string): Promise<PageDocument[]> {
  const documents = await Promise.all(candidateFilePaths(slug).map(readDocument));

  return documents.filter((d): d is PageDocument => d !== null);
}

export async function loadLayoutForPath(
  slug: string,
  now = new Date(),
): Promise<PageDocument | null> {
  const candidates = await loadCandidates(slug);

  if (candidates.length === 0) return null;

  return resolveActiveDocument(candidates, { now });
}
