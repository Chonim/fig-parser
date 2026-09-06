/**
 * Where the sample files live, and what to do when they do not.
 *
 * The convention was copied into eight entry points and one of them — dogfood — had
 * been missed, so `pnpm dogfood` threw where the documents promised a skip. It lives
 * here now, and src/docs.test.mjs runs every command against an empty directory to
 * check that each of them still honours it.
 *
 * SAMPLES_DIR moves the directory, which is how the test empties it without touching
 * the files.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const SAMPLES_DIR = process.env.SAMPLES_DIR || 'samples';
export const PRODUCT = join(SAMPLES_DIR, 'kyowon-full.fig');
export const LIBRARY = join(SAMPLES_DIR, 'matsq.fig');
export const BOTH = [PRODUCT, LIBRARY];

/**
 * Skip when a needed sample is absent — and fail under CI instead, because a skip and
 * a pass look identical to anything reading an exit code.
 */
export function requireSamples(...files) {
  const missing = files.flat().find((f) => !existsSync(f));
  if (!missing) return true;
  console.log(`skip — ${missing} not present`);
  process.exit(process.env.CI ? 1 : 0);
}
