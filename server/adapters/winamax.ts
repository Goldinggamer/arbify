import { fetchText, pooled } from '../http.ts'
import { readStateAfter } from './html-state.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport, Unit } from '../types.ts'
import { OVERTIME_SPORTS, SPORT_LABEL, sportFromLabel } from '../types.ts'
import { teamTokens, tokenSimilarity } from '../match.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'
import { nameMatch } from '../players.ts'

/**
 * Winamax.
 *
 * Kein JSON-Endpunkt: der komplette Zustand steckt als `PRELOADED_STATE` im
 * HTML. Das ist hier ein Vorteil — **ein einziger Abruf** der Fußball-Seite
 * liefert rund 900 Partien mit Siegwette. Für die Markttiefe gibt es eine
 * Detailseite je Partie mit über 100 Märkten.
 *
 * Zwei Eigenheiten, die Sorgfalt verlangen:
 *
 *  - **Ganzzahlige Torlinien.** Winamax bietet "Anzahl Tore" auch als
 *    `total=2`, nicht nur `total=2.5`. Bei genau zwei Toren gibt es den
 *    Einsatz zurück. Diese Linien werden übernommen und in `server/scan.ts`
 *    als Push-Linien behandelt — die Begründung steht bei `lineOf` unten.
 *  - **Keine Sportradar-Match-ID.** Es gibt nur Turnier- und Saison-IDs
 *    (`srTournamentId`), die das einzelne Spiel nicht identifizieren. Das
 *    Matching läuft daher über Teamnamen und Anstoßzeit.
 */

const HOST = 'https://www.winamax.de'
/**
 * `retryOn403: false`, weil die 403 hier nicht vorübergehend ist.
 *
 * Die Sperre kommt von CloudFront und hängt **nicht** an den Headern: fünf
 * Header-Varianten (JSON-`accept` wie hier, Dokument-`accept`, volle
 * Browser-Navigation mit `user-agent`/`sec-fetch-*`/`sec-ch-ua`) lieferten
 * über 60 Abrufe im Wechsel ausnahmslos 200. Es ist ein mengenbasiertes
 * Limit pro IP: gemessen ab freiem Zustand mit einem Request pro Sekunde
 * kam die erste 403 bei Request 194 nach 212 s — rund 190 Abrufe je
 * Fünf-Minuten-Fenster, unabhängig vom Takt (150 Requests mit 12/s blieben
 * frei, solange das Fenster leer war). Greift die Sperre, wird *jeder*
 * Request abgewiesen, und zwar ~150 s lang; darum rettet kein Retry sie und
 * der Adapter scheitert sofort, statt den Scan um 14 s zu verlängern.
 *
 * Ein Lauf kostet mit voller Tiefe 61 Abrufe und liegt damit bewusst über
 * dem, was das Fenster auf Dauer trägt: die Sperre wird in Kauf genommen,
 * die volle Markttiefe ist es wert. Winamax fällt darum in Serien von Scans
 * zeitweise ganz aus — das ist erwartetes Verhalten, kein neuer Fehler.
 */
const OPTS = { transport: 'impit' as const, minIntervalMs: 250, retryOn403: false }
const MARKER = 'PRELOADED_STATE'

/** Obergrenze für Detailseiten je Aufruf; deckt sich mit `maxDepthEvents`. */
const MAX_DEPTH = 60

/**
 * Winamax-Sportkennungen, gemessen über `/sportwetten/sports/{id}` und die
 * Turniernamen der zurückgegebenen Partien.
 *
 * Nicht geführt, weil das Modell sie nicht kennt: 3 Baseball, 9 Golf,
 * 11 Motorsport, 12 Rugby, 13 Australian Football, 17 Radsport, 19 Snooker,
 * 21 Cricket, 24 Feldhockey.
 */
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
 * "total=2.5" → 2.5, "hcp=-1.5" → −1.5
 *
 * `hcp` ist die Schreibweise des **Tennis**-Handicaps und stand hier lange
 * nicht drin. Der Fußball-Zweig kommt ohne aus, deshalb fiel es nicht auf:
 * "Differenz der Sätze (Handicap)" wurde sauber als Markt erkannt, fand dann
 * aber keine Linie und verschwand. Sichtbar war das nur daran, dass Winamax
 * als einziges Buch null Handicaps beisteuerte, obwohl es sie führt.
 */
function lineOf(special: string | undefined): number | null {
  const m = /(?:total|handicap|hcp)\s*=\s*(-?[\d.]+)/.exec(special ?? '')
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * Ganzzahlige Torlinien bleiben drin — siehe `PUSH_BOOKS` in `server/scan.ts`.
 *
 * Hier stand ein `isHalfLine`-Filter, der jede ganzzahlige Linie verwarf.
 * Begründet war er mit dem Ergebnisraum: bei genau zwei Toren gibt es auf
 * "Anzahl Tore 2" den Einsatz zurück, die beiden Seiten decken also nicht alles
 * ab. Das stimmt — für die Arbitrage ist es aber ohne Belang, solange **beide**
 * Beine auf derselben ganzzahligen Linie liegen: dann werden bei genau N Toren
 * beide Wetten annulliert, der Einsatz kommt vollständig zurück, und sonst
 * gewinnt genau eines. Der schlechteste Ausgang ist die Null, nicht der Verlust.
 *
 * Nachgemessen an drei Partien: Winamax führt die ganzen Linien durchgehend
 * **zweiseitig** (Über 1 / Unter 1, keine dritte Auswahl), und die Quoten
 * liegen sauber zwischen den benachbarten halben Linien — 1,5 → 1,22 · 2 →
 * 1,34 · 2,5 → 1,72. Dieselbe Staffel wie bei AdmiralBet und VBET, die die
 * Linien ebenfalls anbieten. Der Filter kostete also reine Vergleichsfläche:
 * Über/Unter 1,0 kam über alle Bücher hinweg auf **null** Vergleiche, obwohl
 * drei Anbieter den Markt führen.
 */

/**
 * Tennis-Markttitel.
 *
 * Die Satznummer steht bei Winamax nicht im Titel, sondern im
 * `specialBetValue` als `setnr=1`. Der Titel trägt sie zwar zusätzlich
 * ("1. Satz - Gewinner"), aber das Feld ist die verlässlichere Quelle.
 */
export function toTennisMarket(bet: Bet, home: string, away: string): CanonicalMarket | null {
  const title = (bet.betTitle ?? '').trim()
  const t = title.toLowerCase()
  const template = bet.template ?? ''
  const spec = bet.specialBetValue ?? ''

  const setNr = /setnr\s*=\s*([1-5])/.exec(spec)?.[1]
  const period = (setNr ? `S${setNr}` : 'FT') as CanonicalMarket['period']

  // Matchsieger und Satzsieger — beide zweiseitig, beide `2way`.
  if (template === '2way' && /^(\d\. satz - )?gewinner$/.test(t))
    return { type: '2WAY', period, line: null, subject: null }

  // "Anzahl Sätze" — Über/Unter in Sätzen.
  if (template === 'OverUnder' && t === 'anzahl sätze') {
    const line = lineOf(spec)
    return line === null ? null : { type: 'OU', period, line, subject: null, unit: 'SETS' }
  }
  if (template === 'OverUnder' && /^(anzahl (der )?spiele|anzahl games)$/.test(t)) {
    const line = lineOf(spec)
    return line === null ? null : { type: 'OU', period, line, subject: null, unit: 'GAMES' }
  }

  // "Differenz der Sätze (Handicap)" — `hcp` steht aus Heimsicht, geprüft an
  // den Beschriftungen: bei `hcp=-1.5` heißt die Heimseite "X −1.5", bei
  // `hcp=1.5` heißt sie "X +1.5".
  if (template === 'asian_handicap' && /handicap/.test(t)) {
    const line = lineOf(spec)
    if (line === null) return null
    const unit = /satz|sätze/.test(t) ? 'SETS' : /spiel|game/.test(t) ? 'GAMES' : null
    return unit ? { type: 'AH', period, line, subject: null, unit } : null
  }

  // Bekannt und bewusst draußen: Tiebreak und "gewinnt mindestens einen Satz"
  // haben einen anderen Gegenstand, die Ergebniswetten zu viele Seiten.
  // `ListOdd` ist bei Winamax durchgehend die Langzeitwette — "Sieger" und
  // "Siegerin" meinen hier den **Turniersieger**, nicht den Matchsieger. Die
  // Ähnlichkeit der Namen ist die Falle: als Matchsieger verbucht wäre das
  // ein Feld mit dutzenden Auswahlmöglichkeiten gegen ein Zwei-Weg-Rennen.
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
 * Märkte der übrigen Sportarten.
 *
 * Winamax stellt den Abschnitt **vor** den Marktnamen und trennt mit " - ":
 *
 *   "Gewinner"                                  2-Weg, mit Verlängerung
 *   "Ergebnis"                                  3-Weg — nur reguläre Spielzeit
 *   "Ergebnis (ohne Verlängerung(en))"          3-Weg, ausdrücklich
 *   "Punktedifferenz (handicap)"    hcp=9.5     2-Weg-Handicap
 *   "1. Viertel - Punktedifferenz (handicap)"   quarternr=1|hcp=0.5
 *   "Anzahl Punkte"                 total=177.5
 *   "Anzahl Punkte von New York Liberty"        Team-Total
 *   "1. Halbzeit - Anzahl der Punkte - Gerade/ungerade"
 *
 * Dass "Gewinner" und "Ergebnis" **verschiedene Wetten** sind, ist der
 * springende Punkt: die eine hat zwei Seiten und schließt die Verlängerung
 * ein, die andere hat drei und endet nach der regulären Spielzeit. Bei
 * American Football schreibt Winamax das sogar dazu.
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

  // Bekannt und bewusst draußen. "Erstattung bei Unentschieden" gibt beim
  // Remis den Einsatz zurück und ist damit keine schlichte 2-Weg-Wette;
  // gegen ein echtes 2-Weg-Angebot gerechnet käme eine Scheinrendite heraus.
  //
  // `180s` ist der Darts-Fall: "Gesamtanzahl 180s" und "C. Reyes Gesamtanzahl
  // 180s" zählen **Maximalwürfe**, nicht Legs. Das Modell kennt dafür keine
  // Einheit, und ohne diesen Ausschluss landeten beide Spielerwerte mit Linie
  // 2,5 als Gesamt-Legs auf demselben Schlüssel.
  if (
    /erstattung bei unentschieden|eines spielers|kopf an kopf|meilenstein|double-double|triple-double|bester |doppelte chance|^verlängerung$|mit den meisten|halbzeit\/|und anzahl|genaues ergebnis|^sieg mit|180s|checkout|aufnahme|highest/.test(
      t,
    ) ||
    template === 'ListOdd' ||
    template === 'List' ||
    template === 'dynamic'
  )
    return null

  // Siegwette. Drei Seiten heißt reguläre Spielzeit — ein Unentschieden gibt
  // es nur dort, wo noch nicht verlängert wurde. Winamax bestätigt das bei
  // American Football im Titel: "Ergebnis (ohne Verlängerung(en))".
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
    // Team-Total. Winamax schreibt es in **zwei** Formen, je nach Abschnitt:
    //
    //   ganze Partie   "Anzahl Punkte von New York Liberty"
    //   Viertel        "1. Viertel - Japan (F) Punkte"
    //   Halbzeit       "1. Halbzeit - Anzahl der Punkte Spanien (F)"
    //
    // Nur die erste stand hier. Damit fielen "1. Viertel - Japan (F) Punkte"
    // und "1. Viertel - Mali (F) Punkte" — beide mit Linie 18,5 — in den
    // Gesamttotal-Topf und landeten auf demselben Schlüssel. Ein Team-Total
    // als Spieltotal geführt ist eine völlig andere Wette: 18,5 Punkte einer
    // Mannschaft gegen 18,5 Punkte beider zusammen.
    const rest = t.replace(/^\d?\.?\s*(viertel|halbzeit|hälfte|drittel|satz)\s*-\s*/, '')
    const wer =
      // "Anzahl Punkte von New York Liberty" und
      // "Anzahl der Punkte Spanien (F)" — das "von" ist optional.
      /anzahl (?:der )?(?:punkte|tore|sätze|legs|games)\s+(?:von\s+)?(.+)$/.exec(rest)?.[1] ??
      // "Japan (F) Punkte" — Name vor dem Substantiv.
      /^(.+?)\s+(?:punkte|tore|sätze|legs|games)$/.exec(rest)?.[1]

    if (wer) {
      const who = wer.trim()
      const h = tokenSimilarity(teamTokens(who), teamTokens(home))
      const a = tokenSimilarity(teamTokens(who), teamTokens(away))
      // Passt der Text zu keiner der beiden Mannschaften, ist es kein
      // Team-Total, sondern der Gesamtmarkt ("Anzahl Punkte") — dann fällt es
      // unten durch. Passt er zu beiden gleich gut, wird verworfen statt
      // geraten: ein vertauschtes Team ist eine erfundene Wette.
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

  // Die Halbzeit steht bei Winamax **vor** dem Marktnamen
  // ("1. Halbzeit - Anzahl Tore"), nicht dahinter.
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

  // Das Team-Total der Halbzeit heißt anders als das des Ganzspiels: dort
  // "Anzahl Tore **von** X", hier "1. Halbzeit - Anzahl der Tore X" — ohne
  // "von" und mit "der". Beide Formen müssen ausgeschrieben stehen, ein
  // gemeinsames Muster gibt es nicht.
  const teamHalf = /^([12])\. halbzeit ?- ?anzahl der tore (.+)$/.exec(t)
  if (template === 'OverUnder' && teamHalf) {
    if (line === null) return null
    const team = teamHalf[2].trim()
    const subject = team === home.toLowerCase() ? 'HOME' : team === away.toLowerCase() ? 'AWAY' : null
    return subject ? { type: 'TEAM_OU', period: teamHalf[1] === '1' ? 'H1' : 'H2', line, subject } : null
  }

  // Winamax stellt dieselbe Wette unter zwei Titeln: in der Übersicht als
  // Frage ("Schießen beide Mannschaften ein Tor?"), auf der Detailseite als
  // Aussage ("Beide Mannschaften treffen"). Beide sind Ganzspiel-BTTS.
  if (
    template === '2way' &&
    /^(beide (mannschaften|teams) treffen|schießen beide (mannschaften|teams) ein tor\?)$/.test(t)
  )
    return { type: 'BTTS', period: 'FT', line: null, subject: null }

  if (template === '2way' && /^([12])\. halbzeit ?- ?beide (mannschaften|teams) treffen$/.test(t))
    return { type: 'BTTS', period: t.startsWith('1.') ? 'H1' : 'H2', line: null, subject: null }

  // "Anzahl **der** Tore - Gerade/Ungerade" ist die tatsächliche Schreibweise;
  // das frühere Muster verlangte "Anzahl Tore" und hat deshalb nie gegriffen.
  // Der Titel muss verankert bleiben: "Anzahl der Tore **von** X -
  // Gerade/Ungerade" ist die Parität eines einzelnen Teams und im Modell nicht
  // vorgesehen — ein loses Muster würde sie als Gesamtparität verbuchen.
  if (template === '2way' && /^anzahl (der )?tore ?- ?gerade\/ungerade$/.test(t))
    return { type: 'OE', period: 'FT', line: null, subject: null }

  if (template === '2way' && /^([12])\. halbzeit ?- ?anzahl (der )?tore ?- ?gerade\/ungerade$/.test(t))
    return { type: 'OE', period: t.startsWith('1.') ? 'H1' : 'H2', line: null, subject: null }

  // Kombiwetten tragen die Namen echter Märkte ("Ergebnis und Anzahl Tore",
  // "Doppelte Chance und beide Mannschaften treffen") und sind der
  // umfangreichste Teil des Winamax-Angebots. Sie sind Schnittmengen zweier
  // Ereignisse, also keine Zerlegung — und kein einziger unterstützter Titel
  // enthält " und ", weshalb das Wort hier als Kennzeichen ausreicht.
  if (/ und /.test(t)) return null

  // Bekannt und bewusst nicht unterstützt — ohne Warnung verwerfen.
  // "anzahl der tore von … gerade/ungerade" ist die Parität eines einzelnen
  // Teams; das Modell kennt nur die Gesamtparität, ein `subject` ist bei OE
  // nicht vorgesehen.
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
    // Die Codes sind hier **keine** festen Seiten: dasselbe `yes` steht bei
    // `hcp=-1.5` für den Heimspieler ("K. Nishikori -1.5") und bei `hcp=1.5`
    // für den Gast ("J. Shang -1.5"). Wer den Code als Seite nimmt, dreht bei
    // jedem zweiten Handicap die Beine um. Verlässlich ist allein die
    // Beschriftung — abzüglich der angehängten Linie.
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
  if (market.type === 'BTTS') {
    if (label === 'ja') return 'YES'
    if (label === 'nein') return 'NO'
    return null
  }
  if (market.type === 'OE') {
    if (label.startsWith('ungerade')) return 'ODD'
    if (label.startsWith('gerade')) return 'EVEN'
    return null
  }
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
        ? toTennisMarket(bet, home, away)
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
    // Winamax liefert nur Turnier- und Saison-IDs, keine Match-ID von Sportradar.
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
    // sportId 1 ist Fußball, 5 ist Tennis. Je Sportart genügt ein Abruf für
    // das gesamte Programm. `Promise.allSettled`, weil Winamax bei aktiver
    // Sperre *jeden* Request abweist — dann soll nicht die eine Sportart die
    // andere mitreißen.
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
        if (m.matchStart * 1000 > cutoff) continue
        const home = m.competitor1Name?.trim() ?? ''
        const away = m.competitor2Name?.trim() ?? ''
        const ev = buildEvent(state, m, outcomesFor(state, m.matchId, home, away, s.sport), s.sport)
        if (ev) out.push(ev)
      }
    }
    return out.slice(0, ctx.maxEvents)
  },

  async fetchDepth(events: RawEvent[]): Promise<RawEvent[]> {
    const targets = events.slice(0, MAX_DEPTH)
    const results = await pooled(targets, 4, async (ev) => {
      const state = await loadState(`${HOST}/sportwetten/match/${ev.bookEventId}`)
      if (!state) return ev
      const sport: Sport = sportFromLabel(ev.sport) ?? 'FOOTBALL'
      const outcomes = outcomesFor(state, Number(ev.bookEventId), ev.home, ev.away, sport)
      return outcomes.length > ev.outcomes.length
        ? { ...ev, outcomes, fetchedAt: new Date().toISOString() }
        : ev
    })
    // Nur die vertieften Events zurückgeben; der Aufrufer behält für alle
    // übrigen den flachen Stand.
    return results.map((r, i) => (r.status === 'fulfilled' ? r.value : targets[i]))
  },
}
