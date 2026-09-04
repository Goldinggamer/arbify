/**
 * Sucht den Sport-Endpunkt der Cashpoint-Plattform (MERKUR BETS).
 *
 * Bekannt aus dem Netzwerkmitschnitt:
 *   /api/translation/byprefix?prefix=…&isoCode=de
 *   /api/v1/cms/getPageSeo?ext_name=…&language=de&domain=…
 *   /api/v1/cms/get?ext_name=ext_menubar_v1_0&…
 *
 * Muster also `/api/{bereich}/{aktion}` bzw. `/api/v1/{bereich}/{aktion}`,
 * teils mit `ext_name`-Parameter im Stil `ext_{modul}_v1_0`.
 */
import { Impit } from 'impit'

const impit = new Impit({ browser: 'chrome' })
const BASE = 'https://apiv3-msw-mb-de.cashpoint.solutions'
const H = {
  'accept-language': 'de-DE,de;q=0.9',
  accept: 'application/json, text/plain, */*',
  origin: 'https://www.merkurbets.de',
  referer: 'https://www.merkurbets.de/',
}

const AREAS = ['sports', 'sport', 'sportsbook', 'betting', 'offer', 'prematch', 'events', 'program']
const ACTIONS = ['get', 'list', 'getAll', 'tree', 'menu', 'categories', 'events', 'overview']
const DOMAIN = 'domain=www.merkurbets.de&language=de'

const paths = new Set<string>()
for (const a of AREAS) {
  paths.add(`/api/v1/${a}/get?${DOMAIN}`)
  paths.add(`/api/${a}?${DOMAIN}`)
  for (const act of ACTIONS) paths.add(`/api/v1/${a}/${act}?${DOMAIN}`)
}
// Der CMS-Bereich funktioniert nachweislich — als Kontrolle mitlaufen lassen
paths.add(`/api/v1/cms/get?ext_name=ext_menubar_v1_0&tag=aurora_footer_menu_left&${DOMAIN}`)
// ext_name-Muster für einen Sportbereich raten
for (const m of ['sportsbook', 'sports', 'betting', 'offer'])
  paths.add(`/api/v1/cms/get?ext_name=ext_${m}_v1_0&${DOMAIN}`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const interesting: string[] = []

for (const p of [...paths]) {
  try {
    const r = await impit.fetch(BASE + p, { headers: H })
    const t = await r.text()
    if (r.status === 404 || r.status === 405) continue
    const hasOdds = /"(?:odds|price|quote|oddValue)"/i.test(t)
    const line = `${String(r.status).padEnd(4)} ${String(t.length).padStart(7)}B  ${hasOdds ? 'QUOTEN  ' : '        '}${p.slice(0, 72)}`
    console.log(line)
    if (r.status === 200 && t.length > 200) interesting.push(p)
  } catch {
    /* nächster */
  }
  await sleep(150)
}

console.log(`\nAntwortende Pfade mit Inhalt: ${interesting.length}`)
for (const p of interesting.slice(0, 8)) console.log('  ' + p)
