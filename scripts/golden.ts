/**
 * Golden-Test: ein Durchlauf auf aufgezeichneten Antworten, als sortiertes JSON.
 *
 *   node scripts/golden.ts record band.json          live scannen und aufzeichnen
 *   node scripts/golden.ts replay band.json aus.json  offline abspielen
 *
 * Zwei Abspielungen desselben Bands vor und nach einer Änderung müssen
 * byte-gleich sein, solange die Änderung das Verhalten nicht ändern soll.
 * Die Uhr steht beim Abspielen auf dem Zeitpunkt der Aufnahme.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [mode, tapeFile, outFile] = process.argv.slice(2)
if ((mode !== 'record' && mode !== 'replay') || !tapeFile || (mode === 'replay' && !outFile)) {
  console.error('Aufruf: node scripts/golden.ts record <band.json> | replay <band.json> <aus.json>')
  process.exit(2)
}

if (mode === 'record') {
  process.env.ARBIFY_TAPE_RECORD = tapeFile
} else {
  process.env.ARBIFY_TAPE_REPLAY = tapeFile
  const frozen: number = JSON.parse(readFileSync(tapeFile, 'utf8')).meta.recordedAt
  const RealDate = Date
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length) super(...(args as [string]))
      else super(frozen)
    }
    static now = () => frozen
  }
  globalThis.Date = FrozenDate as DateConstructor
}

const { runDiscovery, getRawPool } = await import('../server/store.ts')
const { unmappedReport, collisionReport } = await import('../server/diagnostics.ts')
const { rejectedReport } = await import('../server/scan.ts')

const snap = await runDiscovery({
  windowMs: 24 * 3600_000,
  maxEvents: 1_200,
  minPercent: 0,
  maxDepthEvents: 120,
  maxHotEvents: 12,
  hotThreshold: 1.06,
})

if (mode === 'record') {
  for (const b of snap.books)
    console.log(`${b.bookmakerId.padEnd(14)} events=${String(b.eventCount ?? 0).padStart(4)}  ${b.error ?? 'ok'}`)
  console.log(`Events ${snap.eventCount}, gematcht ${snap.matchedCount}, Arbitrage ${snap.opportunities.length}`)
  process.exit(0)
}

/** Objektschlüssel sortiert, damit die Ausgabe nur vom Inhalt abhängt. */
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
      : v

const out = {
  books: snap.books.map(({ durationMs: _d, ...b }) => b),
  counts: {
    eventCount: snap.eventCount,
    matchedCount: snap.matchedCount,
    srMatchRate: snap.srMatchRate,
    deepenedCount: snap.deepenedCount,
    flippedSources: snap.flippedSources,
    droppedSources: snap.droppedSources,
    hotCount: snap.hotCount,
  },
  rawPool: [...getRawPool()].sort((a, b) =>
    `${a.bookmakerId}:${a.bookEventId}`.localeCompare(`${b.bookmakerId}:${b.bookEventId}`),
  ),
  opportunities: snap.opportunities,
  margins: snap.margins,
  unmapped: unmappedReport(1_000_000),
  collisions: collisionReport(1_000_000),
  rejected: rejectedReport(),
}

writeFileSync(outFile, JSON.stringify(sortKeys(out), null, 1) + '\n')
console.log(
  `${out.rawPool.length} Rohevents, ${out.counts.matchedCount} gematcht, ` +
    `${out.opportunities.length} Arbitrage → ${outFile}`,
)
process.exit(0)
