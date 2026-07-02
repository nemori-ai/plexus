# connect-flow.png — contextual-illustrator sidecar

Part of the Plexus doc-site diagram series. Regenerate with the SAME house style for visual consistency.

- Model / backend: `gpt-image-2` via `fal`
- Aspect ratio: `16:9`
- Quality: high · Format: png
- Script: `bun ~/.claude/plugins/cache/vibe-skills/contextual-illustrator/1.0.0/skills/contextual-illustrator/scripts/generate_image.mjs`

## House style (verbatim — identical across the whole series)
Clean FLAT technical line-diagram, a self-contained figure on a warm dark charcoal background (deep warm near-black with a faint amber tint, like lamplight on a ledger). Draw the structure as LABELED rounded-rectangle nodes connected by thin directional arrows — this is a labeled flow/architecture diagram, NOT an icon illustration. Strokes: thin (~1.5px) warm off-white / cream. Use AMBER for the active/primary path and emphasis; a desaturated SAGE GREEN for allow/granted/exposed states; a muted CLAY RED for deny/revoke; muted SLATE grey for neutral/hidden. Crisp legible geometric sans-serif labels, every word spelled EXACTLY as specified. Generous whitespace, precise, mechanical, calm — a plate in a well-set technical manual. STRICTLY NO decorative device icons (no monitors, phones, clouds, databases, folders, charts), NO neon, NO gradients, NO glow, NO 3D/isometric, NO drop shadows, NO photorealism, NO emoji, NO purple/cyan. Only labeled boxes, arrows, and text.

## Exact labels
- Lanes: `ADMIN` (top), `AGENT` (bottom)
- ADMIN box: `Connect an agent — mint one-time code + grant a starting cap-set`
- Crossing arrow: `one-time code`
- AGENT boxes (left→right): `Install (one command)` → `Redeem code → durable PAT (plx_agent_…)` → `plexus-<agentId> list → invoke`
- Final AMBER box: `write / execute call → PENDS in Approvals until the human approves`

## Figure content (appended to house style)
FIGURE CONTENT: a left-to-right onboarding flow drawn in two horizontal lanes, the top lane labeled 'ADMIN' and the bottom lane labeled 'AGENT'. In the ADMIN lane, one box: 'Connect an agent — mint one-time code + grant a starting cap-set'. A downward arrow labeled 'one-time code' crosses from the ADMIN lane into the AGENT lane. In the AGENT lane, three boxes left-to-right joined by arrows: 'Install (one command)' then 'Redeem code → durable PAT (plx_agent_…)' then 'plexus-<agentId> list → invoke'. Then a final AMBER box: 'write / execute call → PENDS in Approvals until the human approves'.
