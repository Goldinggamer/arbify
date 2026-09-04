import { AswGateway } from '../aswgateway.ts'
import { pooled } from '../http.ts'
import { noteUnmapped } from '../diagnostics.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL, sportFromLabel } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'

const HOST = 'www.admiralbet.de'

/**
 * Obergrenze für Tiefenabfragen je Durchlauf.
 *
 * Die Abfragen laufen seriell (siehe `fetchDepth`), also kostet jede rund eine
 * Viertelsekunde. Vierzig halten die Phase bei etwa zehn Sekunden — mehr würde
 * den Gesamtlauf dominieren, ohne dass die zusätzlichen Partien noch viel
 * Vergleichsfläche brächten.
 */
const MAX_DEPTH = 40
const FOOTBALL = 'asw:category:10000002'

const gateway = new AswGateway({
  url: 'wss://ws.de.admiral.at/',
  origin: `https://${HOST}`,
  mandatorName: 'admiralbet-de-gt',
  configurationNodeUrn: 'asw:node:admiral:device:6ef60b8b-26fa-4dbb-b719-3c1124acb938',
})

type MarketSpec = { type: CanonicalMarket['type']; period: Period; subject: CanonicalMarket['subject'] }

const MARKET_TYPES = new Map<string, MarketSpec>([
  ['asw:markettype:1', { type: '1X2', period: 'FT', subject: null }],
  ['asw:markettype:60', { type: '1X2', period: 'H1', subject: null }],
  ['asw:markettype:83', { type: '1X2', period: 'H2', subject: null }],
  ['asw:markettype:18', { type: 'OU', period: 'FT', subject: null }],
  ['asw:markettype:18:wl', { type: 'OU', period: 'FT', subject: null }],
  ['asw:markettype:68', { type: 'OU', period: 'H1', subject: null }],
  ['asw:markettype:68:wl', { type: 'OU', period: 'H1', subject: null }],
  ['asw:markettype:90', { type: 'OU', period: 'H2', subject: null }],
  ['asw:markettype:90:wl', { type: 'OU', period: 'H2', subject: null }],
  ['asw:markettype:29', { type: 'BTTS', period: 'FT', subject: null }],
  ['asw:markettype:75', { type: 'BTTS', period: 'H1', subject: null }],
  ['asw:markettype:95', { type: 'BTTS', period: 'H2', subject: null }],
  ['asw:markettype:14', { type: 'EH', period: 'FT', subject: null }],
  ['asw:markettype:65', { type: 'EH', period: 'H1', subject: null }],
  ['asw:markettype:19', { type: 'TEAM_OU', period: 'FT', subject: 'HOME' }],
  ['asw:markettype:20', { type: 'TEAM_OU', period: 'FT', subject: 'AWAY' }],
  ['asw:markettype:69', { type: 'TEAM_OU', period: 'H1', subject: 'HOME' }],
  ['asw:markettype:70', { type: 'TEAM_OU', period: 'H1', subject: 'AWAY' }],
  ['asw:markettype:91', { type: 'TEAM_OU', period: 'H2', subject: 'HOME' }],
  ['asw:markettype:92', { type: 'TEAM_OU', period: 'H2', subject: 'AWAY' }],
  ['asw:markettype:26', { type: 'OE', period: 'FT', subject: null }],
])

const SHALLOW_TYPES = [
  'asw:markettype:1',
  'asw:markettype:18',
  'asw:markettype:18:wl',
  'asw:markettype:29',
  'asw:markettype:14',
]

/**
 * Sportarten samt Kategorie-Kennung.
 *
 * Die Kennungen liegen dicht beieinander (10000002 Fußball, 10000003
 * Basketball, 10000004 Baseball, 10000005 Eishockey, 10000006 Tennis) — sie
 * sind trotzdem einzeln nachgemessen, nicht fortgezählt.
 */
const SPORTS: { category: string; sport: Sport; label: string; shallow: string[] }[] = [
  { category: FOOTBALL, sport: 'FOOTBALL', label: 'Fußball', shallow: SHALLOW_TYPES },
  {
    category: 'asw:category:10000006',
    sport: 'TENNIS',
    label: 'Tennis',
    // Ohne `marketTypes` im Aufruf expandiert das Gateway alles und läuft in
    // den Timeout — nachgemessen, schon bei acht Partien.
    shallow: ['asw:markettype:186', 'asw:markettype:314'],
  },
]

const KNOWN_UNMAPPED = new Set([
  'asw:markettype:41',
  'asw:markettype:47',
  'asw:markettype:10',
  'asw:markettype:63',
  'asw:markettype:11',
  'asw:markettype:8',
  'asw:markettype:52',
  'asw:markettype:31',
  'asw:markettype:32',
  'asw:markettype:48',
  'asw:markettype:49',
  'asw:markettype:56',
  'asw:markettype:57',
])

/**
 * Tennis-Märkte.
 *
 * Anders als beim Fußball reicht hier keine Tabelle Typ → Markt: der
 * Satzsieger läuft über **einen** Typ (`202`, "{!setnr} set - winner") und
 * trägt die Satznummer in `properties.setnr`. Und `properties.hcp` ist beim
 * Tennis eine **Zahl** (−1,5), beim Fußball dagegen die Zeichenkette "0:1" —
 * dieselbe Eigenschaft, zwei Formate.
 */
function toTennisMarket(typeUrn: string, props: Record<string, any>): CanonicalMarket | null {
  const num = (v: unknown): number | null => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  // Der Typ trägt bei manchen Märkten einen Variantenzusatz
  // ("asw:markettype:196:sr:exact_sets:bestof:3"); der Rumpf entscheidet.
  const base = typeUrn.split(':').slice(0, 3).join(':')

  switch (base) {
    case 'asw:markettype:186':
      return { type: '2WAY', period: 'FT', line: null, subject: null }

    case 'asw:markettype:202': {
      const n = num(props.setnr)
      return n && n >= 1 && n <= 5
        ? { type: '2WAY', period: `S${n}` as CanonicalMarket['period'], line: null, subject: null }
        : null
    }

    case 'asw:markettype:188': {
      // `hcp` steht aus Sicht von competitor1, also der Heimseite: bei −1,5
      // heißt die erste Auswahl "{$competitor1} ({+hcp})" und damit −1,5.
      const line = num(props.hcp)
      return line === null ? null : { type: 'AH', period: 'FT', line, subject: null, unit: 'SETS' }
    }

    case 'asw:markettype:314': {
      const line = num(props.total)
      return line === null ? null : { type: 'OU', period: 'FT', line, subject: null, unit: 'SETS' }
    }

    default:
      return null
  }
}

/**
 * Tennis-Typen, die bekannt und bewusst nicht zugeordnet sind.
 *
 * `196` ("Exact sets") ist mit den Auswahlmöglichkeiten "2" und "3" im
 * Best-of-3 rechnerisch dasselbe wie Über/Unter 2,5 Sätze — zugeordnet wird es
 * trotzdem nicht: AdmiralBet liefert daneben `314` ("Total sets") mit genau
 * dieser Linie. Beide zugleich hieße zwei Quoten desselben Buchs auf derselben
 * Seite, und damit wäre die Kollisionszählung als Warnsystem entwertet.
 */
const KNOWN_UNMAPPED_TENNIS = /^asw:markettype:(19[23]|196|199|201|203|204|205)\b/

function sideOf(name: string | undefined): Side | null {
  if (!name) return null
  const n = name.trim().toLowerCase()
  if (n.startsWith('{$competitor1}')) return 'HOME'
  if (n.startsWith('{$competitor2}')) return 'AWAY'
  if (n.startsWith('draw')) return 'DRAW'
  if (n.startsWith('over')) return 'OVER'
  if (n.startsWith('under')) return 'UNDER'
  if (n === 'yes') return 'YES'
  if (n === 'no') return 'NO'
  if (n === 'odd') return 'ODD'
  if (n === 'even') return 'EVEN'
  return null
}

function lineOf(spec: MarketSpec, props: Record<string, any>): number | null {
  if (spec.type === 'OU' || spec.type === 'TEAM_OU') {
    const total = Number(props.total)
    return Number.isFinite(total) ? total : null
  }
  if (spec.type === 'EH') {
    const hcp = String(props.hcp ?? '')
    const [h, a] = hcp.split(':').map(Number)
    return Number.isFinite(h) && Number.isFinite(a) ? h - a : null
  }
  return null
}

type AswEvent = {
  urn: string
  name?: string
  startTime?: string
  state?: number
  competition?: string
  eventCompetitors?: { qualifier?: string; competitor?: string }[]
  markets?: string[]
}

function teamsOf(ev: AswEvent): { home: string; away: string } | null {
  const nameOf = (q: string) =>
    gateway.entity<{ name?: string }>(ev.eventCompetitors?.find((c) => c.qualifier === q)?.competitor)?.name
  const home = nameOf('home')
  const away = nameOf('away')
  if (home && away) return { home, away }
  const parts = (ev.name ?? '').split(' : ')
  return parts.length === 2 && parts[0] && parts[1] ? { home: parts[0].trim(), away: parts[1].trim() } : null
}

function leagueOf(ev: AswEvent): string {
  const comp = gateway.entity<{ name?: string; translations?: Record<string, string> }>(ev.competition)
  return comp?.translations?.de || comp?.name || 'Unbekannt'
}

function collectEvents(view: any): AswEvent[] {
  const refs = new Set<string>()
  for (const g of view?.body?.groupDatas ?? []) {
    for (const d of [...(g.preMatchEventDatas ?? []), ...(g.inPlayEventDatas ?? [])]) {
      if (d?.event) refs.add(String(d.event))
    }
  }
  return [...refs].map((u) => gateway.entity<AswEvent>(u)).filter((e): e is AswEvent => Boolean(e?.urn))
}

function outcomesByEvent(ev: AswEvent, sport: Sport = 'FOOTBALL'): RawOutcome[] {
  const out: RawOutcome[] = []
  const wanted = new Set(ev.markets ?? [])
  for (const urn of wanted) {
    const m = gateway.entity<any>(urn)
    if (!m?.selections || m.state !== 1) continue

    let market: CanonicalMarket | null
    if (sport === 'TENNIS') {
      market = toTennisMarket(String(m.type), m.properties ?? {})
      if (!market) {
        if (!KNOWN_UNMAPPED_TENNIS.test(String(m.type))) {
          const mt = gateway.entity<{ name?: string }>(String(m.type))
          noteUnmapped('admiralbet', `TENNIS ${m.type} | ${mt?.name ?? ''}`)
        }
        continue
      }
    } else {
      const spec = MARKET_TYPES.get(String(m.type))
      if (!spec) {
        if (!KNOWN_UNMAPPED.has(String(m.type))) {
          const mt = gateway.entity<{ name?: string }>(String(m.type))
          noteUnmapped('admiralbet', `${m.type} | ${mt?.name ?? ''}`)
        }
        continue
      }
      const line = lineOf(spec, m.properties ?? {})
      if ((spec.type === 'OU' || spec.type === 'TEAM_OU' || spec.type === 'EH') && line === null) continue
      market = { type: spec.type, period: spec.period, line, subject: spec.subject }
    }

    for (const su of m.selections as string[]) {
      const sel = gateway.entity<{ type?: string; odds?: number; state?: number }>(su)
      if (!sel || sel.state !== 1) continue
      const odds = Number(sel.odds)
      if (!Number.isFinite(odds) || odds <= 1) continue
      const side = sideOf(gateway.entity<{ name?: string }>(sel.type)?.name)
      if (!side) continue
      out.push({ market, side, odds })
    }
  }
  return out
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

function buildEvent(ev: AswEvent, outcomes: RawOutcome[], now: string, label = 'Fußball'): RawEvent | null {
  const teams = teamsOf(ev)
  const start = new Date(ev.startTime ?? '').getTime()
  if (!teams || !Number.isFinite(start) || !outcomes.length) return null

  const id = ev.urn.split(':').pop() ?? ''
  return {
    bookmakerId: 'admiralbet',
    bookEventId: ev.urn,
    sportradarId: null,
    sport: label,
    league: leagueOf(ev),
    home: teams.home,
    away: teams.away,
    startTime: new Date(start).toISOString(),
    isLive: ev.state === 5,
    url: `https://${HOST}/de/sports/sportwetten/${label === 'Tennis' ? 'tennis' : 'fussball'}?t=${id}&e=${slug(teams.home)}-vs-${slug(teams.away)}`,
    outcomes,
    fetchedAt: now,
  }
}

export const admiralbet: BookmakerAdapter = {
  id: 'admiralbet',
  name: 'AdmiralBet',
  transport: 'websocket',

  async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
    const cutoff = Date.now() + ctx.windowMs
    const now = new Date().toISOString()
    const out: RawEvent[] = []

    for (const spec of SPORTS) {
      const view = await gateway.request('RetrieveSportsbookView', {
        categories: [spec.category],
        expandedEventCount: Math.min(ctx.maxEvents, 250),
        marketTypes: spec.shallow,
      })

      for (const ev of collectEvents(view)) {
        const start = new Date(ev.startTime ?? '').getTime()
        if (!Number.isFinite(start) || start > cutoff) continue
        const built = buildEvent(ev, outcomesByEvent(ev, spec.sport), now, SPORT_LABEL[spec.sport])
        if (built) out.push(built)
        if (out.length >= ctx.maxEvents) break
      }
    }
    return out
  },

  /**
   * Tiefe **seriell**, nicht zu viert.
   *
   * Nachgemessen an denselben vier Partien: nebenläufig wurde genau eine
   * vertieft, einzeln alle vier — 33→102, 38→111, 38→113, 38→111 Quoten. Über
   * einen ganzen Durchlauf hieß das `vertieft=1/120` statt 120, und die
   * Team-Totals von AdmiralBet fehlten dadurch zeitweise vollständig.
   *
   * Die Ursache liegt im Gateway: `RetrieveDetailView` liefert seine Entitäten
   * nicht in der Antwort, sondern über den gemeinsamen Snapshot-Strom, und der
   * Aufrufer liest sie danach aus `gateway.entity()`. Laufen mehrere Abfragen
   * gleichzeitig, ist beim Auslesen nicht zugesichert, dass die Entitäten der
   * *eigenen* Partie schon oder noch da sind. Das ist ein Fehler der
   * Transportschicht und war lange vor Tennis da — er fiel nur nie auf, weil
   * eine niedrige Vertiefungsquote wie ein langsamer Anbieter aussieht und
   * nicht wie ein Fehler.
   *
   * Bis das Gateway seine Antworten selbst zuordnet, ist Serialisieren die
   * belastbare Lösung. `MAX_DEPTH` deckelt die Laufzeit.
   */
  async fetchDepth(events: RawEvent[]): Promise<RawEvent[]> {
    const targets = events.slice(0, MAX_DEPTH)
    const results = await pooled(targets, 1, async (ev) => {
      await gateway.request('RetrieveDetailView', { event: ev.bookEventId })
      const entity = gateway.entity<AswEvent>(ev.bookEventId)
      if (!entity) return ev
      const sport: Sport = sportFromLabel(ev.sport) ?? 'FOOTBALL'
      const outcomes = outcomesByEvent(entity, sport)
      return outcomes.length > ev.outcomes.length
        ? { ...ev, outcomes, fetchedAt: new Date().toISOString() }
        : ev
    })
    return results.map((r, i) => (r.status === 'fulfilled' ? r.value : targets[i]))
  },
}
