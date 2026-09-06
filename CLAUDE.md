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
pnpm census [file.fig]                       # what the IR layer still drops (default: both samples' first)
pnpm reach [file.fig]                        # how much of a frame one get_frame call delivers
pnpm diff [file.fig]                         # pixel comparison against refs/<sample>/<frameId>.png
pnpm dogfood                                 # the tool-call count find_nodes saves, measured
node src/cli.mjs <file.fig>                  # list frames: id, name, size
node src/cli.mjs <file.fig> <frame> <outDir> # render one frame to HTML + ir.json + assets
pnpm mcp                                     # stdio MCP server (also wired in .mcp.json)
```

Samples are gitignored and large; without them every suite **skips rather than fails**, so a
green run on a fresh clone proves nothing. Confirm the sample files exist first. (`CI=1` turns
the skip into an exit 1, since a skip and a pass look identical to anything reading the code.)

- `samples/kyowon-full.fig` — a product design: no auto-layout, no components, heavy vector art
- `samples/matsq.fig` — a design system: symbols, instances, auto-layout, variables, sections

`refs/<sample>/<frameId>.png` holds Figma's own 2x export of a frame, and `pnpm diff` compares
the render to it. `REFS.md` says which frames to export and why those. Nothing in this repo has
ever been checked against Figma's actual output; every other check here agrees with the render
it is looking at.

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
pass back as `select`, and `find_nodes` turns a string into that id in one call. Both `depth`
and `includePaths` bypass the budget.

The budget is spent by searching, not by estimating: `allot`'s cost model runs light, and the
response it produces is **not monotonic** in the allowance it is given — skipping a node keeps
its subtree out of the queue, so more room can admit one wide child that crowds out many cheap
ones. `fit` walks allowances past the budget, scores each response by the strings it names then
the nodes then its size, and tops the winner up node by node against the real serialized length.
`pnpm reach` is the number that says whether any of that still works.

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
9. **A group is a `FRAME` carrying `resizeToFit`.** There is no `GROUP` type in the format, so a
   test on `node.type` alone treats all 521 of one file's groups as frames. Groups size themselves
   to their contents instead of cropping them: clipping them cut every OUTSIDE stroke, glow and
   shadow at the child's own edge — the tool buttons lost the right side of their white ring.
10. **`textAutoResize` names axes Figma derives, and the box on them is a cache that is wrong in
    both directions.** An instance that overrides its label to 16px Inter keeps the master's
    29×14 slot; the Intro - 01 headline is 128px type in a 62px box; other boxes sit far larger
    than their text. Figma's number was measured with the real font, so it stays —
    `min-width`/`min-height: max-content` on the derived axes only stops the box being smaller
    than what it holds. Replacing it with `max-content` outright shrank one label 128px → 37px.

11. **An instance carries Figma's recomputation of itself, in `derivedSymbolData`.** Each child's
    size and transform after the copy was resized, and its strokes re-outlined at that size.
    Without it every child sits at the master's measurements — a Button dragged from 124px to 74
    kept a label 40px in and 44px wide, and ran off its own background. Inside one master a path
    is a single guid whatever the node's depth; a longer path crosses into a nested instance and
    belongs to that instance's own expansion. Keying by the last guid collides 126 times here.
12. **Figma calling a frame auto-layout does not make it a flex row.** Where the children it
    recomputed overlap on the main axis — a filling label with icons drawn over its ends — flex
    would push them apart. The stack settings stay reported; the placement falls back to the
    coordinates. 32 boxes in the design-system file.

## Working rules

- **No rendering code a sample cannot check.** Radial gradients, stacked fills and wrap-grid
  inference stay unimplemented because neither sample contains them. Constraints and centred
  stroke alignment are reported as fact but not applied: both move things on screen, and until
  `refs/` has Figma's own export there is no way to see whether the result is right. The same
  test held `derivedTextData` and the re-derived `fillGeometry` out — reading either changes not
  one number in either sample. `TASKS.md` records each with its count.
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
