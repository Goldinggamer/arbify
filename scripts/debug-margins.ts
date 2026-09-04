import { runDiscovery } from '../server/store.ts'
const s = await runDiscovery({
  windowMs: 24 * 3600_000,
  maxEvents: Number(process.env.MAX_EVENTS ?? 400),
  minPercent: 0,
  maxDepthEvents: Number(process.env.MAX_DEPTH_EVENTS ?? 60),
  maxHotEvents: 12,
  hotThreshold: 1.06,
})
console.log('Verdächtige Vergleiche (implied < 90 % ist praktisch unmöglich):\n')
for (const m of s.margins.filter((x) => x.impliedPercent < 92).slice(0, 8)) {
  console.log(`${m.impliedPercent.toFixed(2)} %  ${m.event}  [${m.market}]  ${m.league}`)
  for (const l of m.legs) console.log(`      ${l.label.padEnd(24)} ${String(l.odds).padStart(7)} @ ${l.bookmakerId}`)
  console.log()
}
