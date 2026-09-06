import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { workedPass, START, END } from './worked-pass.mjs';

const SAMPLES = ['samples/kyowon-full.fig', 'samples/matsq.fig'];
const missing = SAMPLES.find((f) => !existsSync(f));
if (missing) {
  // a skip and a pass are indistinguishable to anything reading the exit code
  console.log(`skip — ${missing} not present`);
  process.exit(process.env.CI ? 1 : 0);
}

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

console.log(`ok — worked pass matches, ${inREADME.split('\n').length} generated lines`);
