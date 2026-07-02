# two-clocks.png — contextual-illustrator sidecar

Part of the Plexus doc-site diagram series. Regenerate with the SAME house style for visual consistency.

- Model / backend: `gpt-image-2` via `fal`
- Aspect ratio: `16:9`
- Quality: high · Format: png
- Script: `bun ~/.claude/plugins/cache/vibe-skills/contextual-illustrator/1.0.0/skills/contextual-illustrator/scripts/generate_image.mjs`

## House style (verbatim — identical across the whole series)
Clean FLAT technical line-diagram, a self-contained figure on a warm dark charcoal background (deep warm near-black with a faint amber tint, like lamplight on a ledger). Draw the structure as LABELED rounded-rectangle nodes connected by thin directional arrows — this is a labeled flow/architecture diagram, NOT an icon illustration. Strokes: thin (~1.5px) warm off-white / cream. Use AMBER for the active/primary path and emphasis; a desaturated SAGE GREEN for allow/granted/exposed states; a muted CLAY RED for deny/revoke; muted SLATE grey for neutral/hidden. Crisp legible geometric sans-serif labels, every word spelled EXACTLY as specified. Generous whitespace, precise, mechanical, calm — a plate in a well-set technical manual. STRICTLY NO decorative device icons (no monitors, phones, clouds, databases, folders, charts), NO neon, NO gradients, NO glow, NO 3D/isometric, NO drop shadows, NO photorealism, NO emoji, NO purple/cyan. Only labeled boxes, arrows, and text.

## Exact labels
- Outer AMBER bar: `TRUST-WINDOW — the lifetime of your decision: once · 1h · 1d · 7d · until-revoked`
- Inner repeating segments: `scoped token — 15 min, silently re-minted from the standing grant`
- GREEN note: `while the window stands, no re-prompt`
- CLAY RED note: `a leaked token dies in minutes`

## Figure content (appended to house style)
FIGURE CONTENT: two nested horizontal time bars. The OUTER long bar rendered in AMBER, labeled 'TRUST-WINDOW — the lifetime of your decision: once · 1h · 1d · 7d · until-revoked'. Nested inside the outer bar, several short repeating segments in a row, each labeled 'scoped token — 15 min, silently re-minted from the standing grant'. A SAGE GREEN note reads 'while the window stands, no re-prompt'. A small CLAY RED note reads 'a leaked token dies in minutes'.
