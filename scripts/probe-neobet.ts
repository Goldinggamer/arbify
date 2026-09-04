/**
 * Erkundet den Sportsbet-Namensraum von NEO.bet.
 *
 * Aus dem Ressourcen-Mitschnitt der Seite stammt ein einziger Treffer:
 *   /.sportsbet/program/matches?language=de&license=DE&market=OddsBoost&matchCount=5
 *
 * Das Muster ist also `/.sportsbet/{bereich}/{aktion}` mit `language`,
 * `license` und einem `market`-Parameter. Gesucht: die vollständige
 * Fußball-Liste statt der fünf Boost-Spiele.
 */
import { Impit } from 'impit'

const impit = new Impit({ browser: 'chrome' })
const BASE = 'https://neobet.de/.sportsbet'
const H = {
  'accept-language': 'de-DE,de;q=0.9',
  accept: 'application/json, text/plain, */*',
  referer: 'https://neobet.de/de/Sportwetten/Heute',
}
const Q = 'language=de&license=DE'

const PATHS = [
  // Der belegte Aufruf — als Kontrolle, und ohne den Boost-Filter
  `/program/matches?${Q}&market=OddsBoost&matchCount=5`,
  `/program/matches?${Q}&matchCount=200`,
  `/program/matches?${Q}`,
  // Naheliegende Nachbarn im selben Bereich
  `/program/sports?${Q}`,
  `/program/categories?${Q}`,
  `/program/tournaments?${Q}`,
  `/program/leagues?${Q}`,
  `/program/events?${Q}`,
  `/program/tree?${Q}`,
  `/program/overview?${Q}`,
  `/program/upcoming?${Q}&matchCount=200`,
  `/program/today?${Q}`,
  // Fußball gezielt (Sport-ID 1 ist die übliche Konvention)
  `/program/matches?${Q}&sportId=1&matchCount=200`,
  `/program/matches?${Q}&sport=football&matchCount=200`,
  // Andere Bereiche
  `/offer/matches?${Q}`,
  `/betting/matches?${Q}`,
  `/match/odds?${Q}`,
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const p of PATHS) {
  try {
    const r = await impit.fetch(BASE + p, { headers: H })
    const t = await r.text()
    if (r.status === 404) {
      console.log(`404  ${p.slice(0, 70)}`)
      continue
    }
    const odds = (t.match(/"odds"\s*:\s*[\d.]/g) ?? []).length
    const matches = (t.match(/"matchId"|"eventId"|"fixtureId"/g) ?? []).length
    console.log(
      `${String(r.status).padEnd(4)} ${String(Math.round(t.length / 1024) + 'KB').padStart(7)}  ` +
        `Quoten ${String(odds).padStart(5)}  IDs ${String(matches).padStart(5)}  ${p.slice(0, 62)}`,
    )
    // Bei einem ergiebigen Treffer die Struktur zeigen
    if (r.status === 200 && odds > 20) {
      try {
        const j = JSON.parse(t)
        const root = Array.isArray(j) ? j[0] : (Object.values(j).find(Array.isArray) as unknown[])?.[0] ?? j
        console.log(`     Schlüssel: ${Object.keys(root as object).slice(0, 14).join(', ')}`)
      } catch {
        /* kein JSON */
      }
    }
  } catch (e) {
    console.log(`ERR  ${p.slice(0, 60)}  ${e instanceof Error ? e.message.slice(0, 40) : ''}`)
  }
  await sleep(200)
}
