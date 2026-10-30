import { fetchJson, fetchText, pooled } from '../http.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL, sportOf } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { inWindow } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'
import { readStateAfter } from './html-state.ts'
import { deepen } from './depth.ts'
import { nameMatch } from '../players.ts'
import { halfOf, lineFromText, num, oddEvenSide, ouSideFromText, simplify, yesNoSide } from './labels.ts'

/**
 * Betano (Kaizen Gaming). Cloudflare prüft den TLS-Fingerprint, deshalb
 * durchgehend `impit`.
 *
 * Sweep Liga für Liga: die Liga-IDs stehen als Links im Markup der
 * Übersichtsseite. Tiefe: die Event-Seite rendert ihre Märkte ins HTML.
 */

const HOST = 'https://www.betano.de'
const REQ = 'req=s,stnf,c,mb'
/** Kein eigener Mindestabstand — der Takt steht in `HOST_POLICIES` (`server/http.ts`). */
const OPTS = { transport: 'impit' as const }

const LEAGUE_TTL_MS = 30 * 60 * 1000

/**
 * Sportarten samt Übersichtsseite und Event-Endpunkt. Tennis braucht einen
 * eigenen Pfad: `league/hot/upcoming` antwortet dort leer, ohne Fehler.
 */
const SPORTS: {
  sport: Sport
  /** Übersichtsseite, aus deren Markup die Liga-IDs stammen. */
  page: string
  /** Muster im Markup, das die Liga-IDs trägt. */
  linkPattern: RegExp
  events: (leagueId: string) => string
}[] = [
  {
    sport: 'FOOTBALL',
    page: '/sport/fussball/',
    linkPattern: /\/sport\/fussball\/[a-z0-9-]+\/[a-z0-9-]+\/(\d+)\//g,
    events: (id) => `/api/league/hot/upcoming?leagueId=${id}&timeZoneId=Europe/Berlin&${REQ}`,
  },
  {
    sport: 'TENNIS',
    page: '/sport/tennis/',
    linkPattern: /\/sport\/tennis\/[a-z0-9-]+\/[a-z0-9-]+\/(\d+)\//g,
    events: (id) => `/api/sports/TENN/hot/trending/leagues/${id}/events?timeZoneId=Europe/Berlin&${REQ}`,
  },
]

type Selection = { id: string; name: string; fullName?: string; price: number; handicap?: number }
type Market = {
  id: string
  name: string
  type: string
  handicap?: number
  selections: Selection[]
  /** Bei „SuperQuoten"-Märkten gesetzt — dann ohne Marge gerechnet. */
  hasZeroRake?: boolean
  /** Trägt bei beworbenen Märkten den Hinweistext auf die SuperQuoten. */
  marketNotes?: string
}

/** Beworbener Markt (Quotenboost)? Je nach Markt trägt er das eine oder das andere Merkmal. */
const istBoost = (m: Market): boolean =>
  m.hasZeroRake === true || /superquote/i.test(m.marketNotes ?? '')
type Teams = { home: string; away: string }

type BetanoEvent = {
  id: string
  name: string
  shortName?: string
  startTime: number
  url?: string
  betRadarId?: number
  leagueName?: string
  leagueDescription?: string
  regionName?: string
  live?: boolean
  markets?: Market[]
}

const periodOf = (name: string, type: string): Period => halfOf(`${name} ${type}`) ?? 'FT'

/**
 * Marktfamilie ohne Linie: Betano bündelt alle Torgrenzen in einem Markt
 * ("Über 0,5" bis "Unter 6,5"), die Linie trägt jede Auswahl selbst.
 */
type MarketFamily = { type: CanonicalMarket['type']; period: Period; subject: CanonicalMarket['subject'] }

/** Markttypen, die eine Linie brauchen — ohne sie ist der Markt unbrauchbar. */
const NEEDS_LINE = new Set<CanonicalMarket['type']>(['OU', 'TEAM_OU', 'EH', 'AH'])

function toFamily(m: Market): MarketFamily | null {
  const name = (m.name ?? '').toLowerCase()
  const type = (m.type ?? '').toUpperCase()
  const period = periodOf(m.name ?? '', m.type ?? '')

  // `MR12` ist die beworbene Fassung des Endergebnisses ("SuperQuoten").
  if (type === 'MRES' || type === 'MR12' || name.startsWith('endergebnis'))
    return { type: '1X2', period: 'FT', subject: null }
  if (type === 'H1RS' || name.includes('1. halbzeit - ergebnis'))
    return { type: '1X2', period: 'H1', subject: null }

  if (type === 'BTSC' || type === 'GGNG' || name.includes('beide teams treffen'))
    return { type: 'BTTS', period, subject: null }

  if (type === 'OEGL' || name.includes('ungerade/gerade') || name.includes('gerade/ungerade'))
    return { type: 'OE', period, subject: null }

  // Team-Totals vor dem allgemeinen Über/Unter.
  if (type === 'OUHG') return { type: 'TEAM_OU', period, subject: 'HOME' }
  if (type === 'OUAG') return { type: 'TEAM_OU', period, subject: 'AWAY' }

  // Ausdrückliche Liste statt Präfix `OU`: Ecken und Karten heißen nach demselben Muster.
  if (type === 'HCTG' || type === 'OVUN' || type === 'TOTG' || name.includes('gesamtzahl tore')) {
    const p: Period = type === 'OUH1' ? 'H1' : type === 'OUH2' ? 'H2' : period
    return { type: 'OU', period: p, subject: null }
  }
  if (type === 'OUH1') return { type: 'OU', period: 'H1', subject: null }
  if (type === 'OUH2') return { type: 'OU', period: 'H2', subject: null }

  if (type === 'EHND' || type === 'HAND') return { type: 'EH', period, subject: null }

  // Bekannt und bewusst draußen. `FHMR` ist das Ganzspiel-Handicap, kam aber
  // nie mit Auswahlmöglichkeiten — Vorzeichen und Seiten sind ungemessen.
  // Manche Märkte tragen numerische Typen, deshalb auch über den Namen.
  const knownName =
    /genaues ergebnis|doppelte chance|halbzeit\/|halbzeit ?\/ ?endergebnis|geld zurück|torschütze|handicap spielergebnis|wird sich qualifizieren|qualifikationsmethode|gewinnmethode|wer gewinnt den pokal/.test(
      name,
    )
  if (!['DBLC', 'HTFT', 'CSFT', 'DNOB', 'PSCR', 'FHMR'].includes(type) && !knownName)
    noteUnmapped('betano', `${m.type} :: ${m.name}`)
  return null
}

/** Tennis: `TGHC`/`TGOU` zählen in Spielen, deshalb mit Einheit. */
function toTennisFamily(m: Market): (MarketFamily & { unit?: 'GAMES' | 'SETS' }) | null {
  const type = (m.type ?? '').toUpperCase()
  const name = m.name ?? ''

  switch (type) {
    // "Sieger". `HTHP` ist die beworbene Fassung von `HTOH` — dieselbe Wette,
    // derselbe Schlüssel; die Bedingungen trägt der Hinweis `promo-odds`.
    case 'HTOH':
    case 'HTHP':
      return { type: '2WAY', period: 'FT', subject: null }

    // "Satz-Sieger (Satz 1)" — die Satznummer steht nur im Namen.
    case 'STWN': {
      const n = /satz\s*([1-5])/i.exec(name)?.[1]
      return n ? { type: '2WAY', period: `S${n}` as Period, subject: null } : null
    }

    case 'TGHC':
      return { type: 'AH', period: 'FT', subject: null, unit: 'GAMES' }
    case 'TGOU':
    case 'FTGO':
      return { type: 'OU', period: 'FT', subject: null, unit: 'GAMES' }

    default:
      // Bekannt und bewusst draußen: Satzwette (`BTOF`) und "gewinnt einen Satz".
      if (!/^(BTOF|P[12]WS|CSFT|PSCR)$/.test(type) && !/satzwette|gewinnt einen satz|genaues ergebnis/i.test(name))
        noteUnmapped('betano', `TENNIS ${m.type} :: ${m.name}`)
      return null
  }
}

function toSide(sel: Selection, market: CanonicalMarket, teams?: Teams): Side | null {
  const n = (sel.name ?? '').trim().toLowerCase()

  // Tennis: Seiten tragen den Spielernamen, teils mit Linie ("Cerundolo -2.5").
  if (market.type === '2WAY' || market.type === 'AH') {
    if (n === '1') return 'HOME'
    if (n === '2') return 'AWAY'
    if (!teams) return null
    const who = (sel.name ?? '').replace(/\s*[+-]\s*[\d.,]+\s*$/, '').trim()
    const h = nameMatch(who, teams.home)
    const a = nameMatch(who, teams.away)
    if (h > a) return 'HOME'
    if (a > h) return 'AWAY'
    return null
  }

  if (market.type === '1X2' || market.type === 'EH') {
    if (n === '1') return 'HOME'
    if (n === 'x') return 'DRAW'
    if (n === '2') return 'AWAY'
    // Das Halbzeitergebnis beschriftet seine Seiten mit den Mannschaftsnamen.
    if (n === 'unentschieden' || n === 'remis') return 'DRAW'
    if (teams) {
      const s = simplify(sel.name ?? '')
      if (s && s === simplify(teams.home)) return 'HOME'
      if (s && s === simplify(teams.away)) return 'AWAY'
    }
    return null
  }
  if (market.type === 'OU' || market.type === 'TEAM_OU') return ouSideFromText(n)
  if (market.type === 'BTTS') return yesNoSide(n)
  if (market.type === 'OE') return oddEvenSide(n)
  return null
}

/**
 * Linie einer Auswahl: zuerst ihre eigene, dann die des Markts (bei
 * gebündelten Märkten nur die erste Linie), zuletzt die Beschriftung.
 */
function lineOf(family: MarketFamily, sel: Selection, m: Market): number | null {
  if (!NEEDS_LINE.has(family.type)) return null
  if (typeof sel.handicap === 'number' && Number.isFinite(sel.handicap)) return sel.handicap
  if (typeof m.handicap === 'number' && Number.isFinite(m.handicap)) return m.handicap
  return lineFromText(sel.name ?? '')
}

export function toOutcomes(ev: BetanoEvent, teams?: Teams, sport: Sport = 'FOOTBALL'): RawOutcome[] {
  const out: RawOutcome[] = []
  for (const m of ev.markets ?? []) {
    const family = sport === 'TENNIS' ? toTennisFamily(m) : toFamily(m)
    if (!family) continue
    for (const sel of m.selections ?? []) {
      const odds = num(sel.price)
      if (odds === null || odds <= 1) continue
      const line = lineOf(family, sel, m)
      if (line === null && NEEDS_LINE.has(family.type)) continue
      const market: CanonicalMarket = { ...family, line }
      const side = toSide(sel, market, teams ?? teamsOf(ev))
      if (side) out.push(istBoost(m) ? { market, side, odds, promo: true } : { market, side, odds })
    }
  }
  return out
}

/** "Randers FC - Silkeborg IF" → beide Mannschaften. */
function teamsOf(e: BetanoEvent): Teams | undefined {
  const [home, away] = (e.shortName ?? e.name ?? '').split(' - ')
  return home?.trim() && away?.trim() ? { home: home.trim(), away: away.trim() } : undefined
}

function toRawEvent(e: BetanoEvent, outcomes: RawOutcome[], label = 'Fußball'): RawEvent | null {
  const [home, away] = (e.shortName ?? e.name ?? '').split(' - ')
  if (!home || !away || !outcomes.length) return null
  return {
    bookmakerId: 'betano',
    bookEventId: e.id,
    sportradarId: e.betRadarId ?? null,
    sport: label,
    league: [e.regionName, e.leagueName ?? e.leagueDescription].filter(Boolean).join(' — '),
    home: home.trim(),
    away: away.trim(),
    startTime: new Date(e.startTime).toISOString(),
    isLive: !!e.live,
    url: e.url ? `${HOST}${e.url}` : HOST,
    outcomes,
    fetchedAt: new Date().toISOString(),
  }
}

/* --------------------------------------------------------------- Liga-Liste */

const leagueCache = new Map<string, { ids: string[]; at: number }>()

async function loadLeagueIds(spec: (typeof SPORTS)[number]): Promise<string[]> {
  const cached = leagueCache.get(spec.page)
  if (cached?.ids.length && Date.now() - cached.at < LEAGUE_TTL_MS) return cached.ids
  const html = await fetchText(`${HOST}${spec.page}`, { ...OPTS, minIntervalMs: 500 })
  const ids = [...new Set([...html.matchAll(spec.linkPattern)].map((m) => m[1]))]
  if (ids.length) leagueCache.set(spec.page, { ids, at: Date.now() })
  return leagueCache.get(spec.page)?.ids ?? []
}

/* ------------------------------------------------- Markttiefe aus dem HTML */

/** Sucht im Hydration-Payload das Event mit der gesuchten ID. */
function findEvent(node: unknown, id: string): BetanoEvent | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findEvent(v, id)
      if (r) return r
    }
    return null
  }
  const o = node as Record<string, unknown>
  if (o.id === id && Array.isArray(o.markets)) return o as unknown as BetanoEvent
  for (const v of Object.values(o)) {
    const r = findEvent(v, id)
    if (r) return r
  }
  return null
}

/** Marker des Hydration-Payloads der Event-Seite. */
const STATE_MARKER = 'window["initial_state"]='

async function fetchEventMarkets(ev: RawEvent): Promise<RawOutcome[]> {
  const html = await fetchText(ev.url, OPTS)
  const state = readStateAfter(html, STATE_MARKER)
  if (!state) return []
  const found = findEvent(state, ev.bookEventId)
  if (!found) return []
  const sport = sportOf(ev.sport)
  return toOutcomes(found, { home: ev.home, away: ev.away }, sport)
}

/* -------------------------------------------------------------- Adapter */

export const betano: BookmakerAdapter = {
  id: 'betano',
  name: 'Betano',
  transport: 'impit',

  // Tennis trägt nur die Siegwette, und die steht schon im Sweep — die Tiefe
  // nähme dem Fußball nur Budget weg.
  depthSports: ['FOOTBALL'],

  async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
    // Alle Ligen, jeden Durchlauf, einzeln: Sammelabfragen deckeln die
    // Antwort bei rund zwanzig Partien, und eine Rotation verlor nach jedem
    // Neustart fast das ganze Angebot.
    const cutoff = Date.now() + ctx.windowMs
    const out: RawEvent[] = []

    for (const spec of SPORTS) {
      const all = await loadLeagueIds(spec)
      if (!all.length) continue

      const pages = await pooled(all, 8, async (leagueId) => {
        const res = await fetchJson<{ data?: { events?: BetanoEvent[] } }>(HOST + spec.events(leagueId), OPTS)
        return res.data?.events ?? []
      })

      for (const p of pages) {
        if (p.status !== 'fulfilled') continue
        for (const e of p.value) {
          if (!inWindow(e.startTime, cutoff)) continue
          const teams = (e.shortName ?? e.name ?? '').split(' - ')
          const ev = toRawEvent(
            e,
            toOutcomes(e, teams.length === 2 ? { home: teams[0].trim(), away: teams[1].trim() } : undefined, spec.sport),
            SPORT_LABEL[spec.sport],
          )
          if (ev) out.push(ev)
        }
      }
    }
    return out.slice(0, ctx.maxEvents)
  },

  async fetchDepth(events: RawEvent[]): Promise<RawEvent[]> {
    return deepen(events, 4, (ev) => fetchEventMarkets(ev))
  },
}
