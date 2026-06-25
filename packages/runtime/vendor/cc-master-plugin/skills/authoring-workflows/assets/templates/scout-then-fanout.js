export const meta = {
  name: 'scout-then-fanout',
  description: 'Discover the work-list with one scout agent, then fan out / pipeline over it.',
  phases: [{ title: 'Scout' }, { title: 'Process' }],
}
// USE WHEN: you do not know the work-list before the task — the most common real entry shape.
// SHAPE: one scout returns the list → pipeline/parallel over it. (Often you scout inline in the
//        main thread instead; this template is the in-workflow version.)
// FILL: the scout prompt + schema (must return a list) + the per-item processing prompt.
const scout = await agent('TODO: enumerate the work items as a JSON list', {
  phase: 'Scout',
  schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] },
})
const out = await pipeline(scout?.items ?? [],
  (it) => agent(`TODO: process ${it}`, { phase: 'Process' }),
)
return out.filter(Boolean)
