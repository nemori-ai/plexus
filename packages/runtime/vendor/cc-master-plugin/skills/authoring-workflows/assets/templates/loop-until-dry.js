export const meta = {
  name: 'loop-until-dry',
  description: 'Discovery loop: keep finding until K consecutive rounds surface nothing new.',
  phases: [{ title: 'Discover' }],
}
// USE WHEN: unknown-size discovery (find all bugs / all call sites). Counters miss the tail; dry-rounds don't.
// SHAPE: dedup against a `seen` set; stop after DRY_LIMIT empty rounds.
// FILL: the finder prompt + the key() that identifies a unique item.
const DRY_LIMIT = 2
const seen = new Set(), all = []
let dry = 0
while (dry < DRY_LIMIT) {
  const r = await agent('TODO: find items not yet in the seen set', { phase: 'Discover', schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] } })
  const fresh = (r?.items ?? []).filter((x) => !seen.has(x))
  if (fresh.length === 0) { dry++; continue }
  dry = 0
  fresh.forEach((x) => { seen.add(x); all.push(x) })
  log(`+${fresh.length} (total ${all.length})`)
}
return all
