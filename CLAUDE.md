# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Parses Figma `.fig` files into a code-oriented IR and exposes it over MCP. The goal is that
**a model can read a design and write accurate markup from it** — not a pixel-perfect viewer.
`get_html` exists as a geometric baseline to check against, never as shippable markup.

`TASKS.md` holds the remaining work, why each blocked item is blocked, and the verification
protocol. Read it before starting anything.

## Commands

```bash
pnpm test                                    # parse + components + mcp suites, in that order
node src/parse.test.mjs                      # one suite; there is no test framework, just assert
pnpm census [file.fig]                       # what the IR layer still drops (default: kyowon-full)
node src/cli.mjs <file.fig>                  # list frames: id, name, size
node src/cli.mjs <file.fig> <frame> <outDir> # render one frame to HTML + ir.json + assets
pnpm mcp                                     # stdio MCP server (also wired in .mcp.json)
```

Samples are gitignored and large; without them every suite **skips rather than fails**, so a
green run on a fresh clone proves nothing. Confirm the sample files exist first. (`CI=1` turns
the skip into an exit 1, since a skip and a pass look identical to anything reading the code.)

- `samples/kyowon-full.fig` — a product design: no auto-layout, no components, heavy vector art
- `samples/matsq.fig` — a design system: symbols, instances, auto-layout, variables, sections

The two exercise disjoint code paths. A change verified against one is not verified.

## Pipeline

```
.fig (zip) → parse.mjs → ir.mjs → html.mjs   (baseline render)
                              ↘ mcp.mjs      (model-facing tools)
                              ↘ census.mjs   (coverage report)
```

**parse.mjs** unwraps the container and rebuilds structure. `canvas.fig` is a `fig-kiwi`
archive: deflate-raw schema chunk, then a **zstd** message chunk (older parsers assume deflate
for both and die here). `nodeChanges` is a flat list; `buildTree` reassembles it from
`guid`/`parentIndex`. Path geometry lives in `message.blobs` as u8 opcode + float32 args.

**ir.mjs** is where the value is, and where the subtlety is. It turns 4013 raw nodes into 1353
IR nodes by collapsing vector clusters into single SVGs, folding masks into their parent,
expanding instances against their master, rebuilding missing nesting from geometry, and
inferring layout. `HANDLED` declares what this layer can express; `census.mjs` reads it rather
than keeping its own copy, so the report cannot drift from the code.

**mcp.mjs** keeps two different shapes of the same tree. Renderers want every bezier; a model
needs to know a 246×98 logo is present and can be exported. `fit` spends a 30KB budget in order
of what costs least: path data first, then typography and paint, then whole nodes — content is
the last thing to go, because a node that is not listed cannot be asked about while one listed
without its font still carries its string. What it cannot fit becomes a stub naming the id to
pass back as `select`. Both `depth` and `includePaths` bypass the budget.

`toIR(node, blobs, { symbols, variables })` — without `symbols` instances render as empty
boxes, and without `variables` tokens get invented names instead of the authored ones. Every
entry point builds both indexes; new ones must too.

## Invariants that cost real debugging

These are pinned by tests. A red suite is usually one of these, not new code.

1. **Sibling order is a byte comparison.** `parentIndex.position` is a fractional index built
   from punctuation; `localeCompare` reorders it and z-order collapses — backgrounds paint over
   content.
2. **Path coordinates are never scaled.** They already sit in the node's `size` space.
   `vectorData.normalizedSize` is the source artboard, not a coordinate system; dividing by it
   shrinks icons to a sub-pixel speck.
3. **Strokes arrive already outlined.** `strokeGeometry` is a fillable region — paint it like
   `fillGeometry` but with `strokePaints`. Never convert it to a CSS `stroke`.
4. **`symbolIndex` takes the built tree, not raw `nodeChanges`,** which carry no children.
   Index the wrong one and every instance expands to an empty shell.
5. **Matrices are float32.** An unrotated node reads as `0.99999994`, so `isIdentity` needs its
   epsilon or every node acquires a `rotate(0deg)`.
6. **Frames live inside `SECTION`s too.** Only walking canvas children hid 47 of one file's 97
   frames. `collectFrames` in parse.mjs is the only traversal — call it, do not write another,
   because a test that re-implements it only ever agrees with itself.
7. **An instance keeps what it says about itself.** Expansion takes a closed set from the master
   (type, children, symbolData and the two derived fields) and lets every other field on the
   instance win. Listing what to carry over instead dropped its visibility, paints, radii and
   stack settings — 50 hidden instances painted.
8. **A hint that reports indices says which array they index.** `layout.rows` addresses the
   node's own `children`; two callers passing differently-filtered arrays made every index name
   the wrong node.

## Working rules

- **No rendering code a sample cannot check.** Radial gradients, stacked fills and wrap-grid
  inference stay unimplemented because neither sample contains them. Constraints are reported as
  fact but not applied, since nothing here can check the result. `TASKS.md` records the evidence.
- **A negative needs a full scan before it is written down.** Two claims in these documents were
  false: constraints do appear in the design-system file (164 nodes), and so do 5077 resolvable
  variable bindings on radii, gaps, padding, border weights and type — both written down after
  grepping for one field-name shape and concluding from its absence.
- **Census must balance.** `raw = IR + collapsed + folded + invisible`, per frame. A "nodes
  unaccounted for" row means something is being dropped or duplicated silently. It is summed as
  absolute values on purpose: netting them across the file let +48 in seven frames hide −66 in
  four.
- Verify a change by rendering **many frames** and screenshotting, then diffing the before/after
  HTML so every changed declaration is one you intended. Several bugs here looked fine on the
  first frame anyone checked.
- Leave one runnable `assert` behind for new logic, in the style of the existing `src/*.test.mjs`,
  **and break the implementation once to watch it fail.** Three assertions here could not fail at
  all until that was actually done.

## Other agent configs

`~/.codex/config.toml` and `~/.gemini/settings.json` exist on this machine. To bring their MCP
servers, commands, subagents or instructions into Claude Code, reply `/import` to see what is
importable, then `/import --yes=<digest>` using the digest that scan prints. If `/import` is not
available here, run `claude import` from a terminal.
