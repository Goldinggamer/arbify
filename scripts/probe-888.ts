/**
 * Prüft, was die Kambi-Marke `888it` tatsächlich liefert — und ob 888sport
 * eine eigene deutsche Kennung hat, die bislang nur nicht gefunden wurde.
 *
 * Kernfrage: Der Markencode bestimmt das Angebot, `market`/`lang` nur die
 * Darstellung. Wenn `888it` unter `market=DE` dieselben Events wie unter
 * `market=IT` zeigt, ist es das italienische Buch mit deutschen Beschriftungen.
 *
 * Ergebnis (26.07.2026): genau so — 237 Events, identisch unter DE, IT und GB.
 * Und es gibt keinen deutschen 888-Code, weil 888sport.de gar nicht mehr auf
 * Kambi läuft, sondern auf Spectate. Siehe README, Abschnitt „888sport".
 */
import { Impit } from 'impit'

const impit = new Impit({ browser: 'chrome' })
const API = 'https://eu-offering-api.kambicdn.com/offering/v2018'

const url = (code: string, q: string) => `${API}/${code}/listView/football.json?${q}&client_id=2&channel_id=1&ncid=1`

type Ev = { event: { id: number; homeName?: string; awayName?: string; start?: string } }

async function listing(code: string, q: string): Promise<{ status: number; events: Ev[] }> {
  const r = await impit.fetch(url(code, q), { headers: { 'accept-language': 'de-DE,de;q=0.9' } })
  const t = await r.text()
  if (r.status !== 200) return { status: r.status, events: [] }
  try {
    return { status: 200, events: JSON.parse(t).events ?? [] }
  } catch {
    return { status: 200, events: [] }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const key = (e: Ev) => `${e.event.homeName} — ${e.event.awayName}`

// 1. Liefert 888it unter deutschem und italienischem Markt dasselbe Programm?
for (const q of ['lang=de_DE&market=DE', 'lang=it_IT&market=IT', 'lang=en_GB&market=GB']) {
  const { status, events } = await listing('888it', q)
  console.log(`888it  ${q.padEnd(22)} ${status}  ${events.length} Events`)
  console.log(`       ${events.slice(0, 3).map(key).join(' | ')}`)
  await sleep(1200)
}

// 2. Zur Gegenprobe: LeoVegas (belegt deutsches Buch) — Überschneidung mit 888it
console.log('')
const [de888, leo] = [await listing('888it', 'lang=de_DE&market=DE'), (await sleep(1200), await listing('leo', 'lang=de_DE&market=DE'))]
const set888 = new Set(de888.events.map(key))
const overlap = leo.events.filter((e) => set888.has(key(e)))
console.log(`LeoVegas ${leo.events.length} Events, Überschneidung mit 888it: ${overlap.length}`)

// 3. Gibt es doch eine deutsche 888-Kennung? Weitere Kandidaten, langsam.
console.log('')
for (const code of ['888sportde', '888ger', '888dede', 'eightde', '888at', '888ro', '888dk', '888se']) {
  await sleep(1500)
  const { status, events } = await listing(code, 'lang=de_DE&market=DE')
  console.log(`  ${code.padEnd(12)} ${status}  ${events.length} Events`)
}
