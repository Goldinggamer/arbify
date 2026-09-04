/**
 * Tipwin — `api-web.tipwin.de/v2/{agency}/offer/…`
 *
 * Aus dem Netzwerkmitschnitt:
 *   /v2/100501/offer/sport-menu?filter=<Token>
 *   /v2/100501/offer/data?filter=<Token>
 *
 * Der `filter` ist ein undurchsichtiger Token (~100 Zeichen, base62). Wenn er
 * clientseitig verschlüsselt wird, ist der Endpunkt ohne Reverse Engineering
 * des Bundles nicht nutzbar. Erste Frage also: antwortet er auch ohne Filter
 * oder mit einem geklauten Token aus einer anderen Sitzung?
 */
import { Impit } from 'impit'

const impit = new Impit({ browser: 'chrome' })
const BASE = 'https://api-web.tipwin.de/v2/100501'
const H = {
  'accept-language': 'de-DE,de;q=0.9',
  accept: 'application/json, text/plain, */*',
  origin: 'https://www.tipwin.de',
  referer: 'https://www.tipwin.de/',
}

// Token aus der laufenden Browser-Sitzung — wenn er auch hier trägt, ist er
// nicht an Sitzung oder Zeit gebunden.
const MENU_TOKEN =
  'MxxdjgtqE8Zh09NxqAKhlDtWpHzGt6pmCVj4XxLOXGWPYau7PSCQFrazrbdRxd53Z5yzUWpakKqqOEVznyfnoI4f67VFqlj5n5Fs61JaPBCl2w'
const DATA_TOKEN =
  'DG3FLOWPjC4u9Y445CPka4ignZRca33FeK2rzbSOF0WtgYPMC65rG25zdYw7jBQSHuum3y2Jg8MWy45hEpJRwWYEXh2I8l1flXmtalvbPwHC1Hd81gZl'

const PATHS = [
  ['Menü, geklauter Token', `/offer/sport-menu?filter=${MENU_TOKEN}`],
  ['Daten, geklauter Token', `/offer/data?filter=${DATA_TOKEN}`],
  ['Menü ohne Filter', '/offer/sport-menu'],
  ['Daten ohne Filter', '/offer/data'],
  ['Daten, leerer Filter', '/offer/data?filter='],
  ['Daten, Klartext-JSON', `/offer/data?filter=${encodeURIComponent('{"sportId":1}')}`],
  ['offer', '/offer'],
  ['offer/events', '/offer/events'],
  ['offer/sports', '/offer/sports'],
]

for (const [label, p] of PATHS) {
  try {
    const r = await impit.fetch(BASE + p, { headers: H })
    const t = await r.text()
    const odds = (t.match(/"(?:odd|value|rate|quote)"\s*:\s*\d+\.\d/gi) ?? []).length
    console.log(
      `${String(r.status).padEnd(4)} ${String(Math.round(t.length / 1024) + 'KB').padStart(7)}  ` +
        `Quoten ${String(odds).padStart(5)}  ${label}`,
    )
    if (r.status === 200 && t.length > 400) console.log(`      ${t.slice(0, 260).replace(/\s+/g, ' ')}`)
    else if (r.status >= 400) console.log(`      ${t.slice(0, 180).replace(/\s+/g, ' ')}`)
  } catch (e) {
    console.log(`ERR   ${label}  ${e instanceof Error ? e.message.slice(0, 60) : ''}`)
  }
  await new Promise((s) => setTimeout(s, 250))
}
