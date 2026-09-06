# fig-parser

Reads a Figma `.fig` file and hands an AI coding agent something it can actually write markup
from — over MCP, with no Figma account, no API key, and no desktop app running.

## Why

A `.fig` file arrives as one flat list — 4013 nodes under the frames of the smaller file here <!-- fig:kyowon.raw=4013 -->, with
no nesting left in it. Handing that to a model is why "convert this design to code" tends to
produce absolute-positioned soup. Parsing the file was never the hard part; turning it into
something worth reading is.

The 1440×960 login screen in that file is 102 of those nodes <!-- fig:login.raw=102 -->. fig-parser gives it
back as **22 IR nodes** <!-- fig:login.ir=22 -->: a 63-path logo <!-- fig:login.logo.paths=63 --> becomes one `<svg>`, the full-bleed art becomes a backdrop,
repeated cards are labelled as a list, and colours come back under the names the design system
gave them.

It also exists because the alternatives did not fit: the Figma MCP has plan limits, and the
local editors I tried could not be customised or bent toward markup output.

## Install

```bash
pnpm install
```

Node 20+. No build step — plain ESM, four runtime dependencies <!-- fig:deps.runtime=4 --> (`pixelmatch` and `pngjs` are
dev-only, for the pixel diff).

## Commands

```bash
pnpm mcp                      # the MCP server on stdio — what an agent connects to
pnpm test                     # parse + components + mcp suites, in that order
pnpm census [file.fig]        # what the IR layer drops or approximates on a file
pnpm reach  [file.fig]        # how much of each frame one get_frame call delivers
pnpm diff   [file.fig]        # pixel comparison against refs/ — see REFS.md
pnpm refs:slice <page.png>    # cut one page-wide Figma export into refs/<sample>/
pnpm dogfood                  # the tool-call count find_nodes saves, re-measured
```

Everything but `pnpm mcp` skips rather than fails when the sample files are missing, and `CI=1`
turns that skip into an exit 1 — a skip and a pass look identical to anything reading an exit
code.

## Use it from the CLI

```bash
node src/cli.mjs design.fig                      # list frames: id, name, size
node src/cli.mjs design.fig "Login" out/login    # → index.html, ir.json, assets/
```

The HTML is a **geometric baseline**: pixel-accurate, structurally naive. Open it to confirm the
parse is right, or diff your own markup against it. Do not ship it.

## Use it from an agent

```json
{
  "mcpServers": {
    "fig-parser": {
      "command": "node",
      "args": ["/path/to/fig-parser/src/mcp.mjs"],
      "env": { "FIG_ROOT": "/where/your/fig/files/live" }
    }
  }
}
```

`FIG_ROOT` defaults to the working directory and paths are confined to it — the model supplies
them, so they are treated as untrusted.

| Tool | What it gives you |
| --- | --- |
| `list_frames` | Every frame, including ones filed inside sections. Start here. |
| `get_frame` | The IR for one frame within a 30KB budget — style is dropped before content, and content before whole nodes. `select` drills into a subtree. |
| `find_nodes` | Nodes whose text or name contains a string, with the id to `select`, the ancestors that lead to it, and its box. |
| `get_html` | The baseline render, for comparison. |
| `export_assets` | Raster fills as `.png`, collapsed icon clusters as `.svg`. |
| `get_tokens` | The colours and text styles one frame actually uses, named. |
| `get_variables` | The design system's declared variables — sets, modes, aliases. Narrow with `set` or `frame`. |

Large frames come back truncated with a stub naming the id to pass back as `select`, so nothing
becomes unreachable and nothing blows the context window. `find_nodes` turns a string into that
id in one call — learning all 48 strings in one design-system frame took 31 calls of drilling
and takes one of searching <!-- fig:dogfood.drilling=31 fig:dogfood.searching=1 --> (`pnpm dogfood`
re-runs that comparison).

`pnpm reach` says how much of each frame a single call delivers, so a change to the budget
shows up as a number rather than as quietly less of the design arriving.

### What each tool takes

Seven tools <!-- fig:tools.count=7 -->, each taking `file`, a path under `FIG_ROOT`. Beyond that:

| Tool | Parameters |
| --- | --- |
| `list_frames` | — |
| `get_frame` | `frame`, `select` (id or name to return instead of the whole frame), `depth` (levels to describe; 1 = this node with its children as stubs), `includePaths` (inline raw path data; large) |
| `find_nodes` | `query` (substring, case-insensitive), `frame` (omit to search the file), `field` (`text` \| `name` \| `both`), `limit` (default 40) |
| `get_html` | `frame`, `assetDir` (href prefix for images, default `assets`) |
| `export_assets` | `frame`, `outDir` (under `FIG_ROOT`) — returns `{ hash: { file, usedBy } }` so a written file can be traced back to the nodes that wanted it |
| `get_tokens` | `frame` (omit for the whole file) |
| `get_variables` | `set` (substring), `frame` (only what that frame binds) |

Nothing bypasses the 30KB budget. `depth` and `includePaths` shape the answer, and where
the shape you asked for does not fit, the usual cut answer comes back with `truncated` saying
what it could not send — the login screen's logo is 63 paths and 39941 B on its own.

### A worked pass over one screen

Generated by running it — `node src/worked-pass.mjs --write` regenerates, and the test suite
fails if this block and the tools disagree.

<!-- worked-pass: generated by src/worked-pass.mjs — do not edit by hand -->
```
# samples/kyowon-full.fig
list_frames(file)                              → 12 frames; 2063:280 온라인학습_Login 1440×960
get_frame(file, "2063:280")                    → 22 nodes — the whole screen in one call
get_tokens(file, "2063:280")                   → 15 colours, 3 text styles, named
export_assets(file, "2063:280", "out/worked-pass") → 5 files: .png .svg

# samples/matsq.fig — a frame too big for one call
find_nodes(file, "Products", frame: "97:3081") → 6 matches; first 85:2258/85:2196
get_frame(file, "97:3081", select: …)          → 1 nodes, under GNB > State=Notuser > Contatiner > MenuWrap > Menu
```
<!-- /worked-pass -->

`docs/gnb-from-ir.html` is a header written this way, from nothing but those responses.

## What the IR looks like

```jsonc
{
  "id": "2063:289", "name": "로그인", "role": "text",
  "box": { "x": 139, "y": 21, "w": 52, "h": 24 },
  "text": {
    "content": "로그인", "family": "Pretendard", "size": 20, "weight": 600,
    "lineHeight": 1, "color": "#ffffff", "align": "left", "nowrap": true
  }
}
```

`role` is one of `frame` `text` `image` `icon` `backdrop`. Beyond geometry and style, nodes carry
the things that make markup writable:

- `layout` — `flex` with direction, gap and per-side padding where Figma used auto-layout, and
  where it did not, inferred from geometry. Otherwise `absolute`, honestly.
- `layout.repeat` — `{ count, like, columns, rows }` when three or more siblings share a shape.
  Twenty cards say so instead of arriving as twenty sets of coordinates.
- `layout.rows` — which children share a visual row, as indices into that node's own
  `children`. Siblings arrive in paint order, which is not reading order.
- `layout.overflow` — `{ axis, needs, has }` where the design forced an auto-layout box
  narrower than its own contents (28 of the design-system file's 1337 <!-- fig:matsq.overflow=28 fig:matsq.autolayout=1337 -->). Figma neither shrinks
  the children nor clips them, so they run past the edge and the next sibling paints over them.
  Better to know than to copy a width the content breaks.
- `label` — the text a painted box contains, when it contains exactly one: a button,
  a tab, a chip, without having to work out which sibling sits inside which.
- `interactions` — what the designer wired up (`ON_CLICK`, `MOUSE_ENTER`, …) with the
  navigation type and target. A label plus a click is a `<button>` on evidence.
- `tokens` — variables bound to numbers, not just colours: `{ radius: "--radius-xl",
  gap: "--gap-sm" }` alongside the literal values.
- `component` — which master an instance came from, with overrides applied and, where
  the component set declares them, `variant` (`{ State: 'Hover', Size: 'Large' }`).
- `style.fillToken` / `text.colorToken` — the design variable a colour was bound to.
- `bounds` — a rotated node's real footprint, alongside its untransformed `box`.

## Format notes

Worth knowing if you are doing something similar. `.fig` is a zip; `canvas.fig` inside it is a
`fig-kiwi` archive of a deflate-raw schema chunk followed by a **zstd** message chunk. Parsers
written before that switch assume deflate for both and fail on any current file.

Two things cost real debugging. Sibling order is a fractional index built from punctuation, so
it must be compared byte-wise — `localeCompare` scrambles z-order and backgrounds paint over
content. And path coordinates already sit in the node's own size space: `vectorData.normalizedSize`
is the source artboard, and dividing by it shrinks icons to a sub-pixel speck.

## Limits

Radial gradients, stacked fills and wrap-grid inference are unimplemented: none of the sample
files exercises them, and untested rendering code is worse than an honest gap. Constraints and
centred stroke alignment are reported in the IR but not turned into CSS — both move things on
screen, and neither has been checked against a reference yet.
`layout.hug` no longer pins a box to its measured size; that measurement is a floor now, so a
longer string grows the box rather than spilling out of it.

Every other check here agrees with the render it is looking at; only `pnpm diff` can say the
render is wrong, by comparing it to Figma's own export. `REFS.md` says how to get those images
in — one page-wide PNG through `pnpm refs:slice` is enough. kyowon-full's 12 frames are covered,
and `TASKS.md` has what that comparison found: one full screen matches to 0.146%, and the frames
that do not are each wrong in one identified place.

Run `pnpm census <file.fig>` against your own file to see what this drops on it. Rows marked
`deliberate` are accounted for — duplicate vector-network blobs, invisible nodes, and variables
that live in a library the file does not carry. Anything else is a real gap, and an
"unaccounted for" row means nodes are going missing.

## Tests

```bash
pnpm test
```

Plain `node:assert`, no framework. The suites skip rather than fail when the sample `.fig` files
are absent, so a green run on a fresh clone proves nothing until you supply your own.

## License

MIT
