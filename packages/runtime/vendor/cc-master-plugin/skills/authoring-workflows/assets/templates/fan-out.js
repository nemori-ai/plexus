export const meta = {
  name: 'fan-out',
  description: 'Run N independent tasks concurrently and collect all results (barrier).',
  phases: [{ title: 'Fan out' }],
}
// USE WHEN: tasks are independent AND you need ALL results before the next step.
// SHAPE: parallel([...thunks]) — a BARRIER: awaits every thunk; a thrown thunk → null.
// FILL: the work list + the per-item prompt + (optional) schema.
// DECISION-TREE: "independent tasks, need all results together" → fan-out.
const items = args ?? ['ITEM_A', 'ITEM_B', 'ITEM_C']
const results = await parallel(items.map((it) => () =>
  agent(`TODO: do the work for ${it}`, { phase: 'Fan out' })
))
return results.filter(Boolean)
