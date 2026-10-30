import { fetchJson, pooled } from '../http.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport, Unit } from '../types.ts'
import { OVERTIME_SPORTS, SPORT_LABEL, sportOf } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'

/**
 * Tipico — „programgateway“, ohne Bot-Schutz.
 *
 * Sweep: `events/selectedEvents/all/{groupId}` liefert je Sportart das ganze
 * Programm eines Knotens aus `navigationTree/all` in einem Aufruf; der
 * Zuschnitt aufs Zeitfenster passiert lokal. Tiefe: `events/{id}` mit rund
 * 30 Marktgruppen.
 */

const BASE = 'https://sports.tipico.de/v1/tpapi/programgateway/program'
const COMMON = 'language=de&isLoggedIn=0&licenseRegion=DE&maxMarkets=1'

/** Knoten „Fußball“; `selectedEvents` liefert alles darunter. */
const SOCCER_GROUP_ID = 1101

/** Knoten-ID je Sportart im `navigationTree/all` und Schlüssel in `eventsBySport`. */
const SPORTS: { groupId: number; key: string; sport: Sport }[] = [
  { groupId: SOCCER_GROUP_ID, key: 'soccer', sport: 'FOOTBALL' },
  { groupId: 5101, key: 'tennis', sport: 'TENNIS' },
  { groupId: 2101, key: 'basketball', sport: 'BASKETBALL' },
  { groupId: 4101, key: 'ice-hockey', sport: 'ICEHOCKEY' },
  { groupId: 6101, key: 'handball', sport: 'HANDBALL' },
  // "football" ist bei Tipico American Football; Fußball heißt "soccer".
  { groupId: 16101, key: 'football', sport: 'AMERICANFOOTBALL' },
  { groupId: 22101, key: 'darts', sport: 'DARTS' },
  { groupId: 23101, key: 'volleyball', sport: 'VOLLEYBALL' },
]

/** Hält die Tiefenphase bei ~10 Anfragen/s. Kein Bot-Schutz — Höflichkeit, keine Notwehr. */
const OPTS = { minIntervalMs: 100 }

type ListEvent = {
  id: string
  eventName: string
  team1: string
  team2: string
  eventStartTime: number
  sportRadarMatchId: number | null
  competitionId: number
  status?: string
  type?: string
}

type Result = { id: number; caption: string; quoteFloatValue: number; choiceParam: string }

type ListGroup = {
  id: number
  results: Result[]
  halfTimeResult?: (ListGroup & { type?: string; section?: number | null }) | null
  fixedParamText?: string | null
  section?: number | null
  originalMarketName?: string
}

type ListPayload = {
  events?: Record<string, ListEvent>
  eventsBySport?: Record<string, string[]>
  sportCompetitionMap?: Record<string, { groupId: number; name: string; parentName: string }[]>
  /** eventId → Markttyp → Gruppen */
  matchOddGroups?: Record<string, Record<string, ListGroup[]>>
}

type DetailGroup = {
  id: number
  caption: string
  type: string
  fixedParam: string | null
  section?: number | null
}

type EventDetail = {
  oddGroups: Record<string, DetailGroup>
  oddGroupResultsMap: Record<string, number[]>
  results: Record<string, Result>
}

/** "0:3" → −3 aus Heimsicht, "2:0" → +2. Tipico schreibt Heim:Auswärts. */
function parseHandicap(fixedParam: string | null | undefined): number | null {
  if (!fixedParam) return null
  const m = String(fixedParam).match(/^(-?[\d.]+)\s*:\s*(-?[\d.]+)$/)
  if (!m) return null
  return Number(m[1]) - Number(m[2])
}

function parseLine(fixedParam: string | null | undefined): number | null {
  if (fixedParam == null) return null
  const n = Number(String(fixedParam).replace(',', '.').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * Mehrere Werte in einem Feld: "1:2.5" heißt Abschnitt bzw. Team 1, Linie
 * 2,5. Blindes Entfernen der Sonderzeichen ergäbe die Linie 12,5.
 */
function splitParam(fixedParam: string | null | undefined): string[] {
  return String(fixedParam ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean)
}

const periodFromIndex = (v: string | undefined): Period =>
  v === '1' ? 'H1' : v === '2' ? 'H2' : 'FT'

/**
 * Was der Abschnittsindex in **dieser Sportart** zählt: im Basketball
 * Viertel, nicht Halbzeiten. Als Halbzeit gelesen fielen Viertel- und
 * Halbzeitsieger auf einen Schlüssel und ergaben Scheinfunde. `null` heißt
 * nicht bestimmbar und führt zum Verwerfen.
 */
function sectionPeriod(index: string | undefined, sport: Sport): Period | null {
  const n = Number(index)
  if (!Number.isInteger(n) || n < 1) return null
  switch (sport) {
    case 'BASKETBALL':
    case 'AMERICANFOOTBALL':
      return n <= 4 ? (`Q${n}` as Period) : null
    case 'ICEHOCKEY':
      return n <= 3 ? (`P${n}` as Period) : null
    case 'TENNIS':
    case 'VOLLEYBALL':
    case 'DARTS':
      return n <= 5 ? (`S${n}` as Period) : null
    default:
      // Fußball und Handball spielen Halbzeiten.
      return n <= 2 ? (`H${n}` as Period) : null
  }
}

/**
 * Tennis teilt drei Typnamen mit dem Fußball und meint etwas anderes:
 * `standard` ist zweiseitig (kein Unentschieden), `section-win` der
 * Satzsieger, `points-more-less-than` Über/Unter in Sätzen oder Spielen.
 */
export function toTennisMarket(
  type: string,
  fixedParam: string | null | undefined,
  caption = '',
): CanonicalMarket | null {
  const cap = caption.toLowerCase()

  switch (type) {
    case 'standard':
      return { type: '2WAY', period: 'FT', line: null, subject: null }

    case 'section-win': {
      const n = String(fixedParam ?? '').trim()
      return /^[1-5]$/.test(n)
        ? { type: '2WAY', period: `S${n}` as CanonicalMarket['period'], line: null, subject: null }
        : null
    }

    // "Handicap (0:1,5)" — zweiwegig, in Sätzen.
    case 'handicap': {
      const line = parseHandicap(fixedParam)
      return line === null ? null : { type: 'AH', period: 'FT', line, subject: null, unit: 'SETS' }
    }

    // Die Einheit steht nur in der Beschriftung; ohne sie verwerfen.
    case 'points-more-less':
    case 'points-more-less-than': {
      const line = parseLine(fixedParam)
      const unit = /sätze|satz/.test(cap) ? 'SETS' : /spiele|games/.test(cap) ? 'GAMES' : null
      return line === null || !unit ? null : { type: 'OU', period: 'FT', line, subject: null, unit }
    }

    default:
      if (!/^(player-set|point-bet|ascendency|type-of-advance|correct-score|first-|next-|game-|tie-?break|ace)/.test(type))
        noteUnmapped('tipico', `TENNIS ${type} :: ${caption}`)
      return null
  }
}

/** Fußball-Markttypen. Unbekanntes wird verworfen, nicht geraten. */
export function toMarket(
  type: string,
  fixedParam: string | null | undefined,
  section: number | null | undefined,
  caption = '',
  teams?: { home: string; away: string },
): CanonicalMarket | null {
  const period: Period = section === 1 ? 'H1' : section === 2 ? 'H2' : 'FT'
  const parts = splitParam(fixedParam)

  switch (type) {
    case 'standard':
      return { type: '1X2', period: 'FT', line: null, subject: null }

    case 'section-win':
      // fixedParam ist hier schlicht "1" oder "2" für die Halbzeit.
      return { type: '1X2', period: periodFromIndex(parts[0]) === 'FT' ? 'H1' : periodFromIndex(parts[0]), line: null, subject: null }

    case 'handicap': {
      const line = parseHandicap(fixedParam)
      return line === null ? null : { type: 'EH', period, line, subject: null }
    }

    case 'section-handicap': {
      // "0:2:1" → Handicap 0:2 in der 1. Halbzeit
      if (parts.length < 3) return null
      const line = parseHandicap(`${parts[0]}:${parts[1]}`)
      return line === null ? null : { type: 'EH', period: periodFromIndex(parts[2]), line, subject: null }
    }

    case 'points-more-less':
    case 'points-more-less-than': {
      const line = parseLine(fixedParam)
      return line === null ? null : { type: 'OU', period: 'FT', line, subject: null }
    }

    // "-rest" meint nur die Restspielzeit eines laufenden Spiels.
    case 'standard-rest':
    case 'points-more-less-rest':
    case 'section-points-more-less-rest':
      return null

    case 'section-points-more-less': {
      // "1:2.5" → 1. Halbzeit, Linie 2,5
      if (parts.length < 2) return null
      const line = parseLine(parts[1])
      return line === null ? null : { type: 'OU', period: periodFromIndex(parts[0]), line, subject: null }
    }

    case 'team-points-more-less':
    case 'team-points-more-less-halftime': {
      // "1:2.5" → Team 1, Linie 2,5. Die Beschriftung nennt das Team im
      // Klartext und ist verlässlicher als der Index.
      if (parts.length < 2 || !teams) return null
      const line = parseLine(parts[1])
      if (line === null) return null
      const cap = caption.toLowerCase()
      const subject: 'HOME' | 'AWAY' | null = cap.includes(teams.home.toLowerCase())
        ? 'HOME'
        : cap.includes(teams.away.toLowerCase())
          ? 'AWAY'
          : parts[0] === '1'
            ? 'HOME'
            : parts[0] === '2'
              ? 'AWAY'
              : null
      if (!subject) return null
      return {
        type: 'TEAM_OU',
        period: type.endsWith('halftime') ? 'H1' : 'FT',
        line,
        subject,
      }
    }

    /**
     * "Tor Randers FC ?" ist dasselbe wie Team-Über 0,5 und wird darauf
     * abgebildet, damit es gegen Kambi und Winamax rechnet. Das Team steht
     * nur in der Beschriftung — ohne sie verwerfen.
     */
    case 'team-scores':
    case 'team-scores-halftime': {
      if (!teams) return null
      const cap = caption.toLowerCase()
      const subject: 'HOME' | 'AWAY' | null = cap.includes(teams.home.toLowerCase())
        ? 'HOME'
        : cap.includes(teams.away.toLowerCase())
          ? 'AWAY'
          : null
      if (!subject) return null
      const half: Period = cap.includes('2.hz') ? 'H2' : cap.includes('1.hz') ? 'H1' : 'FT'
      if (type === 'team-scores-halftime' && half === 'FT') return null
      return { type: 'TEAM_OU', period: type === 'team-scores' ? 'FT' : half, line: 0.5, subject }
    }

    case 'score-both':
      return { type: 'BTTS', period, line: null, subject: null }
    case 'score-both-halftime':
      return { type: 'BTTS', period: 'H1', line: null, subject: null }
    case 'odd-even':
    case 'even-odd':
      return { type: 'OE', period, line: null, subject: null }
    case 'double-chance':
      // 1X und X2 überlappen sich.
      return null
    default:
      // Bekannt und bewusst draußen (Kombiwetten, Ergebnis-, Torschützen-,
      // Intervallwetten) — still verwerfen, damit echte Lücken im Bericht
      // sichtbar bleiben.
      if (
        !/^(totals-team-wins|double-chance|score-both-and|match-result-and|standard-first-scorer|standard-halftime-or-fulltime|halftime-fulltime|head-to-head|point-bet|number-of-points|team-number-of-points|correct-score|first-scorer|goal-scorer|next-point|minutes-point|goals-in-both-halves|score-both-halves|team-scores-both-halves|team-to-win-to-nil|team-to-win-either-half|section-win-both-score|totals-team-wins-section|more-halftime-points|standard-rest|points-more-less-rest)/.test(
          type,
        )
      )
        noteUnmapped('tipico', `${type} :: ${caption}`)
      return null
  }
}

function toSide(caption: string, choiceParam: string, market: CanonicalMarket): Side | null {
  const c = (caption ?? '').trim().toLowerCase()
  const p = (choiceParam ?? '').trim().toLowerCase()

  if (market.type === '1X2' || market.type === 'EH' || market.type === '2WAY' || market.type === 'AH') {
    if (c === '1' || p === '1') return 'HOME'
    if (c === 'x' || p === 'x') return 'DRAW'
    if (c === '2' || p === '2') return 'AWAY'
    return null
  }
  if (market.type === 'OU' || market.type === 'TEAM_OU') {
    if (c.startsWith('über') || c.startsWith('over') || c.startsWith('+') || p === 'over') return 'OVER'
    if (c.startsWith('unter') || c.startsWith('under') || c.startsWith('-') || p === 'under') return 'UNDER'
    // Ja/Nein nur bei "Tor <Team> ?" (siehe `team-scores`): Ja = Über 0,5.
    if (c === 'ja' || c === 'yes') return 'OVER'
    if (c === 'nein' || c === 'no') return 'UNDER'
    return null
  }
  if (market.type === 'BTTS') {
    if (c === 'ja' || c === 'yes') return 'YES'
    if (c === 'nein' || c === 'no') return 'NO'
    return null
  }
  if (market.type === 'OE') {
    if (c.startsWith('ungerade') || c.startsWith('odd')) return 'ODD'
    if (c.startsWith('gerade') || c.startsWith('even')) return 'EVEN'
    return null
  }
  return null
}

/* ------------------------ Basketball, Eishockey, Volleyball, Darts u. a. */

/** Trägt der Markt eine Unentschieden-Auswahl? Entscheidet 3-Weg gegen 2-Weg. */
const hasDraw = (results: Result[]): boolean =>
  results.some((r) => {
    const c = (r.caption ?? '').trim().toLowerCase()
    return c === 'x' || (r.choiceParam ?? '').trim().toLowerCase() === 'x'
  })

/**
 * Märkte der übrigen Sportarten. Die Typnamen sind dieselben wie im Fußball,
 * aber ob ein Markt drei Seiten hat, zeigen nur die Auswahlmöglichkeiten
 * (`hasDraw`): dieselbe Basketballpartie führt eine 2-Weg-Siegwette mit
 * Verlängerung und ein 3-Weg-„Ergebnis“ der regulären Spielzeit.
 */
function toCourtMarket(
  type: string,
  fixedParam: string | null | undefined,
  section: number | null | undefined,
  caption: string,
  teams: { home: string; away: string } | undefined,
  results: Result[],
  sport: Sport,
  bookId: string,
): CanonicalMarket | null {
  const draw = hasDraw(results)
  // Der Abschnitt steht hier im Klartext ("HC (0,5:0) 1.QR", "… 2.HZ"),
  // nicht in `section` — sonst landeten Viertel und Halbzeiten auf dem Ganzspiel.
  const capPeriod = ((): Period | null => {
    const c = caption.toLowerCase()
    const q = /(\d)\s*\.?\s*(qr|viertel|quarter)/.exec(c)
    if (q) return `Q${q[1]}` as Period
    const d = /(\d)\s*\.?\s*(drittel|periode)/.exec(c)
    if (d) return `P${d[1]}` as Period
    if (/1\s*\.?\s*(hz|halbzeit|hälfte)/.test(c)) return 'H1'
    if (/2\s*\.?\s*(hz|halbzeit|hälfte)/.test(c)) return 'H2'
    return null
  })()
  const base: Period = capPeriod ?? (section === 1 ? 'H1' : section === 2 ? 'H2' : 'FT')
  // Ein Unentschieden schließt die Verlängerung aus — wo es eine gibt.
  const period: Period = draw && OVERTIME_SPORTS.has(sport) ? 'RT' : base
  const parts = splitParam(fixedParam)

  // Einheit nur, wo die Sportart mehr als eine führt — siehe `Unit`.
  const unit: Unit | undefined =
    sport === 'VOLLEYBALL' ? 'POINTS' : sport === 'DARTS' ? 'LEGS' : undefined

  switch (type) {
    case 'standard':
      return { type: draw ? '1X2' : '2WAY', period, line: null, subject: null }

    case 'section-win': {
      // Klartext vor Index; ist beides unklar, verwerfen statt raten.
      const p = capPeriod ?? sectionPeriod(parts[0], sport)
      if (!p) return null
      return { type: draw ? '1X2' : '2WAY', period: p, line: null, subject: null }
    }

    case 'handicap':
    case 'handicap-halftime': {
      const line = parseHandicap(fixedParam)
      if (line === null) return null
      return draw
        ? { type: 'EH', period, line, subject: null }
        : { type: 'AH', period, line, subject: null, unit }
    }

    case 'section-handicap': {
      // "0.5:0:1" — Handicap, dann Abschnitt.
      if (parts.length < 3) return null
      const line = parseHandicap(`${parts[0]}:${parts[1]}`)
      if (line === null) return null
      const p = capPeriod ?? sectionPeriod(parts[2], sport)
      if (!p) return null
      return draw
        ? { type: 'EH', period: p, line, subject: null }
        : { type: 'AH', period: p, line, subject: null, unit }
    }

    case 'halftime-win': {
      const p = capPeriod ?? (parts[0] === '2' ? 'H2' : 'H1')
      return { type: draw ? '1X2' : '2WAY', period: p, line: null, subject: null }
    }

    case 'points-more-less-halftime': {
      // "1:74.5" — Halbzeit, dann Linie.
      const line = parseLine(parts.length >= 2 ? parts[1] : fixedParam)
      const p = capPeriod ?? (parts[0] === '2' ? 'H2' : 'H1')
      return line === null ? null : { type: 'OU', period: p, line, subject: null, unit }
    }

    case 'points-more-less':
    case 'points-more-less-than': {
      const line = parseLine(fixedParam)
      return line === null ? null : { type: 'OU', period: base, line, subject: null, unit }
    }

    case 'section-points-more-less': {
      // "3:35.5" heißt im Basketball 3. Viertel, Linie 35,5.
      if (parts.length < 2) return null
      const line = parseLine(parts[1])
      const p = capPeriod ?? sectionPeriod(parts[0], sport)
      return line === null || !p ? null : { type: 'OU', period: p, line, subject: null, unit }
    }

    case 'team-points-more-less':
    case 'team-points-more-less-halftime': {
      // "1:85.5" → Team 1; die Beschriftung nennt das Team verlässlicher als der Index.
      if (parts.length < 2 || !teams) return null
      const line = parseLine(parts[1])
      if (line === null) return null
      const cap = caption.toLowerCase()
      const subject: 'HOME' | 'AWAY' | null = cap.includes(teams.home.toLowerCase())
        ? 'HOME'
        : cap.includes(teams.away.toLowerCase())
          ? 'AWAY'
          : parts[0] === '1'
            ? 'HOME'
            : parts[0] === '2'
              ? 'AWAY'
              : null
      return subject === null
        ? null
        : { type: 'TEAM_OU', period: type.endsWith('halftime') ? 'H1' : base, line, subject, unit }
    }

    case 'odd-even':
    case 'points-odd-even':
      return { type: 'OE', period: base, line: null, subject: null }

    // Kombinationen aus Sieger und Gesamtzahl.
    case 'totals-team-wins':
    case 'team-wins-both-halves':
    case 'halftime-fulltime':
      return null

    // Restspielzeit eines laufenden Spiels.
    case 'standard-rest':
    case 'points-more-less-rest':
    case 'section-points-more-less-rest':
      return null

    default:
      noteUnmapped(bookId, `${sport} ${type} :: ${caption}`)
      return null
  }
}

function outcomesFromResults(market: CanonicalMarket, results: Result[]): RawOutcome[] {
  const out: RawOutcome[] = []
  for (const r of results ?? []) {
    if (!Number.isFinite(r.quoteFloatValue) || r.quoteFloatValue <= 1) continue
    const side = toSide(r.caption, r.choiceParam, market)
    if (side) out.push({ market, side, odds: r.quoteFloatValue })
  }
  return out
}

/** Quoten aus der Listenantwort (Sweep). */
function outcomesFromList(
  groups: Record<string, ListGroup[]> | undefined,
  teams: { home: string; away: string },
  sport: Sport = 'FOOTBALL',
): RawOutcome[] {
  const out: RawOutcome[] = []
  for (const [type, list] of Object.entries(groups ?? {})) {
    for (const g of list ?? []) {
      const market =
        sport === 'TENNIS'
          ? toTennisMarket(type, g.fixedParamText, '')
          : sport === 'FOOTBALL'
            ? toMarket(type, g.fixedParamText, g.section, '', teams)
            : toCourtMarket(type, g.fixedParamText, g.section, '', teams, g.results ?? [], sport, 'tipico')
      if (market) out.push(...outcomesFromResults(market, g.results))

      // Das Halbzeitergebnis hängt als eigene Gruppe am Hauptmarkt — nur im Fußball.
      const ht = sport === 'FOOTBALL' ? g.halfTimeResult : null
      if (ht) {
        const htMarket = toMarket(ht.type ?? 'section-win', ht.fixedParamText ?? '1', ht.section ?? 1, '', teams)
        if (htMarket) out.push(...outcomesFromResults(htMarket, ht.results))
      }
    }
  }
  return out
}

async function fetchList(url: string) {
  const raw = await fetchJson<Record<string, ListPayload> | ListPayload>(url, OPTS)
  const payloads: ListPayload[] =
    'events' in raw ? [raw as ListPayload] : Object.values(raw as Record<string, ListPayload>)

  const events: ListEvent[] = []
  const leagues = new Map<number, string>()
  /** Sportart-Schlüssel → Event-IDs, direkt aus `eventsBySport`. */
  const idsBySport = new Map<string, Set<string>>()
  const groups = new Map<string, Record<string, ListGroup[]>>()

  for (const p of payloads) {
    for (const list of Object.values(p.sportCompetitionMap ?? {}))
      for (const c of list) leagues.set(c.groupId, `${c.parentName} — ${c.name}`)
    for (const [key, ids] of Object.entries(p.eventsBySport ?? {})) {
      const set = idsBySport.get(key) ?? new Set<string>()
      for (const id of ids) set.add(String(id))
      idsBySport.set(key, set)
    }
    events.push(...Object.values(p.events ?? {}))
    for (const [eventId, g] of Object.entries(p.matchOddGroups ?? {}))
      groups.set(String(eventId), g)
  }
  return { events, leagues, idsBySport, groups }
}

/** Volle Markttiefe für eine Partie. */
async function fetchOutcomes(
  eventId: string,
  teams: { home: string; away: string },
  sport: Sport = 'FOOTBALL',
): Promise<RawOutcome[]> {
  const d = await fetchJson<EventDetail>(`${BASE}/events/${eventId}?language=de`, OPTS)
  const out: RawOutcome[] = []

  for (const [groupId, group] of Object.entries(d.oddGroups ?? {})) {
    // Auswahlmöglichkeiten vor dem Markt: ihre Zahl entscheidet außerhalb des
    // Fußballs über drei- oder zweiwegig.
    const results = (d.oddGroupResultsMap?.[groupId] ?? [])
      .map((rid) => d.results?.[String(rid)])
      .filter(Boolean) as Result[]
    const market =
      sport === 'TENNIS'
        ? toTennisMarket(group.type, group.fixedParam, group.caption)
        : sport === 'FOOTBALL'
          ? toMarket(group.type, group.fixedParam, group.section, group.caption, teams)
          : toCourtMarket(group.type, group.fixedParam, group.section, group.caption, teams, results, sport, 'tipico')
    if (!market) continue
    out.push(...outcomesFromResults(market, results))
  }
  return out
}

export const tipico: BookmakerAdapter = {
  id: 'tipico',
  name: 'Tipico',
  transport: 'plain',

  async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
    const lists = await Promise.allSettled([
      ...SPORTS.map((s) =>
        fetchList(`${BASE}/events/selectedEvents/all/${s.groupId}?groupOutrightsByTeam=true&${COMMON}`),
      ),
      fetchList(`${BASE}/events/live?widget=true&selectedSports=top-sport&limitPerSport=5&${COMMON}`),
    ])

    const leagues = new Map<number, string>()
    /** Event-ID → Sportart, aus `eventsBySport` der Antwort. */
    const specById = new Map<string, (typeof SPORTS)[number]>()
    const groups = new Map<string, Record<string, ListGroup[]>>()
    const events = new Map<string, ListEvent>()

    for (const r of lists) {
      if (r.status !== 'fulfilled') continue
      for (const [k, v] of r.value.leagues) leagues.set(k, v)
      for (const s of SPORTS) for (const id of r.value.idsBySport.get(s.key) ?? []) specById.set(id, s)
      for (const [k, v] of r.value.groups) groups.set(k, v)
      for (const e of r.value.events) if (e?.id) events.set(String(e.id), e)
    }

    const cutoff = Date.now() + ctx.windowMs
    const now = new Date().toISOString()

    return [...events.values()].flatMap((e) => {
      // Ohne Eintrag in `eventsBySport` keine unterstützte Sportart.
      const spec = specById.get(String(e.id))
      if (!spec) return []
      if (e.eventStartTime > cutoff) return []
      const outcomes = outcomesFromList(
        groups.get(String(e.id)),
        { home: e.team1, away: e.team2 },
        spec.sport,
      )
      if (!outcomes.length) return []
      return [
        {
          bookmakerId: 'tipico',
          bookEventId: String(e.id),
          sportradarId: e.sportRadarMatchId ?? null,
          sport: SPORT_LABEL[spec.sport],
          league: leagues.get(e.competitionId) ?? 'Unbekannt',
          home: e.team1,
          away: e.team2,
          startTime: new Date(e.eventStartTime).toISOString(),
          // Nur `status` zählt: `type: 'live'` heißt „live bewettbar“, nicht „läuft“.
          isLive: e.status === 'running',
          url: `https://sports.tipico.de/de/event/${e.id}`,
          outcomes,
          fetchedAt: now,
        } satisfies RawEvent,
      ]
    })
  },

  async fetchDepth(events: RawEvent[]): Promise<RawEvent[]> {
    const results = await pooled(events, 5, async (ev) => {
      const sport = sportOf(ev.sport)
      const outcomes = await fetchOutcomes(ev.bookEventId, { home: ev.home, away: ev.away }, sport)
      return outcomes.length
        ? { ...ev, outcomes, fetchedAt: new Date().toISOString() }
        : ev
    })
    return results.map((r, i) => (r.status === 'fulfilled' ? r.value : events[i]))
  },
}
