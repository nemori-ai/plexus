# source-capability-spine.png — contextual-illustrator sidecar

Part of the Plexus doc-site diagram series. Regenerate with the SAME house style for visual consistency.

- Model / backend: `gpt-image-2` via `fal`
- Aspect ratio: `4:3`
- Quality: high · Format: png
- Script: `bun ~/.claude/plugins/cache/vibe-skills/contextual-illustrator/1.0.0/skills/contextual-illustrator/scripts/generate_image.mjs`

## House style (verbatim — identical across the whole series)
Clean FLAT technical line-diagram, a self-contained figure on a warm dark charcoal background (deep warm near-black with a faint amber tint, like lamplight on a ledger). Draw the structure as LABELED rounded-rectangle nodes connected by thin directional arrows — this is a labeled flow/architecture diagram, NOT an icon illustration. Strokes: thin (~1.5px) warm off-white / cream. Use AMBER for the active/primary path and emphasis; a desaturated SAGE GREEN for allow/granted/exposed states; a muted CLAY RED for deny/revoke; muted SLATE grey for neutral/hidden. Crisp legible geometric sans-serif labels, every word spelled EXACTLY as specified. Generous whitespace, precise, mechanical, calm — a plate in a well-set technical manual. STRICTLY NO decorative device icons (no monitors, phones, clouds, databases, folders, charts), NO neon, NO gradients, NO glow, NO 3D/isometric, NO drop shadows, NO photorealism, NO emoji, NO purple/cyan. Only labeled boxes, arrows, and text.

## Exact labels
- Top band: `CONNECTOR — a type Plexus can talk to (Obsidian, Claude Code)`
- Middle band: `SOURCE — a configured instance you added (your vault at ~/Documents/MyVault)`
- Bottom band: `CAPABILITY — a callable dotted id (obsidian.vault.read)`
- Fan-out: one Connector → two Sources → each Source to two Capabilities
- Side-label (SLATE): `provenance stamped at the Source`

## Figure content (appended to house style)
FIGURE CONTENT: three stacked horizontal bands arranged top to bottom. The top band labeled 'CONNECTOR — a type Plexus can talk to (Obsidian, Claude Code)'. The middle band labeled 'SOURCE — a configured instance you added (your vault at ~/Documents/MyVault)'. The bottom band labeled 'CAPABILITY — a callable dotted id (obsidian.vault.read)'. Thin arrows fan downward: one Connector node splits into two Source nodes, and each Source splits into two Capability nodes. A small SLATE grey side-label reads 'provenance stamped at the Source'.
