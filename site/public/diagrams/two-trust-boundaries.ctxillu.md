# two-trust-boundaries.png — contextual-illustrator sidecar

Part of the Plexus doc-site diagram series. Regenerate with the SAME house style for visual consistency.

- Model / backend: `gpt-image-2` via `fal`
- Aspect ratio: `16:9`
- Quality: high · Format: png
- Script: `bun ~/.claude/plugins/cache/vibe-skills/contextual-illustrator/1.0.0/skills/contextual-illustrator/scripts/generate_image.mjs`

## House style (verbatim — identical across the whole series)
Clean FLAT technical line-diagram, a self-contained figure on a warm dark charcoal background (deep warm near-black with a faint amber tint, like lamplight on a ledger). Draw the structure as LABELED rounded-rectangle nodes connected by thin directional arrows — this is a labeled flow/architecture diagram, NOT an icon illustration. Strokes: thin (~1.5px) warm off-white / cream. Use AMBER for the active/primary path and emphasis; a desaturated SAGE GREEN for allow/granted/exposed states; a muted CLAY RED for deny/revoke; muted SLATE grey for neutral/hidden. Crisp legible geometric sans-serif labels, every word spelled EXACTLY as specified. Generous whitespace, precise, mechanical, calm — a plate in a well-set technical manual. STRICTLY NO decorative device icons (no monitors, phones, clouds, databases, folders, charts), NO neon, NO gradients, NO glow, NO 3D/isometric, NO drop shadows, NO photorealism, NO emoji, NO purple/cyan. Only labeled boxes, arrows, and text.

## Exact labels
- Divider label: `the two credentials NEVER cross`
- LEFT column header: `ADMIN`; boxes: `holds the connection-key (plx_live_…)` → `full management plane — /admin/api/*` (amber/slate)
- RIGHT column header: `AGENT`; boxes: `holds its OWN per-agent PAT (plx_agent_…), redeemed once from a one-time code` → `reaches ONLY its pre-granted capabilities` (green)

## Figure content (appended to house style)
FIGURE CONTENT: two columns separated by a vertical divider line down the middle. A label along the divider reads 'the two credentials NEVER cross'. The LEFT column has a header 'ADMIN' and two boxes stacked with a downward arrow between them: top box 'holds the connection-key (plx_live_…)' then bottom box 'full management plane — /admin/api/*' drawn in amber and slate. The RIGHT column has a header 'AGENT' and two boxes stacked with a downward arrow: top box 'holds its OWN per-agent PAT (plx_agent_…), redeemed once from a one-time code' then bottom box 'reaches ONLY its pre-granted capabilities' drawn in sage green.
