import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CONFIG_DIR, type SlateTokensFile } from '@integer/slate-runtime';

/**
 * Reads this client's design tokens. The runtime resolves every token to a CSS custom
 * property, so this file is where the brand actually enters the page — change the JSON,
 * redeploy, and every Slate page restyles with no page edits (ADR 8).
 */
export async function loadTokens(): Promise<SlateTokensFile> {
  try {
    const raw = await readFile(join(process.cwd(), CONFIG_DIR, 'tokens.json'), 'utf8');

    return JSON.parse(raw) as SlateTokensFile;
  } catch {
    // Degrade rather than throw: the baseline styles carry fallbacks for every value, so a
    // missing tokens file gives a plain page instead of taking the route down.
    console.warn('[slate] no content/config/tokens.json — using baseline fallbacks');

    return {};
  }
}
