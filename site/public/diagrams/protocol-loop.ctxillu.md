# protocol-loop.png — contextual-illustrator sidecar

Part of the Plexus doc-site diagram series. Regenerate with the SAME house style for visual consistency.

- Model / backend: `gpt-image-2` via `fal`
- Aspect ratio: `16:9`
- Quality: high · Format: png
- Script: `bun ~/.claude/plugins/cache/vibe-skills/contextual-illustrator/1.0.0/skills/contextual-illustrator/scripts/generate_image.mjs`

## House style (verbatim — identical across the whole series)
Clean FLAT technical line-diagram, a self-contained figure on a warm dark charcoal background (deep warm near-black with a faint amber tint, like lamplight on a ledger). Draw the structure as LABELED rounded-rectangle nodes connected by thin directional arrows — this is a labeled flow/architecture diagram, NOT an icon illustration. Strokes: thin (~1.5px) warm off-white / cream. Use AMBER for the active/primary path and emphasis; a desaturated SAGE GREEN for allow/granted/exposed states; a muted CLAY RED for deny/revoke; muted SLATE grey for neutral/hidden. Crisp legible geometric sans-serif labels, every word spelled EXACTLY as specified. Generous whitespace, precise, mechanical, calm — a plate in a well-set technical manual. STRICTLY NO decorative device icons (no monitors, phones, clouds, databases, folders, charts), NO neon, NO gradients, NO glow, NO 3D/isometric, NO drop shadows, NO photorealism, NO emoji, NO purple/cyan. Only labeled boxes, arrows, and text.

## Exact labels
- 5-step pipeline (amber arrows):
  1. `1 · DISCOVER — GET /.well-known`
  2. `2 · ENROLL — POST /agents/enroll (code → PAT, once)`
  3. `3 · HANDSHAKE — POST /link/handshake (Authorization: Bearer PAT)`
  4. `4 · GRANT — PUT /grants`
  5. `5 · INVOKE — POST /invoke`
- SLATE bracket spanning all: `all sealed inside one loopback gateway process`

## Figure content (appended to house style)
FIGURE CONTENT: a horizontal 5-step pipeline of boxes joined left-to-right by AMBER arrows. Box 1 '1 · DISCOVER — GET /.well-known'. Box 2 '2 · ENROLL — POST /agents/enroll (code → PAT, once)'. Box 3 '3 · HANDSHAKE — POST /link/handshake (Authorization: Bearer PAT)'. Box 4 '4 · GRANT — PUT /grants'. Box 5 '5 · INVOKE — POST /invoke'. A thin SLATE grey bracket spans underneath all five boxes with the label 'all sealed inside one loopback gateway process'.
