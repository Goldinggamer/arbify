import { fetchJson } from '../http.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'

/**
 * NEO.bet — ein offener Endpunkt `/.sportsbet/program/matches` liefert das
 * ganze Vorspiel-Programm samt Quoten, keine Tiefenstufe. Zugeordnet wird über
 * `bettingType`, nicht über den Schlüssel: Siegwette und Handicap teilen
 * `Goal_RT_HC3W(…)`.
 */

const URL_BASE = 'https://neobet.de/.sportsbet/program/matches?language=de&license=DE'
const OPTS = {
  transport: 'impit' as const,
  minIntervalMs: 400,
  headers: {
    accept: 'application/json, text/plain, */*',
    referer: 'https://neobet.de/de/Sportwetten/Heute',
  },
}

type NbOdd = { key: string; outcome: string; odds: number }
type NbMarket = {
  key: string
  bettingType: string
  odds: NbOdd[]
  handicap?: number
  boundary?: number
}
type NbTeam = { name?: string } | string
type NbMatch = {
  id: string
  begin: string
  sport?: string
  sportLabel?: string
  league?: { name?: string } | string
  home?: NbTeam
  away?: NbTeam
  contestStatus?: string
  betmarkets?: NbMarket[]
}

const nameOf = (v: NbTeam | { name?: string } | string | undefined): string =>
  typeof v === 'string' ? v : (v?.name ?? '')

const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Tiefenlink `/de/Sportwetten/Heute/{Datum}-{Heim}-vs-{Gast}-{Nummer}-{Sport}-NEO`; sonst das Tagesprogramm. */
export function eventUrl(id: string, begin: string, home: string, away: string): string {
  const m = /^NEO\|([A-Z]+)-(\d+)$/.exec(id)
  const day = begin.slice(0, 10)
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'https://neobet.de/de/Sportwetten/Heute'
  return `https://neobet.de/de/Sportwetten/Heute/${day}-${slug(home)}-vs-${slug(away)}-${m[2]}-${m[1]}-NEO`
}

/** `Goal_RT_…` = reguläre Spielzeit, `Goal_HT1_…` = 1. Halbzeit. */
function periodOf(key: string): Period | null {
  if (/_RT_/.test(key)) return 'FT'
  if (/_HT1_/.test(key)) return 'H1'
  if (/_HT2_/.test(key)) return 'H2'
  return null
}

/** Tennis-Schlüssel haben eine eigene Form (`Set_MATCH_HC2W(0.0)`: Einheit vorn, Abschnitt in der Mitte). */
function toTennisMarket(m: NbMarket): CanonicalMarket | null {
  if (!/_MATCH_/.test(m.key)) return null
  // `Set_…` heißt: die Linie zählt in Sätzen.
  const unit = /^Set_/i.test(m.key) ? ('SETS' as const) : /^Game_/i.test(m.key) ? ('GAMES' as const) : null

  switch (m.bettingType) {
    case 'MatchWin':
      // Zweiseitig — ein `1X2` verlangte über `SIDES` ein Unentschieden, das
      // es im Tennis nie gibt; der Markt wäre nie vollständig geworden.
      return { type: '2WAY', period: 'FT', line: null, subject: null }

    case 'Spread': {
      // Beim Fußball ist `Spread` bewusst ausgelassen; im Tennis ist es das
      // Handicap und der einzige Markt neben dem Sieger. Der Wert steht aus
      // Heimsicht: bei `-1.5` liegt das Heim-Handicap bei −1,5.
      if (typeof m.handicap !== 'number' || !unit) return null
      return { type: 'AH', period: 'FT', line: m.handicap, subject: null, unit }
    }

    case 'OverUnder': {
      if (typeof m.boundary !== 'number' || !unit) return null
      return { type: 'OU', period: 'FT', line: m.boundary, subject: null, unit }
    }

    default:
      noteUnmapped('neobet', `TENNIS ${m.bettingType} | ${m.key}`)
      return null
  }
}

function toSide(outcome: string): Side | null {
  switch (outcome) {
    case 'Home':
      return 'HOME'
    case 'Draw':
      return 'DRAW'
    case 'Away':
      return 'AWAY'
    case 'Over':
      return 'OVER'
    case 'Under':
      return 'UNDER'
    case 'Yes':
      return 'YES'
    case 'No':
      return 'NO'
    default:
      return null
  }
}

/** Wettart → Markt; `null` für Unbekanntes — nicht raten. */
function toMarket(m: NbMarket, sport: Sport = 'FOOTBALL'): CanonicalMarket | null {
  if (sport === 'TENNIS') return toTennisMarket(m)

  const period = periodOf(m.key)
  if (!period) return null

  switch (m.bettingType) {
    case 'MatchWin':
      return { type: '1X2', period, line: null, subject: null }
    case 'Handicap': {
      // Dreiweg-Handicap. Der Wert steht aus Sicht der Heimmannschaft:
      // bei `handicap: 1` verkürzt sich die Heimquote, das Heimteam
      // bekommt also ein Tor gutgeschrieben — dieselbe Konvention wie im
      // kanonischen Modell.
      if (typeof m.handicap !== 'number') return null
      return { type: 'EH', period, line: m.handicap, subject: null }
    }
    case 'OverUnder': {
      if (typeof m.boundary !== 'number') return null
      return { type: 'OU', period, line: m.boundary, subject: null }
    }
    case 'BothTeamsToScore':
      return { type: 'BTTS', period, line: null, subject: null }
    case 'OddEven':
      return { type: 'OE', period, line: null, subject: null }
    // `OddsBoost` und `Spread` sind Kombiwetten bzw. Sonderformen ohne
    // Gegenstück bei anderen Büchern — bewusst ausgelassen.
    case 'OddsBoost':
    case 'Spread':
      return null
    default:
      noteUnmapped('neobet', m.bettingType)
      return null
  }
}

function toOutcomes(match: NbMatch, sport: Sport): RawOutcome[] {
  const outcomes: RawOutcome[] = []
  for (const bm of match.betmarkets ?? []) {
    const market = toMarket(bm, sport)
    if (!market) continue
    for (const o of bm.odds ?? []) {
      const side = toSide(o.outcome)
      if (!side || !Number.isFinite(o.odds) || o.odds <= 1) continue
      outcomes.push({ market, side, odds: o.odds })
    }
  }
  return outcomes
}

export const neobet: BookmakerAdapter = {
  id: 'neobet',
  name: 'NEO.bet',
  transport: 'impit',

  async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
    const data = await fetchJson<NbMatch[]>(URL_BASE, OPTS)
    if (!Array.isArray(data)) return []

    const cutoff = Date.now() + ctx.windowMs
    const now = new Date().toISOString()
    const events: RawEvent[] = []

    for (const m of data) {
      const label = String(m.sportLabel ?? m.sport ?? '')
      const sport: Sport | null = /fu(ss|ß)ball|soccer|football/i.test(label)
        ? 'FOOTBALL'
        : /tennis/i.test(label)
          ? 'TENNIS'
          : null
      if (!sport) continue
      const home = nameOf(m.home)
      const away = nameOf(m.away)
      const start = new Date(m.begin).getTime()
      if (!home || !away || !Number.isFinite(start) || start > cutoff) continue

      const outcomes = toOutcomes(m, sport)
      if (!outcomes.length) continue

      events.push({
        bookmakerId: 'neobet',
        bookEventId: m.id,
        // Keine Sportradar-Kennung im Feed (`metadata` ist leer) —
        // Zuordnung läuft über Teamnamen plus Anstoßzeit.
        sportradarId: null,
        sport: SPORT_LABEL[sport],
        league: nameOf(m.league) || 'Unbekannt',
        home,
        away,
        startTime: new Date(start).toISOString(),
        isLive: start <= Date.now(),
        url: eventUrl(m.id, m.begin, home, away),
        outcomes,
        fetchedAt: now,
      })
      if (events.length >= ctx.maxEvents) break
    }

    return events
  },
}
