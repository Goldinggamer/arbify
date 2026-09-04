import { fetchJson, fetchText } from '../http.ts'
import type { CanonicalMarket, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'

/**
 * WettArena.
 *
 * Klassische ASP.NET-API, die je Spiel ein flaches Objekt mit über 300
 * Feldern liefert — die Quoten stehen direkt als Zahlen darin, benannt nach
 * Markt (`OddValue1`, `OddValueBoth_Y`, `OddValueTotal2Over`). Kein
 * WebSocket nötig; der SignalR-Hub der Seite dient nur Live-Aktualisierungen.
 *
 * Drei Fallstricke, die das Mapping bestimmen:
 *
 *  - **`OddValue2` ist das Unentschieden**, nicht das Auswärtsteam. Die
 *    Reihenfolge ist 1 / X / 2 → `OddValue1` / `OddValue2` / `OddValue3`.
 *  - **Dubletten.** Derselbe Markt taucht unter mehreren Namen auf:
 *    `OddValueTotals_O1_5`, `OddValueTotal1Over` und teils
 *    `OddValueBasketFirstHalf_1` tragen identische Werte. Übernommen wird je
 *    Markt genau eine Darstellung, sonst steht dieselbe Quote mehrfach im
 *    Bestand.
 *  - **Tippfehler im Feldnamen.** Das Handicap heißt `Hadicap` (ein "n"
 *    fehlt) — wer nach `Handicap` sucht, findet nichts.
 *
 * Und der eigentliche Gewinn: `BetradarMatchId` ist die Sportradar-Match-ID,
 * also ein exakter Join mit Tipico, Betano, Entain und Sportwetten.de.
 *
 * ## Der Filter sitzt im zweiten Segment, nicht im dritten
 *
 * `FixtureMobile` hat die Form `/{sportarten}/{kategorien}/{turniere}/…`.
 * Frühere Fassungen filterten über das **Turnier**-Segment und bauten dafür
 * den ganzen Baum auf (Länder → Turniere, ~35 Anfragen). Nachgemessen: dieses
 * Segment wird serverseitig **ignoriert** — ein einzelnes Turnier liefert
 * dieselben Partien wie gar kein Filter. Und weil die Antwort bei **50
 * Partien hart gedeckelt** ist, kam immer nur dieselbe Auswahl zurück.
 *
 * Schlimmer: mit genügend Turnier-IDs überschreitet das Segment die
 * URL-Längengrenze von IIS und die Antwort ist HTTP 400. Ab etwa 45 IDs
 * passierte das zuverlässig — das war der Lauf mit 0 Events, und es war
 * **keine** Ratenbegrenzung. Der Adapter fing den Fehler still ab
 * (`catch { continue }`) und meldete „ok".
 *
 * Das **Kategorie**-Segment filtert dagegen korrekt. Abgefragt wird deshalb
 * Kategorie für Kategorie: 33 Anfragen statt 35, jede weit unter dem Deckel,
 * und statt 0 kommen 67 Partien im 24-Stunden-Fenster zurück — alle mit
 * Sportradar-ID.
 */

const HOST = 'https://www.wettarena.de'
const OPTS = { transport: 'impit' as const, minIntervalMs: 120 }
/** Sprachkennung Deutsch laut `langDatas.de.langID` im Frontend-Bundle. */
const LANG = 6
const TZ = -120
const SPORT_FOOTBALL = 1

/** Sportkennungen laut `/API/Countries/{sport}/…`: 1 Fußball, 5 Tennis. */
const SPORTS: { id: number; sport: Sport; label: string }[] = [
  { id: SPORT_FOOTBALL, sport: 'FOOTBALL', label: 'Fußball' },
  { id: 5, sport: 'TENNIS', label: 'Tennis' },
]
/**
 * Zeitfenster der API in Stunden — kommt jetzt vom Aufrufer.
 *
 * Hier stand fest 72, während die Anwendung ein Fenster von 168 Stunden zeigt.
 * Der Adapter schnitt damit selbst auf drei Tage zu, obwohl `ctx.windowMs`
 * sieben verlangt — und weil danach ohnehin lokal gegen `cutoff` gefiltert
 * wird, fiel das nie als Fehler auf, sondern nur als niedrige Eventzahl.
 * Nachgemessen liefert der Kategorien-Endpunkt bei 168 Stunden 48 Kategorien
 * statt 46, der Parameter greift also.
 *
 * Die Obergrenze ist Vorsicht, nicht Messung: WettArena hängt an einem
 * Sitzungskeks und antwortet unter Last mit 403. Ein Fenster, das über das
 * hinausgeht, was die Anwendung zeigt, brächte nichts und kostete Anfragen.
 */
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

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/**
 * Ganzzahlige Torlinien bleiben hier — anders als bei Winamax und VBET — außen vor.
 *
 * Das ist kein Versehen und auch kein Widerspruch: bei denen ist nachgemessen,
 * dass die ganzen Linien zweiseitig geführt werden und mit Einsatzrückgabe beim
 * exakten Ergebnis, also gefahrlos gegeneinander zu rechnen sind. Für WettArena
 * fehlt dieser Nachweis, denn der Anbieter liefert schlicht **keine** ganzen
 * Linien: über alle abgerufenen Partien hinweg standen dort ausschließlich 1,5 /
 * 2,5 / 3,5. Der Filter ist damit heute wirkungslos und kostet keine
 * Vergleichsfläche. Er bleibt als Absicherung stehen, falls WettArena die
 * Linien nachrüstet — dann gilt es erst zu prüfen, ob sie zwei- oder dreiseitig
 * geführt werden, bevor sie in denselben Topf dürfen.
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
 * Feste Zuordnung Feldname → Markt und Seite.
 *
 * Bewusst eine Positivliste statt Mustererkennung: das Objekt enthält
 * daneben Doppelte Chance, Torschütze und "wer trifft zuerst", die alle
 * ähnlich heißen, aber keine saubere Zerlegung sind.
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
 * Tennis-Quoten.
 *
 * Der Anbieter schreibt den **Auswärtspreis in zwei Felder**: `OddValue2` und
 * `OddValue3` tragen bei jeder Tennispartie denselben Wert. Nachgemessen an
 * fünf Partien — 3,40/3,40 · 1,75/1,75 · 1,10/1,10 · 1,55/1,55 · 1,60/1,60.
 * Die Marge belegt, welche Paarung der echte Markt ist:
 *
 *   Summe(1,2) = Summe(1,3) = 106–107 %   ← zweiseitig, plausibel
 *   Summe(1,2,3)           = 136–198 %    ← es gibt kein Unentschieden
 *
 * Die Fußball-Zuordnung (`OddValue2` = Unentschieden) hätte hier also ein
 * drittes Bein zum Auswärtspreis erfunden. Genommen wird `OddValue3` mit
 * `OddValue2` als Rückfall: nach der Reihenfolge 1/X/2 ist 3 die Auswärtsseite,
 * und sollte der Anbieter die Dopplung einmal beheben, bleibt das richtig.
 *
 * Satzsieger stehen doppelt in der Antwort — einmal mit Unterstrich
 * (`OddValueTennisFirstSet_1`), einmal ohne (`OddValueTennisFirstSet1`).
 * Übernommen wird genau eine Schreibweise, sonst stehen zwei Quoten desselben
 * Buchs auf derselben Seite und die Kollisionszählung verliert ihren Sinn.
 *
 * Bewusst draußen: `OddValueTennisScore_20/21/12/02` ist das genaue
 * Satzergebnis mit vier Seiten.
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

/**
 * Die API verlangt ein Sitzungs-Cookie von der Startseite.
 *
 * Ohne vorherigen Seitenaufruf antwortet `/API/…` mit HTTP 403 — auch bei
 * sonst korrekten Headern. Ein Aufruf der Startseite setzt das Cookie, das
 * der gemeinsame HTTP-Client danach mitführt.
 */
async function warmUp(): Promise<void> {
  if (Date.now() - warmedAt < TREE_TTL_MS) return
  try {
    await fetchText(`${HOST}/`, { ...OPTS, minIntervalMs: 300 })
    warmedAt = Date.now()
  } catch {
    // Schlägt der Aufruf fehl, versuchen es die API-Abrufe trotzdem.
  }
}

/**
 * Die Kategorien (Länder und Verbände) aus dem linken Menü — der einzige
 * Filter, den `FixtureMobile` tatsächlich auswertet. Ändert sich nur langsam,
 * wird deshalb zwischengespeichert.
 */
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
          url: `${HOST}/`,
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
