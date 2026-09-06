import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workedPass, START, END } from './worked-pass.mjs';
import { BOTH, requireSamples } from './samples.mjs';
import { check } from './docs-check.mjs';

requireSamples(BOTH);

const readme = readFileSync('README.md', 'utf8');

// --- the worked pass is generated, so it cannot be edited into a lie ---
// One of the three errors this suite exists for was an example searching for a string
// the frame does not contain. Nobody ran it. This regenerates the block from the live
// server and compares: edit the README by hand and it fails, change what a tool answers
// and it fails until the README is regenerated.
const before = readme.indexOf(START);
const after = readme.indexOf(END);
assert.ok(before >= 0 && after > before, 'README.md has lost its worked-pass markers');
const inREADME = readme.slice(before + START.length, after).trim();
const generated = (await workedPass()).trim();
assert.equal(
  inREADME,
  generated,
  'the README\'s worked pass is not what the tools answer — run `node src/worked-pass.mjs --write`',
);

// --- the paths the documents point at ---
for (const [path, doc] of [['docs/gnb-from-ir.html', 'README.md'], ['REFS.md', 'README.md']]) {
  assert.ok(existsSync(path), `${doc} points at ${path}, which is not there`);
}
// refs/ is the one path that is correct while absent: the images are the user's to
// supply, so the documents have to say that rather than assume they exist
if (!existsSync('refs')) {
  assert.match(readme, /no reference image|refs\//, 'refs/ is absent and the README does not say so');
  assert.match(readFileSync('REFS.md', 'utf8'), /gitignore/, 'REFS.md does not say the references are not committed');
}
assert.match(readFileSync('.gitignore', 'utf8'), /^samples\/\*\.fig$/m, 'the samples are no longer gitignored');

// --- the figures the documents name, recomputed ---
// Scraping numbers out of prose finds false positives, so a figure meant to be checked
// carries a `fig:key=value` marker and docs-check.mjs measures the key. Totals come
// from census and the dogfood counts from dogfood, rather than being counted a second
// time here — two implementations of "how many nodes is this" disagreed by 211 on the
// first attempt.
const { claims, wrong, unknown } = await check();
assert.ok(claims.length >= 25, `only ${claims.length} figures in the documents are marked for checking`);
assert.deepEqual(unknown.map((u) => `${u.doc}:${u.line} fig:${u.key}`), [], 'a document marks a figure nothing measures');
assert.deepEqual(
  wrong.map((w) => `${w.doc}:${w.line} fig:${w.key} says ${w.said}, is ${w.is}`),
  [],
  'a document states a figure that is no longer true',
);

// --- every command skips when the samples are not there ---
// The documents promise it and dogfood did not do it. Rather than moving the files,
// the sample directory is pointed at an empty one, which is what the entry points read.
const empty = mkdtempSync(join(tmpdir(), 'fig-nosamples-'));
const COMMANDS = [
  ['node', 'src/parse.test.mjs'],
  ['node', 'src/components.test.mjs'],
  ['node', 'src/mcp.test.mjs'],
  ['node', 'src/docs.test.mjs'],
  ['node', 'src/census.mjs'],
  ['node', 'src/reach.mjs'],
  ['node', 'src/diff.mjs'],
  ['node', 'src/dogfood.mjs'],
  ['node', 'src/worked-pass.mjs'],
];
for (const [cmd, ...args] of COMMANDS) {
  const run = (env) => spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, SAMPLES_DIR: empty, ...env } });
  const quiet = run({ CI: '' });
  assert.match(`${quiet.stdout}${quiet.stderr}`, /^skip — /m, `${args[0]} does not skip without samples: ${(quiet.stderr || quiet.stdout).split('\n')[0]}`);
  assert.equal(quiet.status, 0, `${args[0]} exited ${quiet.status} while skipping`);
  const strict = run({ CI: '1' });
  assert.equal(strict.status, 1, `${args[0]} exited ${strict.status} under CI=1 with no samples`);
}
rmSync(empty, { recursive: true, force: true });

console.log(`ok — worked pass matches, ${claims.length} figures re-derived, ${COMMANDS.length} commands skip cleanly`);
