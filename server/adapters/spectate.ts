import { Impit } from 'impit'
import type { CanonicalMarket, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'

/**
 * Spectate — Plattform-Adapter, derzeit für 888sport (Deutschland).
 *
 * Vorgeschichte: 888sport.de lief früher auf Kambi, deshalb suchte eine
 * frühere Fassung dieses Projekts vergeblich nach einem deutschen
 * Kambi-Markencode. Den gibt es nicht — die Marke ist auf **Spectate**
 * umgezogen (`brandName: "888.de"`, Frontend von `cdn.spectateprod.com`,
 * API unter `spectate-web.888sport.de`).
 *
 * ## Der Zugang war dreistufig
 *
 * 1. Ohne alles antwortet der API-Host mit **403** und `server: awselb/2.0` —
 *    das ist der AWS-Load-Balancer, nicht die Anwendung. Kein Header kommt
 *    daran vorbei, auch keine Nachbildung des Chrome-Handshakes.
 * 2. Ein Abruf von `www.888sport.de` setzt zwei **HttpOnly**-Kekse,
 *    `888Attribution` und `888Cookie`. Erst damit wechselt die Antwort auf
 *    `server: nginx` — der Balancer lässt durch. Weil die Kekse HttpOnly sind,
 *    tauchen sie in `document.cookie` nicht auf; im Browser war also nicht zu
 *    sehen, woran es lag.
 * 3. `POST /spectate/load/state` als multipart/form-data eröffnet die Sitzung
 *    und liefert per `Set-Cookie` die eigentlichen Sitzungskekse
 *    (`spectate_session`, `anon_hash`, `lang`, `odds_format`). Ohne die
 *    antworten alle Datenendpunkte mit 400.
 *
 * Die Feldwerte des Bootstraps stehen fest je Marke. Sie stammen aus dem
 * Webpack-Modul 30702 der Seite — erreichbar, indem man sich über
 * `webpackChunksportsbookweb.push` das `require` der Anwendung greift und das
 * Modul ausliest.
 *
 * ## Was der Adapter kann — und was nicht
 *
 * `/inplay-req/getScheduledEvents?date=…` liefert das Vorspiel-Programm eines
 * Tages samt Quoten, aber **nur die Siegwette**. Kein Marktumschalter greift:
 * `market_type`, `market_id`, `markets` und `market` wurden durchprobiert, die
 * Antwort bleibt bei drei Auswahlmöglichkeiten je Partie (1/X/2). Die tieferen
 * Märkte hängen an einem Endpunkt, den dieses Bündel nicht kennt, oder am
 * WebSocket aus `websockets:config`.
 *
 * Deshalb gibt es hier **kein `fetchDepth`**. Das ist weniger schlimm, als es
 * klingt: die Siegwette ist der Markt, in dem die meisten Vergleiche
 * überhaupt zustande kommen.
 */

const WEB = 'https://www.888sport.de'
const API = 'https://spectate-web.888sport.de/spectate'

const impit = new Impit({ browser: 'chrome' })

/**
 * Feste Bootstrap-Werte der Marke 888.de.
 *
 * Ändert 888 einen davon, antwortet `load/state` mit 400 statt 200 — der
 * Adapter meldet dann einen Fehler, statt still nichts zu liefern.
 */
const BRAND_FIELDS: Record<string, string> = {
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

/** Aus dem Seitenquelltext; die App schickt ihn als Keks mit. */
const CLIENT_VERSION = '2.163'

type SpSelection = {
  selection_type?: string
  decimal_current_price?: string
  home_team_name?: string
  away_team_name?: string
  visible?: number
  tradable?: number
  active?: number
  suspended?: boolean
  is_market_suspended?: boolean
}

type SpEvent = {
  id?: number
  name?: string
  sport_slug?: string
  event_slug?: string
  scheduled_start?: string
  match_status?: string
  suspended?: boolean
  market_suspended?: boolean
  is_inplay?: boolean
  competitors?: { name?: string; id?: number }[]
}

type SpTournament = { id?: number; name?: string; slug?: string; categorySlug?: string; events?: SpEvent[] }
type SpSport = { name?: string; tournaments?: SpTournament[] }
type SpCoupon = { sports?: SpSport[]; selections?: Record<string, SpSelection[]> }

// --- Sitzung ---------------------------------------------------------------

/**
 * Keksbeutel der laufenden Sitzung.
 *
 * Spectate schreibt die Sitzung über mehrere Antworten hinweg fort, deshalb
 * ein eigener Beutel statt einzelner Header — `impit` führt von sich aus
 * keinen.
 */
let jar = new Map<string, string>()
let sessionOpenedAt = 0

/** Nach dieser Zeit wird neu angemeldet, auch wenn nichts fehlschlug. */
const SESSION_TTL_MS = 10 * 60 * 1000

function absorb(res: Response | { headers: Headers }): void {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1))
  }
}

const headers = (): Record<string, string> => ({
  origin: WEB,
  referer: `${WEB}/`,
  accept: '*/*',
  'accept-language': 'de-DE,de;q=0.9',
  cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
})

async function openSession(): Promise<void> {
  jar = new Map()

  // Schritt 1: HttpOnly-Kekse vom Hauptauftritt holen.
  const page = await impit.fetch(`${WEB}/fussball/`, { headers: { 'accept-language': 'de-DE,de;q=0.9' } })
  absorb(page)
  if (!jar.has('888Cookie')) throw new Error('Spectate: 888sport.de hat keine Sitzungskekse gesetzt')
  jar.set('spectate_client_ver', CLIENT_VERSION)
  jar.set('lastproduct', 'sport')

  // Schritt 2: Sitzung eröffnen.
  const form = new FormData()
  for (const [k, v] of Object.entries(BRAND_FIELDS)) form.append(k, v)
  const state = await impit.fetch(`${API}/load/state`, { method: 'POST', headers: headers(), body: form })
  absorb(state)
  if (state.status !== 200) throw new Error(`Spectate: load/state antwortete ${state.status}`)
  if (!jar.has('spectate_session')) throw new Error('Spectate: keine Sitzungskennung erhalten')

  sessionOpenedAt = Date.now()
}

async function ensureSession(): Promise<void> {
  if (jar.has('spectate_session') && Date.now() - sessionOpenedAt < SESSION_TTL_MS) return
  await openSession()
}

/** Holt einen Datenendpunkt; bei 4xx wird einmal neu angemeldet. */
async function getJson<T>(path: string): Promise<T> {
  await ensureSession()
  let res = await impit.fetch(API + path, { headers: headers() })
  if (res.status >= 400 && res.status < 500) {
    await openSession()
    res = await impit.fetch(API + path, { headers: headers() })
  }
  const text = await res.text()
  absorb(res)
  if (res.status !== 200) throw new Error(`Spectate: HTTP ${res.status} für ${path}`)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Spectate: kein JSON von ${path}`)
  }
}

// --- Abbildung -------------------------------------------------------------

function toSide(type: string | undefined): Side | null {
  switch (type) {
    case '1':
      return 'HOME'
    case 'X':
      return 'DRAW'
    case '2':
      return 'AWAY'
    default:
      return null
  }
}

/**
 * Die Auswahlmöglichkeiten tragen die Mannschaftszuordnung selbst.
 *
 * `competitors` wäre der naheliegende Weg, sagt aber nicht, welche Seite
 * Heim ist — die Reihenfolge im Feed ist keine Zusage. `home_team_name` und
 * `away_team_name` stehen dagegen an jeder Auswahl ausdrücklich dabei.
 */
function teamsOf(sels: SpSelection[], ev: SpEvent): { home: string; away: string } | null {
  const withTeams = sels.find((s) => s.home_team_name && s.away_team_name)
  if (withTeams) return { home: withTeams.home_team_name!, away: withTeams.away_team_name! }
  const parts = (ev.name ?? '').split(/\s+gegen\s+/)
  return parts.length === 2 && parts[0] && parts[1] ? { home: parts[0].trim(), away: parts[1].trim() } : null
}

/**
 * Sportarten, die der Kupon führt.
 *
 * Der Hauptmarkt ist bei Tennis **zweiseitig** — die Auswahl trägt dort nur
 * `1` und `2`, kein `X`. Als `1X2` verbucht verlangte er über `SIDES` ein
 * Unentschieden und wäre nie vollständig geworden.
 */
const SPORTS: { slug: string; sport: Sport; label: string; market: CanonicalMarket }[] = [
  {
    slug: 'football',
    sport: 'FOOTBALL',
    label: 'Fußball',
    market: { type: '1X2', period: 'FT', line: null, subject: null },
  },
  {
    slug: 'tennis',
    sport: 'TENNIS',
    label: 'Tennis',
    market: { type: '2WAY', period: 'FT', line: null, subject: null },
  },
]

const SPORT_BY_SLUG = new Map(SPORTS.map((s) => [s.slug, s]))

function toOutcomes(sels: SpSelection[], market: CanonicalMarket): RawOutcome[] {
  const out: RawOutcome[] = []
  for (const s of sels) {
    if (s.suspended || s.is_market_suspended) continue
    if (s.visible === 0 || s.tradable === 0 || s.active === 0) continue
    const side = toSide(s.selection_type)
    const odds = Number(s.decimal_current_price)
    if (!side || !Number.isFinite(odds) || odds <= 1) continue
    out.push({ market, side, odds })
  }
  return out
}

/** `2026-07-26` in lokaler Zeit — der Endpunkt erwartet Kalendertage. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Kalendertage, die das Zeitfenster berührt.
 *
 * Der Endpunkt kennt nur ganze Tage. Ein 24-Stunden-Fenster reicht deshalb
 * fast immer in den Folgetag hinein und braucht zwei Abrufe.
 */
function daysInWindow(windowMs: number): string[] {
  const days: string[] = []
  const end = Date.now() + windowMs
  for (let d = new Date(); d.getTime() <= end + 86_400_000 && days.length < 5; d.setDate(d.getDate() + 1)) {
    days.push(dayKey(d))
    if (d.getTime() > end) break
  }
  return days
}

export const sport888de: BookmakerAdapter = {
  id: 'sport888de',
  name: '888sport',
  transport: 'impit',

  async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
    const cutoff = Date.now() + ctx.windowMs
    const now = new Date().toISOString()
    const seen = new Set<number>()
    const events: RawEvent[] = []

    for (const day of daysInWindow(ctx.windowMs)) {
      const coupon = await getJson<SpCoupon>(`/inplay-req/getScheduledEvents?date=${day}`)
      const selections = coupon.selections ?? {}

      for (const sport of coupon.sports ?? []) {
        for (const tournament of sport.tournaments ?? []) {
          for (const ev of tournament.events ?? []) {
            // `sports[].name` ist übersetzt und damit kein verlässlicher
            // Filter — die Kennung am Event ist es.
            const spec = SPORT_BY_SLUG.get(String(ev.sport_slug))
            if (!spec) continue
            if (!ev.id || seen.has(ev.id)) continue
            if (ev.suspended || ev.market_suspended) continue

            const start = new Date(ev.scheduled_start ?? '').getTime()
            if (!Number.isFinite(start) || start > cutoff) continue

            const sels = selections[String(ev.id)] ?? []
            const teams = teamsOf(sels, ev)
            const outcomes = toOutcomes(sels, spec.market)
            if (!teams || !outcomes.length) continue

            seen.add(ev.id)
            events.push({
              bookmakerId: 'sport888de',
              bookEventId: String(ev.id),
              // Der Feed nennt als Quelle `supplier_name: "GTP"` und führt
              // keine Sportradar-Kennung — Zuordnung über Namen und Anstoß.
              sportradarId: null,
              sport: SPORT_LABEL[spec.sport],
              league: tournament.name ?? 'Unbekannt',
              home: teams.home,
              away: teams.away,
              startTime: new Date(start).toISOString(),
              isLive: Boolean(ev.is_inplay),
              url: eventUrl(spec.slug),
              outcomes,
              fetchedAt: now,
            })
            if (events.length >= ctx.maxEvents) return events
          }
        }
      }
    }

    return events
  },
}

/**
 * Der Link führt auf die Fußball-Übersicht — mehr ist nicht zu holen.
 *
 * Zwei Wege geprüft, beide sackgassig:
 *
 *  - **Partie-Adressen gibt es nicht.** Alle plausiblen Muster aus den Slugs
 *    des Feeds (`/sportwetten/fussball/{land}/{wettbewerb}/{partie}` und
 *    Varianten) antworten mit 404.
 *  - **Der Alias-Katalog der Plattform hilft nicht.** Er kennt zwar
 *    Wettbewerbe als `t-{id}`, hat aber nur 51 Einträge, und seine Kennungen
 *    liegen in einem anderen Nummernraum als die des Kupons: die dänische Liga
 *    steht dort als `t-321518`, im Kupon heißt dieselbe Liga `t-561824`. Eine
 *    Zuordnung über den Namen wäre Raterei.
 */
const eventUrl = (slug = 'football'): string => `${WEB}/${slug === 'tennis' ? 'tennis' : 'fussball'}/`
