import { runDiscovery } from '../server/store.ts'
import { unmappedReport } from '../server/diagnostics.ts'

const s = await runDiscovery({
  windowMs: 24 * 3600_000,
  maxEvents: Number(process.env.MAX_EVENTS ?? 400),
  minPercent: 0,
  maxDepthEvents: Number(process.env.MAX_DEPTH_EVENTS ?? 60),
  maxHotEvents: 12,
  hotThreshold: 1.06,
})

console.log('=== Adapter ===')
for (const b of s.books)
  console.log(
    `  ${b.bookmakerId.padEnd(10)} ${String(b.durationMs).padStart(6)} ms  ` +
      `events=${String(b.eventCount ?? 0).padStart(4)}  ` +
      `vertieft=${String(b.deepened ?? 0).padStart(3)}/${String(b.deepenTargets ?? 0).padEnd(3)}  ` +
      `${b.error ? 'FEHLER: ' + b.error : 'ok'}`,
  )

console.log('\n=== Last je Host (Wiederholungen sind sonst unsichtbar) ===')
for (const [host, h] of Object.entries(s.hostLoad).sort((a, b) => b[1].retries - a[1].retries))
  console.log(
    `  ${host.padEnd(32)} n=${String(h.requests).padStart(4)}  ` +
      `retry=${String(h.retries).padStart(3)}  abgewiesen=${String(h.blocked).padStart(3)}  ` +
      `fehlgeschlagen=${String(h.failures).padStart(3)}  gedrosselt=${(h.throttledMs / 1000).toFixed(1)}s` +
      (h.maxPenalty > 1 ? `  Faktor×${h.maxPenalty}` : '') +
      (h.blockedUntil ? '  GESPERRT' : ''),
  )

console.log(`\nEvents gesamt: ${s.eventCount}`)
console.log(`Über ≥2 Bücher gematcht: ${s.matchedCount}  (davon ${Math.round(s.srMatchRate * 100)} % per Sportradar-ID)`)
console.log(`Vertieft: ${s.deepenedCount}   Arbitrage: ${s.opportunities.length}   Dauer: ${(s.durationMs / 1000).toFixed(1)} s`)

for (const o of s.opportunities.slice(0, 10)) {
  console.log(`\n  >>> ${o.arbPercent.toFixed(2)} %  ${o.home} vs ${o.away}  [${o.market}]  ${o.isLive ? 'LIVE' : ''}`)
  for (const oc of o.outcomes)
    console.log(`      ${oc.label.padEnd(26)} ${String(oc.best.odds).padStart(6)} @ ${oc.best.bookmakerId}`)
}

console.log(`\n=== Knappste Vergleiche ===`)
for (const m of s.margins.slice(0, 6))
  console.log(`  ${m.impliedPercent.toFixed(2).padStart(6)} %  ${m.event.padEnd(42)} ${m.market}`)

const un = unmappedReport(10)
if (un.length) {
  console.log('\n=== Noch nicht gemappte Märkte ===')
  for (const u of un) console.log(`  ${String(u.count).padStart(5)}x  ${u.bookmakerId.padEnd(8)} ${u.label}`)
}
