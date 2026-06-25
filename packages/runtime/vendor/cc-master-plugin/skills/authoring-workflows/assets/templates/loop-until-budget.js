export const meta = {
  name: 'loop-until-budget',
  description: 'Keep spawning work until the turn token budget is nearly spent.',
  phases: [{ title: 'Accumulate' }],
}
// USE WHEN: depth should scale to the user's "+Nk" budget directive (unknown ideal count).
// SHAPE: while (budget.total && budget.remaining() > RESERVE) { ... }
// GUARD: budget.total is null when no target set → loop would never end; the guard prevents that.
// FILL: the per-round prompt + schema + the RESERVE headroom.
const RESERVE = 50_000
const found = []
while (budget.total && budget.remaining() > RESERVE) {
  const r = await agent('TODO: produce the next batch of findings', { phase: 'Accumulate' })
  found.push(r)
  log(`${found.length} batches, ${Math.round(budget.remaining() / 1000)}k left`)
}
return found
