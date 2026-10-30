import { fetchText } from '../http.ts'
import { readStateAfter } from './html-state.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport, Unit } from '../types.ts'
import { OVERTIME_SPORTS, SPORT_LABEL } from '../types.ts'
import { teamTokens, tokenSimilarity } from '../match.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { inWindow } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'
import { nameMatch } from '../players.ts'
import { deepen } from './depth.ts'
import { oddEvenSide, yesNoSide } from './labels.ts'

/**
 * Winamax — der Zustand steckt als `PRELOADED_STATE` im HTML. Ein Abruf je
 * Sportart liefert das ganze Programm mit Siegwette, die Detailseite einer
 * Partie über 100 Märkte. Keine Sportradar-Match-ID.
 */

const HOST = 'https://www.winamax.de'
/**
 * `retryOn403: false`: die 403 kommt von einem mengenbasierten
 * CloudFront-Limit je IP (~190 Abrufe je fünf Minuten) und hält dann rund
 * 150 s an — kein Retry rettet sie. Ein voller Lauf liegt bewusst darüber;
 * Winamax fällt in Serien von Scans deshalb zeitweise aus.
 */
const OPTS = { transport: 'impit' as const, minIntervalMs: 250, retryOn403: false }
const MARKER = 'PRELOADED_STATE'

/** Obergrenze für Detailseiten je Aufruf; deckt sich mit `maxDepthEvents`. */
const MAX_DEPTH = 60

/** Winamax-Sportkennungen (`/sportwetten/sports/{id}`). */
const SPORTS: { id: number; sport: Sport }[] = [
  { id: 1, sport: 'FOOTBALL' },
  { id: 5, sport: 'TENNIS' },
  { id: 2, sport: 'BASKETBALL' },
  { id: 4, sport: 'ICEHOCKEY' },
  { id: 6, sport: 'HANDBALL' },
  { id: 16, sport: 'AMERICANFOOTBALL' },
  { id: 22, sport: 'DARTS' },
  { id: 23, sport: 'VOLLEYBALL' },
]

type Match = {
  matchId: number
  title?: string
  status?: string
  sportId?: number
  tournamentId?: number
  competitor1Name?: string
  competitor2Name?: string
  matchStart?: number
  mainBetId?: number
  moreBets?: number
}

type Bet = {
  betId: number
  matchId: number
  outcomes?: number[]
  template?: string
  betTitle?: string
  specialBetValue?: string
  available?: boolean
}

type Outcome = { betId: number; label?: string; code?: string; available?: boolean }

type State = {
  matches?: Record<string, Match | null>
  bets?: Record<string, Bet | null>
  outcomes?: Record<string, Outcome | null>
  odds?: Record<string, number>
  tournaments?: Record<string, { tournamentName?: string; categoryName?: string } | null>
}

/**
 * "total=2.5" → 2.5, "hcp=-1.5" → −1.5 (`hcp` beim Tennis-Handicap).
 * Ganzzahlige Linien bleiben drin; `scan.ts` markiert sie als `push-line`.
 */
function lineOf(special: string | undefined): number | null {
  const m = /(?:total|handicap|hcp)\s*=\s*(-?[\d.]+)/.exec(special ?? '')
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/** Tennis. Die Satznummer steht verlässlich als `setnr=1` im `specialBetValue`. */
export function toTennisMarket(bet: Bet): CanonicalMarket | null {
  const title = (bet.betTitle ?? '').trim()
  const t = title.toLowerCase()
  const template = bet.template ?? ''
  const spec = bet.specialBetValue ?? ''

  const setNr = /setnr\s*=\s*([1-5])/.exec(spec)?.[1]
  const period = (setNr ? `S${setNr}` : 'FT') as CanonicalMarket['period']

  if (template === '2way' && /^(\d\. satz - )?gewinner$/.test(t))
    return { type: '2WAY', period, line: null, subject: null }

  if (template === 'OverUnder' && t === 'anzahl sätze') {
    const line = lineOf(spec)
    return line === null ? null : { type: 'OU', period, line, subject: null, unit: 'SETS' }
  }
  if (template === 'OverUnder' && /^(anzahl (der )?spiele|anzahl games)$/.test(t)) {
    const line = lineOf(spec)
    return line === null ? null : { type: 'OU', period, line, subject: null, unit: 'GAMES' }
  }

  // "Differenz der Sätze (Handicap)" — `hcp` steht aus Heimsicht.
  if (template === 'asian_handicap' && /handicap/.test(t)) {
    const line = lineOf(spec)
    if (line === null) return null
    const unit = /satz|sätze/.test(t) ? 'SETS' : /spiel|game/.test(t) ? 'GAMES' : null
    return unit ? { type: 'AH', period, line, subject: null, unit } : null
  }

  // Bekannt und bewusst draußen. `ListOdd` ist der **Turniersieger**
  // ("Sieger"), kein Matchsieger.
  const known =
    template === 'ListOdd' ||
    /tiebreak|gewinnt mindestens einen satz|genaue anzahl|genaues ergebnis|doppeltes ergebnis|aufschlag|ass|doppelfehler|erster satz und|wer gewinnt/.test(
      t,
    )
  if (!known) noteUnmapped('winamax', `TENNIS ${template} | ${title}`)
  return null
}

/* ------------------------ Basketball, Eishockey, Volleyball, Darts u. a. */

/**
 * Übrige Sportarten. Der Abschnitt steht vor dem Namen ("1. Viertel -
 * Punktedifferenz (handicap)"). "Gewinner" (2-Weg, mit Verlängerung) und
 * "Ergebnis" (3-Weg, reguläre Spielzeit) sind verschiedene Wetten.
 */
function toCourtMarket(bet: Bet, home: string, away: string, sport: Sport): CanonicalMarket | null {
  const title = (bet.betTitle ?? '').trim()
  const t = title.toLowerCase().replace(/\s+/g, ' ')
  const template = bet.template ?? ''
  const line = lineOf(bet.specialBetValue)
  const special = bet.specialBetValue ?? ''

  // Abschnitt: aus dem Vorsatz des Titels oder aus `quarternr` im Sonderwert.
  let period: Period = 'FT'
  const quarter = /quarternr=([1-4])/.exec(special) ?? /^([1-4])\. viertel/.exec(t)
  const third = /^([1-3])\. drittel/.exec(t)
  const set = /^([1-5])\. satz/.exec(t)
  if (quarter) period = `Q${quarter[1]}` as Period
  else if (third) period = `P${third[1]}` as Period
  else if (set) period = `S${set[1]}` as Period
  else if (/^1\. halbzeit|^halbzeit\b/.test(t)) period = 'H1'
  else if (/^2\. halbzeit/.test(t)) period = 'H2'

  // Einheit nur, wo die Sportart mehr als eine führt — siehe `Unit`.
  const unit: Unit | undefined =
    sport === 'VOLLEYBALL' ? (/satz|sätze/.test(t) ? 'SETS' : 'POINTS') : sport === 'DARTS' ? (/satz|sätze/.test(t) ? 'SETS' : 'LEGS') : undefined

  // Bekannt und bewusst draußen. "Erstattung bei Unentschieden" ist keine
  // echte 2-Weg-Wette; `180s` zählt beim Darts Maximalwürfe, keine Legs.
  if (
    /erstattung bei unentschieden|eines spielers|kopf an kopf|meilenstein|double-double|triple-double|bester |doppelte chance|^verlängerung$|mit den meisten|halbzeit\/|und anzahl|genaues ergebnis|^sieg mit|180s|checkout|aufnahme|highest/.test(
      t,
    ) ||
    template === 'ListOdd' ||
    template === 'List' ||
    template === 'dynamic'
  )
    return null

  // Drei Seiten heißt reguläre Spielzeit.
  if (template === '3way')
    return {
      type: '1X2',
      period: period === 'FT' && OVERTIME_SPORTS.has(sport) ? 'RT' : period,
      line: null,
      subject: null,
    }

  if (template === '2way' && /^(gewinner|sieger)$/.test(t.replace(/^.*? - /, '')))
    return { type: '2WAY', period, line: null, subject: null }

  if (template === 'asian_handicap' || /punktedifferenz|tordifferenz|handicap/.test(t)) {
    if (line === null) return null
    return { type: 'AH', period, line, subject: null, unit }
  }

  if (/gerade\/ungerade|ungerade\/gerade/.test(t))
    return { type: 'OE', period, line: null, subject: null }

  if (template === 'OverUnder') {
    if (line === null) return null
    // Team-Total in mehreren Formen: "Anzahl Punkte von New York Liberty",
    // "1. Viertel - Japan (F) Punkte", "1. Halbzeit - Anzahl der Punkte Spanien (F)".
    const rest = t.replace(/^\d?\.?\s*(viertel|halbzeit|hälfte|drittel|satz)\s*-\s*/, '')
    const wer =
      /anzahl (?:der )?(?:punkte|tore|sätze|legs|games)\s+(?:von\s+)?(.+)$/.exec(rest)?.[1] ??
      /^(.+?)\s+(?:punkte|tore|sätze|legs|games)$/.exec(rest)?.[1]

    if (wer) {
      const who = wer.trim()
      const h = tokenSimilarity(teamTokens(who), teamTokens(home))
      const a = tokenSimilarity(teamTokens(who), teamTokens(away))
      // Passt der Name zu keinem Team, ist es der Gesamtmarkt; passt er zu
      // beiden gleich gut, verwerfen statt raten.
      if (Math.max(h, a) >= 0.5 && Math.abs(h - a) >= 0.25)
        return { type: 'TEAM_OU', period, line, subject: h > a ? 'HOME' : 'AWAY', unit }
      if (Math.max(h, a) >= 0.5) return null
    }
    return { type: 'OU', period, line, subject: null, unit }
  }

  return null
}

export function toMarket(bet: Bet, home: string, away: string): CanonicalMarket | null {
  const title = (bet.betTitle ?? '').trim()
  const t = title.toLowerCase()
  const template = bet.template ?? ''
  const line = lineOf(bet.specialBetValue)

  if (template === '3way' && t === 'ergebnis')
    return { type: '1X2', period: 'FT', line: null, subject: null }

  if (template === '3way' && /^1\. halbzeit ?- ?ergebnis$/.test(t))
    return { type: '1X2', period: 'H1', line: null, subject: null }

  if (template === 'OverUnder' && t === 'anzahl tore') {
    if (line === null) return null
    return { type: 'OU', period: 'FT', line, subject: null }
  }

  // Die Halbzeit steht vor dem Marktnamen ("1. Halbzeit - Anzahl Tore").
  if (template === 'OverUnder' && /^(1|2)\. halbzeit ?- ?anzahl tore$/.test(t)) {
    if (line === null) return null
    return { type: 'OU', period: t.startsWith('1.') ? 'H1' : 'H2', line, subject: null }
  }

  if (template === 'OverUnder' && t.startsWith('anzahl tore von ')) {
    if (line === null) return null
    const team = title.slice('Anzahl Tore von '.length).trim().toLowerCase()
    const subject = team === home.toLowerCase() ? 'HOME' : team === away.toLowerCase() ? 'AWAY' : null
    return subject ? { type: 'TEAM_OU', period: 'FT', line, subject } : null
  }

  // Halbzeit-Team-Total: "1. Halbzeit - Anzahl der Tore X" — ohne "von".
  const teamHalf = /^([12])\. halbzeit ?- ?anzahl der tore (.+)$/.exec(t)
  if (template === 'OverUnder' && teamHalf) {
    if (line === null) return null
    const team = teamHalf[2].trim()
    const subject = team === home.toLowerCase() ? 'HOME' : team === away.toLowerCase() ? 'AWAY' : null
    return subject ? { type: 'TEAM_OU', period: teamHalf[1] === '1' ? 'H1' : 'H2', line, subject } : null
  }

  // Dieselbe Wette als Frage (Übersicht) und als Aussage (Detailseite).
  if (
    template === '2way' &&
    /^(beide (mannschaften|teams) treffen|schießen beide (mannschaften|teams) ein tor\?)$/.test(t)
  )
    return { type: 'BTTS', period: 'FT', line: null, subject: null }

  if (template === '2way' && /^([12])\. halbzeit ?- ?beide (mannschaften|teams) treffen$/.test(t))
    return { type: 'BTTS', period: t.startsWith('1.') ? 'H1' : 'H2', line: null, subject: null }

  // "Anzahl der Tore - Gerade/Ungerade". Verankert: "… der Tore von X - …"
  // ist Team-Parität und im Modell nicht vorgesehen.
  if (template === '2way' && /^anzahl (der )?tore ?- ?gerade\/ungerade$/.test(t))
    return { type: 'OE', period: 'FT', line: null, subject: null }

  if (template === '2way' && /^([12])\. halbzeit ?- ?anzahl (der )?tore ?- ?gerade\/ungerade$/.test(t))
    return { type: 'OE', period: t.startsWith('1.') ? 'H1' : 'H2', line: null, subject: null }

  // Kombiwetten — kein unterstützter Titel enthält " und ".
  if (/ und /.test(t)) return null

  const known =
    /doppelte chance|genaues ergebnis|genaue anzahl|multi-chance|erstattung|zu null|halbzeit mit|halbzeit\/|letzte mannschaft|erste mannschaft|welche mannschaft|mannschaft, die|torschütze|gewinnt beide|sieger in einer|gewinnspanne|wie geht das spiel|qualifikation|erzielt \d|ohne gegentor|trifft in beiden|handicap|kombi|spieler|karten|ecken|verlängerung|elfmeter|anzahl der tore von .*gerade\/ungerade/.test(
      t,
    )
  if (!known) noteUnmapped('winamax', `${template} | ${title}`)
  return null
}

export function toSide(outcome: Outcome, market: CanonicalMarket, home = '', away = ''): Side | null {
  const code = (outcome.code ?? '').toLowerCase()
  const label = (outcome.label ?? '').trim().toLowerCase()

  if (market.type === '1X2' || market.type === '2WAY') {
    if (code === '1') return 'HOME'
    if (code === 'x') return 'DRAW'
    if (code === '2') return 'AWAY'
    return null
  }
  if (market.type === 'AH') {
    // Beim Handicap sind die Codes keine festen Seiten — `yes` ist mal Heim,
    // mal Gast. Verlässlich ist nur die Beschriftung ohne angehängte Linie.
    const who = (outcome.label ?? '').replace(/\s*[+-]\s*[\d.]+\s*$/, '').trim()
    if (!who) return null
    const h = nameMatch(who, home)
    const a = nameMatch(who, away)
    if (h > a) return 'HOME'
    if (a > h) return 'AWAY'
    return null
  }
  if (market.type === 'OU' || market.type === 'TEAM_OU') {
    if (code === 'over' || label.startsWith('über')) return 'OVER'
    if (code === 'under' || label.startsWith('unter')) return 'UNDER'
    return null
  }
  if (market.type === 'BTTS') return yesNoSide(label)
  if (market.type === 'OE') return oddEvenSide(label)
  return null
}

function outcomesFor(
  state: State,
  matchId: number,
  home: string,
  away: string,
  sport: Sport = 'FOOTBALL',
): RawOutcome[] {
  const out: RawOutcome[] = []
  for (const bet of Object.values(state.bets ?? {})) {
    if (!bet || bet.matchId !== matchId || bet.available === false) continue
    const market =
      sport === 'TENNIS'
        ? toTennisMarket(bet)
        : sport === 'FOOTBALL'
          ? toMarket(bet, home, away)
          : toCourtMarket(bet, home, away, sport)
    if (!market) continue
    for (const oid of bet.outcomes ?? []) {
      const outcome = state.outcomes?.[String(oid)]
      const odds = state.odds?.[String(oid)]
      if (!outcome || outcome.available === false) continue
      if (typeof odds !== 'number' || !Number.isFinite(odds) || odds <= 1) continue
      const side = toSide(outcome, market, home, away)
      if (side) out.push({ market, side, odds })
    }
  }
  return out
}

function buildEvent(state: State, m: Match, outcomes: RawOutcome[], sport: Sport = 'FOOTBALL'): RawEvent | null {
  const home = m.competitor1Name?.trim()
  const away = m.competitor2Name?.trim()
  if (!home || !away || !m.matchStart || !outcomes.length) return null

  const tournament = state.tournaments?.[String(m.tournamentId)]
  const league = [tournament?.categoryName, tournament?.tournamentName].filter(Boolean).join(' — ')

  return {
    bookmakerId: 'winamax',
    bookEventId: String(m.matchId),
    sportradarId: null,
    sport: SPORT_LABEL[sport],
    league: league || 'Unbekannt',
    home,
    away,
    // matchStart kommt als Unix-Sekunden.
    startTime: new Date(m.matchStart * 1000).toISOString(),
    isLive: m.status === 'LIVE',
    url: `${HOST}/sportwetten/match/${m.matchId}`,
    outcomes,
    fetchedAt: new Date().toISOString(),
  }
}

async function loadState(url: string): Promise<State | null> {
  const html = await fetchText(url, OPTS)
  return readStateAfter<State>(html, MARKER)
}

export const winamax: BookmakerAdapter = {
  id: 'winamax',
  name: 'Winamax',
  transport: 'impit',

  async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
    // Ein Abruf je Sportart; bei aktiver Sperre soll eine Sportart nicht die anderen mitreißen.
    const pages = await Promise.allSettled(
      SPORTS.map((s) => loadState(`${HOST}/sportwetten/sports/${s.id}`).then((state) => ({ s, state }))),
    )

    const cutoff = Date.now() + ctx.windowMs
    const out: RawEvent[] = []
    for (const p of pages) {
      if (p.status !== 'fulfilled' || !p.value.state?.matches) continue
      const { s, state } = p.value
      for (const m of Object.values(state.matches ?? {})) {
        if (!m || m.sportId !== s.id || !m.matchStart) continue
        if (!inWindow(m.matchStart * 1000, cutoff)) continue
        const home = m.competitor1Name?.trim() ?? ''
        const away = m.competitor2Name?.trim() ?? ''
        const ev = buildEvent(state, m, outcomesFor(state, m.matchId, home, away, s.sport), s.sport)
        if (ev) out.push(ev)
      }
    }
    return out.slice(0, ctx.maxEvents)
  },

  async fetchDepth(events: RawEvent[]): Promise<RawEvent[]> {
    // Nur die vertieften Events zurückgeben; der Aufrufer behält für alle
    // übrigen den flachen Stand.
    return deepen(events.slice(0, MAX_DEPTH), 4, async (ev, sport) => {
      const state = await loadState(`${HOST}/sportwetten/match/${ev.bookEventId}`)
      return state ? outcomesFor(state, Number(ev.bookEventId), ev.home, ev.away, sport) : null
    })
  },
}
