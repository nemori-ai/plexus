# floor-projection.png — contextual-illustrator sidecar

Part of the Plexus doc-site diagram series. Regenerate with the SAME house style for visual consistency.

- Model / backend: `gpt-image-2` via `fal`
- Aspect ratio: `16:9`
- Quality: high · Format: png
- Script: `bun ~/.claude/plugins/cache/vibe-skills/contextual-illustrator/1.0.0/skills/contextual-illustrator/scripts/generate_image.mjs`

Note: shipped image is the TIGHTENED regeneration — the first pass hallucinated an extra
authorization flowchart, so the figure-content prompt below explicitly restricts the figure
to exactly two stacked bands + one dashed arrow + one caption.

## House style (verbatim — identical across the whole series)
Clean FLAT technical line-diagram, a self-contained figure on a warm dark charcoal background (deep warm near-black with a faint amber tint, like lamplight on a ledger). Draw the structure as LABELED rounded-rectangle nodes connected by thin directional arrows — this is a labeled flow/architecture diagram, NOT an icon illustration. Strokes: thin (~1.5px) warm off-white / cream. Use AMBER for the active/primary path and emphasis; a desaturated SAGE GREEN for allow/granted/exposed states; a muted CLAY RED for deny/revoke; muted SLATE grey for neutral/hidden. Crisp legible geometric sans-serif labels, every word spelled EXACTLY as specified. Generous whitespace, precise, mechanical, calm — a plate in a well-set technical manual. STRICTLY NO decorative device icons (no monitors, phones, clouds, databases, folders, charts), NO neon, NO gradients, NO glow, NO 3D/isometric, NO drop shadows, NO photorealism, NO emoji, NO purple/cyan. Only labeled boxes, arrows, and text.

## Exact labels
- BASE band (cream/green, bottom): `The self-describing FLOOR — .well-known + requestShapes + io schemas + how-to-use (works for ANY agent)`
- AMBER plate (above): `per-agent compiled plugin — the plexus-<agentId> launcher (a cache / shortcut)`
- Dashed upward arrow: `projection`
- SLATE caption (below): `the gateway enforces authorization live — a stale projection can never exceed the Floor`

## Figure content (appended to house style — TIGHTENED)
FIGURE CONTENT — draw ONLY these THREE elements and NOTHING else, no additional boxes, no flowchart, no authorization steps, no side inputs: (1) a wide foundational BASE band spanning the full width at the BOTTOM, rendered in cream and sage green, its single label reading 'The self-describing FLOOR — .well-known + requestShapes + io schemas + how-to-use (works for ANY agent)'. (2) Directly ABOVE the base band, one smaller AMBER plate, centered, its single label reading 'per-agent compiled plugin — the plexus-<agentId> launcher (a cache / shortcut)'. (3) ONE dashed vertical arrow pointing upward from the base band to the amber plate, labeled 'projection'. Underneath everything, a single SLATE grey caption line reading 'the gateway enforces authorization live — a stale projection can never exceed the Floor'. That is the ENTIRE figure — exactly two stacked bands, one dashed arrow, one caption. Lots of empty charcoal space around them.
