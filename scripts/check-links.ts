import { ADAPTERS } from '../server/adapters/index.ts'
import { Impit } from 'impit'

/**
 * Prüft die Tiefenlinks aller Anbieter gegen die echten Websites.
 *
 * Ein Link, der auf einer 404-Seite oder der Startseite landet, kostet bei
 * jeder Meldung die Suche von Hand — bei einer Arbitrage zählt die Minute.
 * Genau so war es bei LeoVegas: jede Partie musste gesucht werden, weil der
 * Pfad `/de-de/sports/event/{id}` nie existiert hat.
 *
 * Je Anbieter werden zwei Partien aus dem Sweep gezogen und ihre Adresse
 * abgerufen. Ausgegeben werden HTTP-Status, Weiterleitung, Seitentitel und
 * ob die Teamnamen im HTML stehen. Die letzte Spalte ist der eigentliche
 * Beleg — aber nur bei Seiten, die serverseitig rendern. Reine
 * Browser-Anwendungen (Tipico, WettArena, NEO.bet, Sportwetten.de, AdmiralBet)
 * liefern immer dieselbe Hülle, teils mit Status 404, und zeigen die Partie
 * trotzdem; die sind nur im Browser zu prüfen.
 *
 *   node scripts/check-links.ts
 */

const impit = new Impit({ browser: 'chrome', followRedirects: true })
const ctx = { windowMs: 24 * 3600_000, maxEvents: 400 }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim()

async function probe(url: string, home: string, away: string): Promise<string> {
  try {
    const r = await impit.fetch(url, { headers: { 'Accept-Language': 'de-DE,de;q=0.9' } })
    const html = await r.text()
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim().slice(0, 50) ?? '—'
    const body = norm(html)
    const hits = [home, away].map(norm).filter((n) => n.length > 3 && body.includes(n)).length
    const redirect = r.url && r.url !== url ? ` → ${r.url}` : ''
    return `${r.status}${redirect}  „${title}"  Teams im HTML: ${hits}/2`
  } catch (e) {
    return `FEHLER ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`
  }
}

const sweeps = await Promise.allSettled(
  ADAPTERS.map(async (a) => ({ a, events: await a.fetchEvents(ctx) })),
)

for (const s of sweeps) {
  if (s.status !== 'fulfilled') {
    console.log(`\n### ${s.reason}`)
    continue
  }
  const { a, events } = s.value
  console.log(`\n### ${a.id} — ${events.length} Events`)
  const picks = [events[0], events[Math.floor(events.length / 2)]].filter(Boolean)
  const seen = new Set<string>()
  for (const e of picks) {
    if (seen.has(e.url)) continue
    seen.add(e.url)
    console.log(`  ${e.sport} · ${e.home} — ${e.away}\n  ${e.url}\n    ${await probe(e.url, e.home, e.away)}`)
  }
}
process.exit(0)
