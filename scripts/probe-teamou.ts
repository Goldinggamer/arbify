import { runDiscovery, getRawPool } from '../server/store.ts'
import { matchEvents } from '../server/match.ts'
import { marketKey, SIDES } from '../server/types.ts'
import type { Side } from '../server/types.ts'

await runDiscovery({ windowMs: 24*3600_000, maxEvents: 400, minPercent: 0, maxDepthEvents: 60, maxHotEvents: 12, hotThreshold: 1.06 })
const { matched } = matchEvents(getRawPool())

type Row = { ev: string; key: string; implied: number; legs: string[]; books: Set<string> }
const rows: Row[] = []
// Marge je Buchmacher für sich — zeigt, ob eine einzelne Quelle stimmig ist.
const soloMargins = new Map<string, number[]>()

for (const m of matched) {
  if (m.sources.length < 2) continue
  const byMarket = new Map<string, Map<Side, { odds: number; book: string }[]>>()
  for (const s of m.sources) {
    const own = new Map<string, Map<Side, number>>()
    for (const o of s.outcomes) {
      if (o.market.type !== 'TEAM_OU') continue
      const k = marketKey(o.market)
      const sides = byMarket.get(k) ?? new Map()
      sides.set(o.side, [...(sides.get(o.side) ?? []), { odds: o.odds, book: s.bookmakerId }])
      byMarket.set(k, sides)
      const os = own.get(k) ?? new Map(); os.set(o.side, o.odds); own.set(k, os)
    }
    for (const [, sides] of own) {
      if (sides.size !== 2) continue
      const imp = [...sides.values()].reduce((a, b) => a + 1 / b, 0)
      soloMargins.set(s.bookmakerId, [...(soloMargins.get(s.bookmakerId) ?? []), imp])
    }
  }
  for (const [k, sides] of byMarket) {
    const req = SIDES.TEAM_OU
    if (req.some((s) => !sides.get(s)?.length)) continue
    const best = req.map((s) => sides.get(s)!.reduce((a, b) => (b.odds > a.odds ? b : a)))
    const books = new Set(best.map((b) => b.book))
    if (books.size < 2) continue
    rows.push({
      ev: `${m.home} vs ${m.away}`,
      key: k,
      implied: best.reduce((a, b) => a + 1 / b.odds, 0),
      legs: best.map((b, i) => `${req[i]} ${b.odds}@${b.book}`),
      books,
    })
  }
}

console.log(`\n=== Marge je Buchmacher, Team-Über/Unter isoliert ===`)
for (const [b, xs] of [...soloMargins].sort()) {
  const avg = xs.reduce((a, c) => a + c, 0) / xs.length
  const min = Math.min(...xs)
  console.log(`  ${b.padEnd(14)} n=${String(xs.length).padStart(4)}  Ø=${(avg*100).toFixed(1)} %  min=${(min*100).toFixed(1)} %`)
}

rows.sort((a, b) => a.implied - b.implied)
console.log(`\n=== Buchmacherübergreifend: ${rows.length} vollständige Team-Über/Unter-Vergleiche ===`)
const bad = rows.filter((r) => r.implied < 0.9)
console.log(`unter 90 %: ${bad.length}\n`)
for (const r of rows.slice(0, 12))
  console.log(`  ${(r.implied*100).toFixed(1).padStart(6)} %  ${r.ev.padEnd(38)} ${r.key.padEnd(26)} ${r.legs.join(' | ')}`)

// Welche Buchmacher-Paare fallen auf?
const pairs = new Map<string, { n: number; bad: number }>()
for (const r of rows) {
  const p = [...r.books].sort().join(' + ')
  const e = pairs.get(p) ?? { n: 0, bad: 0 }
  e.n++; if (r.implied < 0.9) e.bad++
  pairs.set(p, e)
}
console.log(`\n=== Auffällige Paarungen ===`)
for (const [p, e] of [...pairs].sort((a, b) => b[1].bad - a[1].bad).slice(0, 12))
  console.log(`  ${p.padEnd(30)} n=${String(e.n).padStart(4)}  davon unplausibel=${e.bad}`)
