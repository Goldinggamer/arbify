import { fetchJson, fetchText } from '../http.ts'
import type { CanonicalMarket, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { num } from './labels.ts'

/**
 * WettArena — ASP.NET-API, je Partie ein flaches Objekt mit 300+ Feldern
 * (`OddValue1`, `OddValueBoth_Y`, …), dazu `BetradarMatchId` für den exakten Join.
 *
 * Fallstricke: `OddValue2` ist das Unentschieden; derselbe Markt steht unter
 * mehreren Feldnamen (nur einen übernehmen); das Handicap heißt `Hadicap`.
 *
 * `FixtureMobile` filtert nur über das **Kategorie**-Segment; das
 * Turnier-Segment wird ignoriert, die Antwort ist bei 50 Partien gedeckelt und
 * zu viele IDs sprengen die URL-Länge (HTTP 400). Deshalb Kategorie für Kategorie.
 */

const HOST = 'https://www.wettarena.de'
const OPTS = { transport: 'impit' as const, minIntervalMs: 120 }
/** Sprachkennung Deutsch laut `langDatas.de.langID` im Frontend-Bundle. */
const LANG = 6
const TZ = -120
const SPORT_FOOTBALL = 1

/** Sportkennungen laut `/API/Countries/{sport}/…`: 1 Fußball, 5 Tennis. */
const SPORTS: { id: number; sport: Sport }[] = [
  { id: SPORT_FOOTBALL, sport: 'FOOTBALL' },
  { id: 5, sport: 'TENNIS' },
]
/** Zeitfenster der API in Stunden — vom Aufrufer, mit Obergrenze als Vorsicht (Sitzungskeks, 403 unter Last). */
const MAX_HOURS = 336
const hoursFor = (windowMs: number): number =>
  Math.min(MAX_HOURS, Math.max(24, Math.ceil(windowMs / 3600_000)))
const TREE_TTL_MS = 30 * 60 * 1000

type Fixture = Record<string, unknown> & {
  MatchId?: number
  SportId?: number
  CategoryName?: string
  TournamentName?: string
  HomeTeam?: string
  AwayTeam?: string
  MatchDate?: string
  BetradarMatchId?: number
}

/**
 * Ganzzahlige Torlinien bleiben hier draußen: WettArena liefert heute keine,
 * und ob sie zwei- oder dreiseitig wären, ist ungeprüft.
 */
const isHalfLine = (line: number): boolean => Math.abs(line * 2) % 2 === 1

/** "0:1" → −1 aus Heimsicht. */
function handicapOf(special: unknown): number | null {
  const m = /^(-?[\d.]+)\s*:\s*(-?[\d.]+)$/.exec(String(special ?? ''))
  return m ? Number(m[1]) - Number(m[2]) : null
}

const eh = (line: number): CanonicalMarket => ({ type: 'EH', period: 'FT', line, subject: null })
const ou = (line: number, period: 'FT' | 'H1'): CanonicalMarket => ({ type: 'OU', period, line, subject: null })

/**
 * Feste Zuordnung Feldname → Markt und Seite. Positivliste: ähnlich benannte
 * Felder (Doppelte Chance, Torschütze) sind keine saubere Zerlegung.
 */
const FIXED: { field: string; market: CanonicalMarket; side: Side }[] = [
  { field: 'OddValue1', market: { type: '1X2', period: 'FT', line: null, subject: null }, side: 'HOME' },
  { field: 'OddValue2', market: { type: '1X2', period: 'FT', line: null, subject: null }, side: 'DRAW' },
  { field: 'OddValue3', market: { type: '1X2', period: 'FT', line: null, subject: null }, side: 'AWAY' },
  { field: 'OddValueFirstHalf_1', market: { type: '1X2', period: 'H1', line: null, subject: null }, side: 'HOME' },
  { field: 'OddValueFirstHalf_X', market: { type: '1X2', period: 'H1', line: null, subject: null }, side: 'DRAW' },
  { field: 'OddValueFirstHalf_2', market: { type: '1X2', period: 'H1', line: null, subject: null }, side: 'AWAY' },
  { field: 'OddValueBoth_Y', market: { type: 'BTTS', period: 'FT', line: null, subject: null }, side: 'YES' },
  { field: 'OddValueBoth_N', market: { type: 'BTTS', period: 'FT', line: null, subject: null }, side: 'NO' },
]

/**
 * Tennis: `OddValue2` und `OddValue3` tragen beide den Auswärtspreis (es
 * gibt kein Unentschieden) — genommen wird `OddValue3`, `OddValue2` als
 * Rückfall. Satzsieger stehen doppelt (mit und ohne Unterstrich); nur eine
 * Schreibweise übernehmen. Das genaue Satzergebnis bleibt draußen.
 */
function tennisOutcomesOf(f: Fixture): RawOutcome[] {
  const out: RawOutcome[] = []
  const add = (market: CanonicalMarket, side: Side, raw: unknown) => {
    const odds = num(raw)
    if (odds !== null && odds > 1) out.push({ market, side, odds })
  }
  const twoWay = (period: CanonicalMarket['period']): CanonicalMarket => ({
    type: '2WAY',
    period,
    line: null,
    subject: null,
  })

  add(twoWay('FT'), 'HOME', f.OddValue1)
  add(twoWay('FT'), 'AWAY', f.OddValue3 ?? f.OddValue2)

  add(twoWay('S1'), 'HOME', f.OddValueTennisFirstSet_1)
  add(twoWay('S1'), 'AWAY', f.OddValueTennisFirstSet_2)
  add(twoWay('S2'), 'HOME', f.OddValueTennisSecondSet1)
  add(twoWay('S2'), 'AWAY', f.OddValueTennisSecondSet2)

  return out
}

function outcomesOf(f: Fixture): RawOutcome[] {
  const out: RawOutcome[] = []
  const add = (market: CanonicalMarket, side: Side, raw: unknown) => {
    const odds = num(raw)
    if (odds !== null && odds > 1) out.push({ market, side, odds })
  }

  for (const { field, market, side } of FIXED) add(market, side, f[field])

  // Über/Unter: die Linie steht im begleitenden SpecialBetValue-Feld.
  // `Total{n}` ist das Gesamtspiel, `HalfTotal{n}` die erste Halbzeit.
  for (const [prefix, period] of [
    ['Total', 'FT'],
    ['HalfTotal', 'H1'],
  ] as const) {
    for (let n = 1; n <= 8; n++) {
      const line = num(f[`OddSpecialBetValue${prefix}${n}`])
      if (line === null || !isHalfLine(line)) continue
      add(ou(line, period), 'OVER', f[`OddValue${prefix}${n}Over`])
      add(ou(line, period), 'UNDER', f[`OddValue${prefix}${n}Under`])
    }
  }

  // Europäisches Handicap: Feldname trägt den Vorsprung, z.B. Hadicap01 →
  // "0:1". Die Schreibweise ohne zweites "n" stammt vom Anbieter.
  for (const key of Object.keys(f)) {
    const m = /^OddValueHadicap(\d+)_(1|X|2)$/.exec(key)
    if (!m) continue
    const line = handicapOf(f[`OddSpecialBetValueHadicap${m[1]}_1`])
    if (line === null) continue
    const side: Side = m[2] === '1' ? 'HOME' : m[2] === 'X' ? 'DRAW' : 'AWAY'
    add(eh(line), side, f[key])
  }

  return out
}

/* ------------------------------------------------------- Turnier-Baum */

const treeCache = new Map<number, { ids: string[]; at: number }>()
let warmedAt = 0

/** Die API verlangt ein Sitzungs-Cookie, das ein Aufruf der Startseite setzt (sonst 403). */
async function warmUp(): Promise<void> {
  if (Date.now() - warmedAt < TREE_TTL_MS) return
  try {
    await fetchText(`${HOST}/`, { ...OPTS, minIntervalMs: 300 })
    warmedAt = Date.now()
  } catch {
    // Schlägt der Aufruf fehl, versuchen es die API-Abrufe trotzdem.
  }
}

/** Kategorien (Länder, Verbände) — der einzige Filter, den `FixtureMobile` auswertet; zwischengespeichert. */
async function categoryIds(sportId: number, hours: number): Promise<string[]> {
  const cached = treeCache.get(sportId)
  if (cached?.ids.length && Date.now() - cached.at < TREE_TTL_MS) return cached.ids
  await warmUp()

  const countries = await fetchJson<{ CategoryId?: number; Id?: number }[]>(
    `${HOST}/API/Countries/${sportId}/${LANG}/${hours}`,
    OPTS,
  )
  const ids: string[] = []
  for (const c of countries ?? []) {
    const cid = c.CategoryId ?? c.Id
    if (cid != null) ids.push(String(cid))
  }
  if (ids.length) treeCache.set(sportId, { ids, at: Date.now() })
  return treeCache.get(sportId)?.ids ?? []
}

/** IDs pipe-getrennt mit abschließendem Trenner; roh gesendet quittiert IIS mit 400. */
const pipeList = (ids: string[]): string => encodeURIComponent(ids.join('|') + '|')

export const wettarena: BookmakerAdapter = {
  id: 'wettarena',
  name: 'WettArena',
  transport: 'impit',

  async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
    await warmUp()
    const hours = hoursFor(ctx.windowMs)
    const cutoff = Date.now() + ctx.windowMs
    const now = new Date().toISOString()
    const seen = new Set<string>()
    const out: RawEvent[] = []
    let failedBlocks = 0
    let totalBlocks = 0

    for (const spec of SPORTS) {
    const categories = await categoryIds(spec.id, hours)

    // Je Kategorie eine Anfrage. Ohne Kategorie-Filter deckelt die API bei 50
    // Partien — der Deckel ist der Grund für die Aufteilung, nicht die
    // URL-Länge.
    const blocks: (string | null)[] = categories.length ? categories : [null]
    totalBlocks += blocks.length

    for (const cid of blocks) {
      const path = cid
        ? `/API/FixtureMobile/${pipeList([String(spec.id)])}/${pipeList([cid])}/0/${hours}/${LANG}/${TZ}`
        : `/API/FixtureMobile/0/0/0/${hours}/${LANG}/${TZ}`

      let list: Fixture[]
      try {
        list = await fetchJson<Fixture[]>(HOST + path, OPTS)
      } catch {
        failedBlocks++
        continue
      }

      for (const f of list ?? []) {
        if (f.SportId !== spec.id) continue
        const id = String(f.MatchId ?? '')
        if (!id || seen.has(id)) continue
        const home = f.HomeTeam?.trim()
        const away = f.AwayTeam?.trim()
        if (!home || !away || !f.MatchDate) continue

        // MatchDate kommt ohne Zeitzone, gemeint ist deutsche Ortszeit.
        const start = new Date(`${f.MatchDate}${/[Zz+]/.test(f.MatchDate) ? '' : '+02:00'}`)
        if (!Number.isFinite(start.getTime()) || start.getTime() > cutoff) continue

        const outcomes = spec.sport === 'TENNIS' ? tennisOutcomesOf(f) : outcomesOf(f)
        if (!outcomes.length) continue
        seen.add(id)

        out.push({
          bookmakerId: 'wettarena',
          bookEventId: id,
          sportradarId: f.BetradarMatchId ? Number(f.BetradarMatchId) || null : null,
          sport: SPORT_LABEL[spec.sport],
          league: [f.CategoryName, f.TournamentName].filter(Boolean).join(' — ') || 'Unbekannt',
          home,
          away,
          startTime: start.toISOString(),
          isLive: start.getTime() <= Date.now(),
          // Die Website adressiert Partien als `/eventdetail/{MatchId}` —
          // abgelesen, indem eine Partie angeklickt und die Adresse notiert wurde.
          url: `https://wettarena.de/eventdetail/${id}`,
          outcomes,
          fetchedAt: now,
        })
        if (out.length >= ctx.maxEvents) return out
      }
    }
    }

    // Ein stiller Nullbestand war genau das Problem: der Adapter meldete „ok",
    // und dass eine ganze Quelle fehlte, sah man erst an der schwankenden
    // Vergleichsbasis. Fallen alle Blöcke aus, ist das ein Fehler.
    if (!out.length && totalBlocks > 0 && failedBlocks === totalBlocks)
      throw new Error(`WettArena: alle ${failedBlocks} Kategorie-Abrufe fehlgeschlagen`)

    return out
  },
}
