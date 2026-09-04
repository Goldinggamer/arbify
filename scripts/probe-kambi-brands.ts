/**
 * Sucht die Kambi-Markenkennung für 888sport (deutscher Markt).
 *
 * Beim ersten Versuch lieferten die Hälfte der Kandidaten HTTP 429 — ich habe
 * also nie erfahren, ob sie gültig sind. Diese Sonde wartet deshalb bewusst
 * zwischen den Anfragen und wiederholt gedrosselte Kandidaten.
 *
 * Bekannt: `888it` (Italien) und `leo` (LeoVegas) funktionieren. Der deutsche
 * Code muss also existieren, nur unter welchem Kürzel?
 */
import { Impit } from 'impit'

const impit = new Impit({ browser: 'chrome' })
const H = { 'accept-language': 'de-DE,de;q=0.9' }

const CANDIDATES = [
  // Ländermuster, analog zu 888it
  '888de', '888deu', '888ger', 'de888', 'ger888',
  // Betriebsnamen, die Kambi für 888 verwendet haben könnte
  '888', '888sport', '888sportde', 'sport888', '888sportsde', '888sports',
  // Weitere Kambi-Betreiber zur Gegenprobe (belegen, dass die Sonde greift)
  'ub', 'unibet', 'mrgreen', 'bethard', 'betsson', 'napoleon', 'ncsport',
  'lvse', 'leo', '888it', '888es', '888ie', '888uk',
]

const url = (code: string) =>
  `https://eu-offering-api.kambicdn.com/offering/v2018/${code}/listView/football.json` +
  `?lang=de_DE&market=DE&client_id=2&channel_id=1&ncid=1`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Result = { code: string; status: number | string; events?: number }
const results: Result[] = []
const throttled: string[] = []

async function probe(code: string): Promise<Result> {
  try {
    const r = await impit.fetch(url(code), { headers: H })
    const text = await r.text()
    if (r.status !== 200) return { code, status: r.status }
    try {
      const j = JSON.parse(text)
      return { code, status: 200, events: j.events?.length ?? 0 }
    } catch {
      return { code, status: 200, events: 0 }
    }
  } catch {
    return { code, status: 'ERR' }
  }
}

console.log('Durchgang 1 — alle Kandidaten, 1,2 s Abstand\n')
for (const code of CANDIDATES) {
  const r = await probe(code)
  results.push(r)
  if (r.status === 429) throttled.push(r.code)
  const note = r.status === 200 ? `${r.events} Events` : r.status === 429 ? 'gedrosselt' : ''
  console.log(`  ${code.padEnd(12)} ${String(r.status).padEnd(5)} ${note}`)
  await sleep(1200)
}

if (throttled.length) {
  console.log(`\nDurchgang 2 — ${throttled.length} gedrosselte Kandidaten, 4 s Abstand\n`)
  for (const code of throttled) {
    await sleep(4000)
    const r = await probe(code)
    const note = r.status === 200 ? `${r.events} Events` : r.status === 429 ? 'weiter gedrosselt' : ''
    console.log(`  ${code.padEnd(12)} ${String(r.status).padEnd(5)} ${note}`)
    if (r.status === 200) results.push(r)
  }
}

const working = results.filter((r) => r.status === 200 && (r.events ?? 0) > 0)
console.log(`\nGültige Marken mit deutschem Angebot: ${working.map((w) => `${w.code} (${w.events})`).join(', ') || 'keine'}`)
