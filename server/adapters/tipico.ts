import { fetchJson, pooled } from '../http.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport, Unit } from '../types.ts'
import { OVERTIME_SPORTS, SPORT_LABEL, sportFromLabel } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'

/**
 * Tipico — "programgateway".
 *
 * Kein Bot-Schutz auf den Datenendpunkten: normales fetch genügt.
 *
 * Sweep: `events/selectedEvents/all/{groupId}` — ein einziger Aufruf für das
 * gesamte Fußballprogramm, Hauptergebnis (1X2 plus Halbzeit) inklusive.
 * Tiefe: `events/{id}` mit rund 30 Marktgruppen je Event.
 *
 * ## Warum nicht mehr `hourEvents`
 *
 * Vorher standen hier `hourEvents/today` und `.../tomorrow-12`. Zusammen
 * decken die rund 36 Stunden ab — passend, solange die App ein Tagesfenster
 * zeigte, und zu kurz, seit sie eine Woche zeigt. Tipico war damit der einzige
 * Anbieter, der das Fenster nicht ausfüllte.
 *
 * Über die Zeitachse ist da nicht mehr zu holen: `hourEvents/{n}` nimmt 24 und
 * 48, aber nicht 72 oder 168, und `upcoming`, `next`, `48hrs` sowie die
 * naheliegenden Gruppenpfade antworten mit 400 oder 404. Der Weg führt statt
 * über die Zeit über die **Wettbewerbs-IDs** aus `navigationTree/all`:
 * `selectedEvents/all/{groupId}` liefert das vollständige Programm eines
 * Knotens. Und weil die Sportart selbst ein Knoten ist — Fußball ist 1101 —
 * genügt dafür ein Aufruf.
 *
 * Gemessen: 516 Partien in einer Antwort (666 kB), 480 davon mit Quoten, 449
 * mit Sportradar-ID, Anstoßzeiten von heute bis in den Dezember. Der Zuschnitt
 * auf das Zeitfenster passiert danach lokal über `ctx.windowMs`.
 *
 * Die Antwort hat dieselbe Form wie die alte, nur unter dem Schlüssel
 * `SELECTION` statt `UPCOMING` — `fetchList` liest den Umschlag ohnehin
 * generisch, deshalb bleibt der Parser unverändert.
 */

const BASE = 'https://sports.tipico.de/v1/tpapi/programgateway/program'
const COMMON = 'language=de&isLoggedIn=0&licenseRegion=DE&maxMarkets=1'

/**
 * Wettbewerbs-ID des Knotens „Fußball" im `navigationTree/all`.
 *
 * Der Baum ist hierarchisch: unter 1101 hängen Champions League, Bundesliga
 * und der Rest. `selectedEvents` liefert für einen Knoten alles darunter —
 * deshalb genügt die Wurzel der Sportart statt einer Liste einzelner Ligen.
 * Die ID ist seit Monaten stabil; ändert sie sich, meldet der Adapter null
 * Events und die Diagnose zeigt es sofort.
 */
const SOCCER_GROUP_ID = 1101

/**
 * Sportarten samt Knoten-ID aus `navigationTree/all` und dem Schlüssel, unter
 * dem `eventsBySport` die zugehörigen Partien führt.
 */
const SPORTS: { groupId: number; key: string; sport: Sport }[] = [
  { groupId: SOCCER_GROUP_ID, key: 'soccer', sport: 'FOOTBALL' },
  { groupId: 5101, key: 'tennis', sport: 'TENNIS' },
  { groupId: 2101, key: 'basketball', sport: 'BASKETBALL' },
  { groupId: 4101, key: 'ice-hockey', sport: 'ICEHOCKEY' },
  { groupId: 6101, key: 'handball', sport: 'HANDBALL' },
  // 16101 heißt bei Tipico "football" — das ist **American** Football; der
  // Fußball hängt unter 1101 und dem Schlüssel "soccer".
  { groupId: 16101, key: 'football', sport: 'AMERICANFOOTBALL' },
  { groupId: 22101, key: 'darts', sport: 'DARTS' },
  { groupId: 23101, key: 'volleyball', sport: 'VOLLEYBALL' },
]

/**
 * 100 ms statt des Standards von 250 ms.
 *
 * Bisher stand hier gar nichts, der Standard galt — und weil der Limiter nur
 * Schübe taktete, lief die Tiefenphase mit `pooled(…, 5, …)` gemessen mit
 * 20 Requests/s. Der Standard hätte sie auf 4/s gedrückt und die 60 Detail-
 * abrufe von 3 auf 15 s verlängert. 100 ms halten die Phase bei 6 s und
 * bleiben mit 10/s klar unter dem, was der Endpunkt monatelang klaglos
 * getragen hat. Tipico hat auf den Datenendpunkten keinen Bot-Schutz; ein
 * Limit ist hier Höflichkeit, keine Notwehr.
 */
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
 * Tipico kodiert bei Abschnitts- und Teammärkten mehrere Werte in einem
 * Feld: "1:2.5" heißt 1. Halbzeit, Linie 2,5 — und "2:1.5" heißt Team 2,
 * Linie 1,5. Naives Strippen der Sonderzeichen ergäbe daraus 12.5 bzw. 21.5
 * und damit Linien, die es nicht gibt.
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
 * Was der Abschnittsindex in `fixedParam` **in dieser Sportart** zählt.
 *
 * Der Fußball-Abbilder benutzt dafür `periodFromIndex`, und das ist außerhalb
 * des Fußballs falsch: bei Tipico trägt `section-win` im Basketball die
 * **Viertel**nummer, nicht die Halbzeit. `periodFromIndex` machte daraus
 * `1 → H1`, `2 → H2` und für 3 und 4 ein `FT`, das der Aufrufer anschließend
 * auf `H1` zurückbog.
 *
 * Damit fielen "Wer gewinnt das 1./3./4. Viertel?" **und** "Wer gewinnt die
 * 1. Halbzeit?" auf denselben Schlüssel. Der Scanner nimmt je Seite die beste
 * Quote — und nahm für die Halbzeit das 1,45 aus dem vierten Viertel statt der
 * echten 1,16. Aus 112 % impliziter Summe wurden so scheinbare 5,3 % Rendite:
 * eine Wette, die es nie gab.
 *
 * `null` heißt „nicht bestimmbar" und führt zum Verwerfen. Ein verworfener
 * Markt kostet eine Gelegenheit, ein falsch zugeordneter kostet Geld.
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
 * Übersetzt einen Tipico-Markttyp ins kanonische Modell.
 *
 * Unbekannte Typen geben `null` zurück und werden verworfen — ein falsch
 * gemappter Markt erzeugt Phantom-Arbs, ein fehlender kostet nur eine Chance.
 */
/**
 * Tennis-Markttypen.
 *
 * Drei Typnamen teilt sich Tennis mit dem Fußball und meint etwas anderes:
 *
 *   `standard`              Fußball → 1X2 mit Unentschieden
 *                           Tennis  → zweiseitig, Seiten "1" und "2"
 *   `section-win`           Fußball → Halbzeit-Siegwette
 *                           Tennis  → **Satz**-Sieger, `fixedParam` = Satznummer
 *   `points-more-less-than` Fußball → Über/Unter Tore
 *                           Tennis  → Über/Unter **Sätze**, Seiten "+" und "-"
 *
 * Der erste Fall ist der teuerste: als `1X2` verbucht verlangt der Markt über
 * `SIDES` eine Unentschieden-Seite, die es im Tennis nie gibt. Er wäre nie
 * vollständig geworden und lautlos aus jeder Auswertung gefallen — bei allen
 * 168 Partien.
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

    // "Handicap (0:1,5)" — dieselbe Doppelpunkt-Schreibweise wie beim Fußball,
    // aber zweiwegig und in Sätzen.
    case 'handicap': {
      const line = parseHandicap(fixedParam)
      return line === null ? null : { type: 'AH', period: 'FT', line, subject: null, unit: 'SETS' }
    }

    // "+/- Sätze im Match (2,5)". Die Einheit steht **nur** in der
    // Beschriftung; ohne sie ist nicht zu entscheiden, ob in Sätzen oder in
    // Spielen gezählt wird — dann lieber verwerfen als raten.
    case 'points-more-less':
    case 'points-more-less-than': {
      const line = parseLine(fixedParam)
      const unit = /sätze|satz/.test(cap) ? 'SETS' : /spiele|games/.test(cap) ? 'GAMES' : null
      return line === null || !unit ? null : { type: 'OU', period: 'FT', line, subject: null, unit }
    }

    default:
      // Bekannt und bewusst draußen: "gewinnt mindestens einen Satz" hat einen
      // anderen Gegenstand, die Satzwette zu viele Seiten.
      if (!/^(player-set|point-bet|ascendency|type-of-advance|correct-score|first-|next-|game-|tie-?break|ace)/.test(type))
        noteUnmapped('tipico', `TENNIS ${type} :: ${caption}`)
      return null
  }
}

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

    // "-rest"-Typen beziehen sich auf die **Restspielzeit** eines laufenden
    // Spiels, nicht auf das Gesamtergebnis. Sie sehen strukturell identisch
    // aus und würden sonst gegen Ganzspiel-Quoten anderer Buchmacher
    // gerechnet — eine der heimtückischsten Quellen für Phantom-Arbitrage.
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
      // "1:2.5" → Team 1, Linie 2,5. Welches Team gemeint ist, steht im
      // Klartext in der Beschriftung — das ist verlässlicher als der Index.
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
     * "Tor Randers FC ?" — trifft dieses Team überhaupt?
     *
     * Dasselbe wie ein Team-Total über 0,5: "Tor" heißt mindestens eines,
     * "kein Tor" keines. VBET führt die Wette als `Team1ScoreYes/no`, Kambi
     * und Winamax als Team-Über/Unter 0,5 — erst über denselben Schlüssel
     * werden die drei gegeneinander gerechnet.
     *
     * Das Team steht nur im Klartext in der Beschriftung; `fixedParam` trägt
     * hier keinen Index. Ohne Beschriftung (Stufe 1 der Listenabfrage) lässt
     * sich die Seite nicht bestimmen — dann verwerfen statt raten.
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
      // Die Halbzeit steht als "1.HZ"/"2.HZ" in der Beschriftung.
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
      // 1X und X2 überlappen sich — keine saubere Zerlegung, bewusst raus.
      return null
    default:
      // Bekannt und bewusst draußen — ohne Warnung verwerfen.
      //
      // Tipico setzt seine Typnamen aus Bausteinen zusammen, und die
      // Kombiwetten sind darin die Mehrheit: `totals-team-wins`,
      // `double-chance-total`, `score-both-and-points-more-than` sind
      // Schnittmengen zweier Ereignisse und keine Zerlegung. Dazu kommen
      // Ergebniswetten (`point-bet`, `correct-score`, `halftime-fulltime`),
      // Torschützen, Restzeit- und Intervallwetten.
      //
      // Ohne diese Liste meldete Tipico jeden dieser Typen als Lücke und
      // stellte allein über zwanzig Zeilen in den Bericht unter
      // `/api/diagnostics` — die echten Lücken standen darunter und waren
      // nicht mehr zu sehen.
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
    // Ja/Nein nur wegen "Tor <Team> ?" (siehe `team-scores` oben): dort ist Ja
    // gleichbedeutend mit Über 0,5. Die echten Team-Total-Märkte beschriften
    // ihre Seiten mit Über/Unter, die beiden Mengen überschneiden sich nicht.
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
 * Märkte der übrigen Sportarten.
 *
 * Tipico benutzt für Basketball **dieselben Typnamen** wie für Fußball
 * (`standard`, `handicap`, `points-more-less-than`, `team-points-more-less`).
 * Die Bedeutung ist aber eine andere: der Fußball-Abbilder liefert für
 * `standard` immer `1X2` und für `handicap` immer `EH` — beides dreiwegig.
 *
 * Ob ein Markt drei Seiten hat, ist hier nicht der Sportart anzusehen, sondern
 * nur den Auswahlmöglichkeiten: dieselbe Basketballpartie führt eine
 * zweiwegige Siegwette (mit Verlängerung) **und** ein dreiwegiges "Ergebnis"
 * (nur reguläre Spielzeit). Deshalb entscheidet `hasDraw`, und nicht eine
 * Annahme über die Sportart.
 *
 * Und wo ein Unentschieden möglich ist, kann es nur die reguläre Spielzeit
 * sein — in Basketball, Eishockey und American Football wird sonst so lange
 * verlängert, bis einer gewinnt.
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
  // Außerhalb des Fußballs steht der Abschnitt nicht in `section`, sondern im
  // Klartext der Beschriftung: "HC (0,5:0) 1.QR", "HC (0:4,5) 2.HZ",
  // "Über/Unter (89,5) Punkte in der 1 Halbzeit". Ohne diese Auswertung fielen
  // sämtliche Viertel- und Halbzeitmärkte in den Ganzspiel-Topf — und ein
  // Über/Unter 89,5 der ersten Halbzeit gegen ein Über/Unter 89,5 der ganzen
  // Partie gerechnet ergibt eine Rendite, die es nicht gibt.
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
  // Ein Unentschieden schließt die Verlängerung aus — aber nur dort, wo es
  // überhaupt eine gibt. Handball und Volleyball bleiben bei `FT`.
  const period: Period = draw && OVERTIME_SPORTS.has(sport) ? 'RT' : base
  const parts = splitParam(fixedParam)

  // Einheit nur, wo die Sportart mehr als eine führt — siehe `Unit`.
  const unit: Unit | undefined =
    sport === 'VOLLEYBALL' ? 'POINTS' : sport === 'DARTS' ? 'LEGS' : undefined

  switch (type) {
    case 'standard':
      return { type: draw ? '1X2' : '2WAY', period, line: null, subject: null }

    case 'section-win': {
      // Der Klartext hat Vorrang ("Wer gewinnt das 4. Viertel?"), der Index
      // ist die Rückfallebene. Lässt sich beides nicht bestimmen, wird der
      // Markt verworfen statt auf die erste Halbzeit geraten.
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
      // "0.5:0:1" — die ersten beiden Teile sind das Handicap, der dritte der
      // Abschnitt. Im Basketball zählt der dritte Teil Viertel, im Fußball
      // Halbzeiten; welches von beidem, sagt die Beschriftung ("1.QR" gegen
      // "1.HZ"), deshalb hat `capPeriod` hier Vorrang.
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
      // Halbzeiten sind in jeder Sportart Halbzeiten — hier zählt der Index
      // also tatsächlich 1 oder 2.
      const p = capPeriod ?? (parts[0] === '2' ? 'H2' : 'H1')
      return { type: draw ? '1X2' : '2WAY', period: p, line: null, subject: null }
    }

    case 'points-more-less-halftime': {
      // "1:74.5" — erster Teil die Halbzeit, zweiter die Linie. `parseLine`
      // über das ganze Feld ergäbe 174.5.
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
      // "3:35.5" heißt im Basketball **3. Viertel**, Linie 35,5 — nicht
      // Halbzeit. Über `periodFromIndex` wurde daraus ein Ganzspiel-Total von
      // 35,5 Punkten, also eine Linie, die es in dieser Sportart nicht gibt.
      if (parts.length < 2) return null
      const line = parseLine(parts[1])
      const p = capPeriod ?? sectionPeriod(parts[0], sport)
      return line === null || !p ? null : { type: 'OU', period: p, line, subject: null, unit }
    }

    case 'team-points-more-less':
    case 'team-points-more-less-halftime': {
      // "1:85.5" → Team 1, Linie 85,5. Welches Team gemeint ist, steht im
      // Klartext in der Beschriftung ("+/- (85,5) für Chicago Sky") — das ist
      // verlässlicher als der Index.
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

      case 'totals-team-wins':
    case 'team-wins-both-halves':
    case 'halftime-fulltime':
      // Kombinationen aus Sieger und Gesamtzahl — Schnittmengen zweier
      // Ereignisse, keine Zerlegung.
      return null

  // Restspielzeit-Märkte eines laufenden Spiels — strukturell wie ein
    // Ganzspielmarkt, inhaltlich etwas anderes.
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

/** Quoten aus der Listenantwort (Stufe 1). */
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

      // Das Halbzeitergebnis hängt als eigene Gruppe am Hauptmarkt. Im Tennis
      // gibt es keine Halbzeiten; in den übrigen Sportarten schon, aber Tipico
      // liefert sie dort nicht über dieses Feld.
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

/** Volle Markttiefe für ein einzelnes Event (Stufe 2). */
async function fetchOutcomes(
  eventId: string,
  teams: { home: string; away: string },
  sport: Sport = 'FOOTBALL',
): Promise<RawOutcome[]> {
  const d = await fetchJson<EventDetail>(`${BASE}/events/${eventId}?language=de`, OPTS)
  const out: RawOutcome[] = []

  for (const [groupId, group] of Object.entries(d.oddGroups ?? {})) {
    // Die Auswahlmöglichkeiten müssen **vor** dem Markt stehen: außerhalb des
    // Fußballs entscheidet erst ihre Zahl, ob es ein drei- oder zweiwegiger
    // Markt ist — und damit auch, ob die Verlängerung mitzählt.
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
      // Je Sportart ein Aufruf über den Wurzelknoten, dazu die laufenden
      // Spiele. `groupOutrightsByTeam` bündelt Langzeitwetten je Team; die
      // fallen ohnehin durch die Marktzuordnung, halten die Antwort aber
      // kleiner.
      ...SPORTS.map((s) =>
        fetchList(`${BASE}/events/selectedEvents/all/${s.groupId}?groupOutrightsByTeam=true&${COMMON}`),
      ),
      fetchList(`${BASE}/events/live?widget=true&selectedSports=top-sport&limitPerSport=5&${COMMON}`),
    ])

    const leagues = new Map<number, string>()
    /** Event-ID → Sportart, aus `eventsBySport` der Antwort. */
    const sportOf = new Map<string, (typeof SPORTS)[number]>()
    const groups = new Map<string, Record<string, ListGroup[]>>()
    const events = new Map<string, ListEvent>()

    for (const r of lists) {
      if (r.status !== 'fulfilled') continue
      for (const [k, v] of r.value.leagues) leagues.set(k, v)
      for (const s of SPORTS) for (const id of r.value.idsBySport.get(s.key) ?? []) sportOf.set(id, s)
      for (const [k, v] of r.value.groups) groups.set(k, v)
      for (const e of r.value.events) if (e?.id) events.set(String(e.id), e)
    }

    const cutoff = Date.now() + ctx.windowMs
    const now = new Date().toISOString()

    return [...events.values()].flatMap((e) => {
      // Ohne Eintrag in `eventsBySport` gehört das Event zu keiner der
      // unterstützten Sportarten — der Live-Abruf liefert auch Basketball
      // und Eishockey mit.
      const spec = sportOf.get(String(e.id))
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
          // Nur `status` zählt. `type: 'live'` heißt bei Tipico „live
          // bewettbar", nicht „läuft gerade": im Programm-Endpunkt tragen 176
          // von 516 Partien dieses Feld, obwohl sie Tage in der Zukunft
          // liegen. Die alte Oder-Verknüpfung stammt aus der Zeit der
          // Stunden-Scheiben, wo beides zusammenfiel — hier hätte sie ein
          // Drittel des Programms als Live-Wette abgestempelt und damit von
          // der Arbitrage-Bewertung ausgeschlossen (siehe server/scan.ts).
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
      const sport: Sport = sportFromLabel(ev.sport) ?? 'FOOTBALL'
      const outcomes = await fetchOutcomes(ev.bookEventId, { home: ev.home, away: ev.away }, sport)
      return outcomes.length
        ? { ...ev, outcomes, fetchedAt: new Date().toISOString() }
        : ev
    })
    return results.map((r, i) => (r.status === 'fulfilled' ? r.value : events[i]))
  },
}
