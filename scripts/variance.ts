import { runDiscovery } from '../server/store.ts'

/**
 * Drei Durchläufe hintereinander. Der Zweck ist nicht die Zahl selbst,
 * sondern ihre Streuung: schwankt die Vergleichsbasis, ist die Ursache Last —
 * nicht das Angebot der Anbieter.
 */
const cfg = {
  windowMs: 24 * 3600_000,
  maxEvents: 400,
  minPercent: 0,
  maxDepthEvents: 60,
  maxHotEvents: 12,
  hotThreshold: 1.06,
}
for (let i = 1; i <= Number(process.env.RUNS ?? 3); i++) {
  const s = await runDiscovery(cfg)
  const load = Object.values(s.hostLoad)
  console.log(
    `Lauf ${i}: ${String(s.eventCount).padStart(4)} Events  ${String(s.matchedCount).padStart(3)} gematcht  ` +
      `${(s.durationMs / 1000).toFixed(1)}s  retries=${load.reduce((a, h) => a + h.retries, 0)}  ` +
      `abgewiesen=${load.reduce((a, h) => a + h.blocked, 0)}  ` +
      `Bücher ohne Events=${s.books.filter((b) => !b.eventCount).map((b) => b.bookmakerId).join(',') || '—'}`,
  )
}
