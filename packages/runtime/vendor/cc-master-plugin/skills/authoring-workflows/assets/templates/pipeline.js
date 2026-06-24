export const meta = {
  name: 'pipeline',
  description: 'Stream each item through multiple stages independently (no barrier — the default).',
  phases: [{ title: 'Stage 1' }, { title: 'Stage 2' }],
}
// USE WHEN: multi-stage work where item A can reach stage 2 while item B is still in stage 1.
// SHAPE: pipeline(items, stage1, stage2, ...) — NO barrier between stages.
// FILL: items + each stage's prompt; later stages receive (prevResult, originalItem, index).
// DECISION-TREE: "multi-stage, stages need not synchronize" → pipeline (prefer this by default).
const items = args ?? ['ITEM_A', 'ITEM_B']
const out = await pipeline(items,
  (it) => agent(`TODO stage 1 for ${it}`, { phase: 'Stage 1' }),
  (prev, it) => agent(`TODO stage 2 for ${it} using ${JSON.stringify(prev)}`, { phase: 'Stage 2' }),
)
return out.filter(Boolean)
