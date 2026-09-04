/**
 * 888sport.de — Spectate-Plattform, Zugang von außen.
 *
 * Der Weg dorthin, jeder Schritt gemessen:
 *
 *  1. Ohne alles antwortet `spectate-web.888sport.de` mit **403** und
 *     `server: awselb/2.0` — das ist der AWS-Load-Balancer, nicht die App.
 *     Kein Header der Welt kommt daran vorbei.
 *  2. Ein Abruf von `www.888sport.de` setzt zwei **HttpOnly**-Kekse,
 *     `888Attribution` und `888Cookie`. Damit wechselt die Antwort auf
 *     `server: nginx` — der Balancer lässt durch, jetzt redet die App.
 *     Genau deshalb war der Keks aus `document.cookie` nie zu finden.
 *  3. Die App will zusätzlich `spectate_client_ver`. Ohne den: 406.
 *
 * Der Einstieg ist `POST /spectate/load/state` als **multipart/form-data**.
 * Die Feldwerte stehen fest je Marke und stammen aus dem Webpack-Modul 30702
 * der Seite — über `webpackChunksportsbookweb.push` an das `require` gekommen,
 * dann das Modul ausgelesen:
 *
 *   brand_id 84 · sub_brand_id 136 · marketing_brand_id 1
 *   regulation_type_id 12 · product_package_id 112
 *   language "deu" · currency_code "EUR" · browsing_country_code "DEU"
 *
 * Offene Frage, die diese Sonde klärt: Spectate schreibt seine Sitzung über
 * `Set-Cookie` fort. Ein einzelner Abruf reicht also nicht — der Keksbeutel
 * muss über alle Anfragen hinweg mitwachsen.
 */
import { Impit } from 'impit'

const WEB = 'https://www.888sport.de'
const API = 'https://spectate-web.888sport.de/spectate'

const impit = new Impit({ browser: 'chrome' })

/** Keksbeutel, der über alle Antworten hinweg fortgeschrieben wird. */
const jar = new Map<string, string>()

function absorb(res: { headers: Headers }): string[] {
  const added: string[] = []
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    if (i <= 0) continue
    const name = pair.slice(0, i).trim()
    if (!jar.has(name)) added.push(name)
    jar.set(name, pair.slice(i + 1))
  }
  return added
}

const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')

const headers = () => ({
  origin: WEB,
  referer: `${WEB}/`,
  accept: '*/*',
  'accept-language': 'de-DE,de;q=0.9',
  cookie: cookie(),
})

// 1. Seitenabruf: HttpOnly-Kekse einsammeln
const page = await impit.fetch(`${WEB}/fussball/`, { headers: { 'accept-language': 'de-DE,de;q=0.9' } })
console.log(`Seite ${page.status} → Kekse: ${absorb(page).join(', ')}`)
jar.set('spectate_client_ver', '2.163')
jar.set('lastproduct', 'sport')

// 2. Version gegenprüfen — vielleicht ist 2.163 veraltet
const ver = await impit.fetch(`${API}/client/getLatestVersion`, { headers: headers() })
const verText = await ver.text()
absorb(ver)
console.log(`getLatestVersion ${ver.status}: ${verText.slice(0, 160).replace(/\s+/g, ' ')}`)

// 3. Bootstrap
const STATE_FIELDS: Record<string, string> = {
  currency_code: 'EUR',
  language: 'deu',
  sub_brand_id: '136',
  brand_id: '84',
  marketing_brand_id: '1',
  regulation_type_id: '12',
  timezone: '-2',
  browsing_country_code: 'DEU',
  product_package_id: '112',
  user_mode: 'Anonymous',
  spectate_timezone: 'Europe/Berlin',
  device: 'PC',
  referrer: '',
  region: 'by',
  theme_mode: '1',
}
const form = new FormData()
for (const [k, v] of Object.entries(STATE_FIELDS)) form.append(k, v)

const state = await impit.fetch(`${API}/load/state`, { method: 'POST', headers: headers(), body: form })
const stateText = await state.text()
console.log(`POST /load/state → ${state.status}  ${Math.round(stateText.length / 1024)}KB  neue Kekse: ${absorb(state).join(', ') || 'keine'}`)

// 4. Jetzt die Datenendpunkte
console.log('\n--- HTTP-Endpunkte mit fortgeschriebener Sitzung ---')
const GETS = [
  '/homepage/widgets',
  '/inplay-req/getScheduledEvents',
  '/inplay-req/getScheduledEvents?sport_id=1&period=today',
  '/inplay-req/getInplayEvents',
  '/translation/urlPath',
]
for (const p of GETS) {
  const r = await impit.fetch(API + p, { headers: headers() })
  const t = await r.text()
  absorb(r)
  const odds = (t.match(/"(?:odds|price|decimal|dec)"\s*:\s*"?[\d.]+/gi) ?? []).length
  console.log(`${String(r.status).padEnd(4)} ${String(Math.round(t.length / 1024) + 'KB').padStart(7)}  Quoten ${String(odds).padStart(5)}  ${p}`)
  if (r.status === 200 && t.length > 200) {
    try {
      console.log(`      Schlüssel: ${Object.keys(JSON.parse(t)).slice(0, 14).join(', ')}`)
    } catch {
      console.log(`      ${t.slice(0, 150).replace(/\s+/g, ' ')}`)
    }
  }
}
