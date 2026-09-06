#!/usr/bin/env node
/**
 * Re-derives every figure the documents put a name on.
 *
 * Scraping numbers out of prose finds false positives — a depth histogram written
 * "깊이 1:1311 2:303" reads as frame ids, and "50 hidden instances painted" is an
 * account of a fixed defect rather than a current count. So a figure that is meant to
 * be checked carries a marker — the prefix, a measurement key, `=`, and the value —
 * anywhere on its line. Everything else in the documents is prose, deliberately.
 *
 * Writing the marker's own shape into a document makes that document fail, which is
 * how this rule was found: CLAIMS.md explained the convention by example and the
 * example was read as a claim about a measurement called "key".
 *
 *   pnpm docs:check
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseFigFile, buildTree, collectFrames } from './parse.mjs';
import { toIR, symbolIndex, variableIndex } from './ir.mjs';
import { measureReach } from './reach.mjs';
import { PRODUCT, LIBRARY, BOTH, requireSamples } from './samples.mjs';
import { TOOLS } from './mcp.mjs';

const DOCS = ['README.md', 'CLAUDE.md', 'TASKS.md', 'REFS.md', 'CLAIMS.md'];

/** what the files say, measured now */
export async function measure() {
  const guid = (g) => `${g.sessionID}:${g.localID}`;
  const per = {};
  for (const [file, tag] of [[PRODUCT, 'kyowon'], [LIBRARY, 'matsq']]) {
    const { message } = parseFigFile(file);
    const roots = buildTree(message.nodeChanges);
    const ctx = { symbols: symbolIndex(roots), variables: variableIndex(message.nodeChanges) };
    const frames = collectFrames(roots);
    let groups = 0, derivedEntries = 0, derivedInstances = 0, nestedPaths = 0;
    for (const n of message.nodeChanges) {
      if (n.type === 'FRAME' && n.resizeToFit === true) groups += 1;
      if (n.derivedSymbolData?.length) {
        derivedInstances += 1;
        derivedEntries += n.derivedSymbolData.length;
        nestedPaths += n.derivedSymbolData.filter((d) => d.guidPath.guids.length > 1).length;
      }
    }
    // raw and IR totals come from census rather than being counted again here: two
    // implementations of "how many nodes is this" disagreed by 211 on the first try,
    // and a test that re-counts what it is checking only ever agrees with itself
    const summary = spawnSync('node', [new URL('./census.mjs', import.meta.url).pathname, file], { encoding: 'utf8' });
    const totals = summary.stdout.match(/(\d+) frames, (\d+) raw nodes, (\d+) IR nodes/);
    if (!totals) throw new Error(`census said nothing countable for ${file}: ${summary.stdout.slice(0, 200)}`);
    const [, , raw, ir] = totals.map(Number);
    let autolayout = 0, overflow = 0, hugCross = 0, centred = 0;
    for (const fr of frames) {
      (function w(n) {
        if (n.layout?.source === 'auto-layout') {
          autolayout += 1;
          if (n.layout.overflow) overflow += 1;
          if (n.layout.hug?.cross) hugCross += 1;
        }
        if (n.style?.border?.align === 'CENTER' && n.style.border.css) centred += 1;
        n.children?.forEach(w);
      })(toIR(fr, message.blobs, ctx));
    }
    void guid;
    const reach = await measureReach(file);
    per[tag] = { frames: frames.length, raw, ir, groups, derivedEntries, derivedInstances, nestedPaths,
      autolayout, overflow, hugCross, centred,
      reachText: reach.text, reachTextTotal: reach.textTotal, reachNodes: reach.nodes, reachNodeTotal: reach.nodeTotal,
      slack: reach.slack, truncated: reach.truncated };
    if (tag === 'kyowon') {
      const roots2 = buildTree(message.nodeChanges);
      const login = collectFrames(roots2).find((f) => f.name === '온라인학습_Login');
      const lir = toIR(login, message.blobs, ctx);
      per.login = {
        raw: (function c(n) { return 1 + (n.children ?? []).reduce((a, k) => a + c(k), 0); })(login),
        ir: (function c(n) { return 1 + (n.children ?? []).reduce((a, k) => a + c(k), 0); })(lir),
        logoPaths: (function find(n) {
          if (n.asset?.kind === 'svg' && n.asset.paths.length > 10) return n.asset.paths.length;
          for (const c of n.children ?? []) { const hit = find(c); if (hit) return hit; }
          return 0;
        })(lir),
      };
    }
  }
  // the dogfood comparison is its own command; read it rather than re-running the idea
  const df = spawnSync('node', [new URL('./dogfood.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  const drilling = df.stdout.match(/drilling with select\s+(\d+) calls/);
  const searching = df.stdout.match(/find_nodes\s+(\d+) calls/);
  if (!drilling || !searching) throw new Error(`dogfood said nothing countable: ${df.stdout.slice(0, 200)}`);

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  return {
    'kyowon.raw': per.kyowon.raw,
    'kyowon.ir': per.kyowon.ir,
    'kyowon.groups': per.kyowon.groups,
    'kyowon.frames': per.kyowon.frames,
    'kyowon.reach.text': `${per.kyowon.reachText}/${per.kyowon.reachTextTotal}`,
    'kyowon.reach.nodes': `${per.kyowon.reachNodes}/${per.kyowon.reachNodeTotal}`,
    'matsq.raw': per.matsq.raw,
    'matsq.ir': per.matsq.ir,
    'matsq.frames': per.matsq.frames,
    'matsq.derived.entries': per.matsq.derivedEntries,
    'matsq.derived.instances': per.matsq.derivedInstances,
    'matsq.derived.nested': per.matsq.nestedPaths,
    'matsq.autolayout': per.matsq.autolayout,
    'matsq.overflow': per.matsq.overflow,
    'matsq.hug.cross': per.matsq.hugCross,
    'matsq.reach.text': `${per.matsq.reachText}/${per.matsq.reachTextTotal}`,
    'matsq.reach.nodes': `${per.matsq.reachNodes}/${per.matsq.reachNodeTotal}`,
    'matsq.slack': per.matsq.slack,
    'centred.strokes': per.kyowon.centred + per.matsq.centred,
    'login.raw': per.login.raw,
    'login.ir': per.login.ir,
    'login.logo.paths': per.login.logoPaths,
    'deps.runtime': Object.keys(pkg.dependencies).length,
    'tools.count': TOOLS.length,
    'dogfood.drilling': Number(drilling[1]),
    'dogfood.searching': Number(searching[1]),
  };
}

/** every `fig:key value` a document marks for checking */
export function marked(docs = DOCS) {
  const out = [];
  for (const doc of docs) {
    const text = readFileSync(doc, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/fig:([\w.]+)=(\S+?)(?=[\s)\]|,]|$)/g)) {
        out.push({ doc, line: i + 1, key: m[1], said: m[2] });
      }
    });
  }
  return out;
}

export async function check(docs = DOCS) {
  const truth = await measure();
  const claims = marked(docs);
  const wrong = [];
  const unknown = [];
  for (const c of claims) {
    if (!(c.key in truth)) { unknown.push(c); continue; }
    if (String(truth[c.key]) !== c.said) wrong.push({ ...c, is: truth[c.key] });
  }
  return { truth, claims, wrong, unknown };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  requireSamples(BOTH);
  const { truth, claims, wrong, unknown } = await check();
  const width = Math.max(...Object.keys(truth).map((k) => k.length));
  for (const [k, v] of Object.entries(truth)) console.log(`  ${k.padEnd(width)}  ${v}`);
  console.log(`\n${claims.length} marked figures in the documents`);
  for (const u of unknown) console.log(`  ? ${u.doc}:${u.line} fig:${u.key} — nothing measures that`);
  for (const w of wrong) console.log(`  ✗ ${w.doc}:${w.line} fig:${w.key} says ${w.said}, is ${w.is}`);
  if (wrong.length || unknown.length) process.exit(1);
  console.log('every marked figure matches');
}
