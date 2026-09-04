/**
 * Kanonisches Datenmodell.
 *
 * Der ganze Sinn dieser Datei: jeder Buchmacher benennt Märkte anders
 * ("Endergebnis" / "MRES" / "standard"). Bevor irgendetwas verglichen wird,
 * übersetzt jeder Adapter seine Quoten in exakt dieses Modell. Nur wenn zwei
 * Outcomes denselben `marketKey` und dieselbe `side` haben, dürfen sie
 * gegeneinander gerechnet werden.
 */

export type Sport =
  | 'FOOTBALL'
  | 'TENNIS'
  | 'BASKETBALL'
  | 'HANDBALL'
  | 'VOLLEYBALL'
  | 'ICEHOCKEY'
  | 'AMERICANFOOTBALL'
  | 'DARTS'

/**
 * Anzeigename je Sportart — und zugleich das, was in `RawEvent.sport` steht.
 *
 * Die Zeichenkette ist **kein** Kosmetikum: der Sportfilter der Oberfläche
 * vergleicht sie zeichengenau (siehe `src/data/markets.ts`). Vorher schrieb
 * jeder Adapter sie selbst als Ternär-Kette hin (`sport === 'TENNIS' ?
 * 'Tennis' : 'Fußball'`). Bei zwei Sportarten ging das; bei acht ist ein
 * Tippfehler in einem von sechzehn Adaptern eine Sportart, die bei genau
 * diesem Buch unsichtbar bleibt — ohne Fehlermeldung, weil das Backend die
 * Partie ja liefert und nur der Filter sie wegwirft.
 */
export const SPORT_LABEL: Record<Sport, string> = {
  FOOTBALL: 'Fußball',
  TENNIS: 'Tennis',
  BASKETBALL: 'Basketball',
  HANDBALL: 'Handball',
  VOLLEYBALL: 'Volleyball',
  ICEHOCKEY: 'Eishockey',
  AMERICANFOOTBALL: 'American Football',
  DARTS: 'Darts',
}

const SPORT_BY_LABEL = new Map<string, Sport>(
  Object.entries(SPORT_LABEL).map(([k, v]) => [v, k as Sport]),
)

/**
 * Rückweg vom Anzeigenamen zur Modellkennung.
 *
 * `RawEvent.sport` trägt die Beschriftung, nicht die Kennung — historisch, weil
 * die Oberfläche sie direkt anzeigt. Alles, was serverseitig nach Sportart
 * unterscheidet (Gruppierung, Tiefenbudget, Warnungen), braucht den Rückweg.
 * `null` für Unbekanntes, damit ein Adapter mit Tippfehler nicht stillschweigend
 * als Fußball durchgeht.
 */
export const sportFromLabel = (label: string): Sport | null => SPORT_BY_LABEL.get(label) ?? null

/**
 * Sportarten mit **einzelnen Sportlern** statt Mannschaften.
 *
 * Für sie gilt der Namensabgleich aus `server/players.ts`: Vereinsnamen werden
 * über Wortmengen verglichen, Personennamen über Nachname plus Initialen.
 * "van Gerwen M." und "Michael van Gerwen" teilen als Wortmengen nur zwei von
 * drei Wörtern und fielen sonst durch.
 */
export const INDIVIDUAL_SPORTS: ReadonlySet<Sport> = new Set<Sport>(['TENNIS', 'DARTS'])

/** Sportarten, in denen eine Verlängerung die Wertung ändern kann. */
export const OVERTIME_SPORTS: ReadonlySet<Sport> = new Set<Sport>([
  'BASKETBALL',
  'ICEHOCKEY',
  'AMERICANFOOTBALL',
])

/**
 * Spielabschnitt.
 *
 * `FT` heißt "die Partie, so wie sie gewertet wird" — im Fußball also 90
 * Minuten plus Nachspielzeit, im Basketball **einschließlich** Verlängerung.
 * `RT` ist der Gegenpart: ausdrücklich nur die reguläre Spielzeit.
 *
 * Warum das ein eigener Abschnitt sein muss und keine Fußnote: bei bwin steht
 * an derselben Partie „Gesamt (inkl. Verlängerung und Penalties) 6,5" **und**
 * „Drei Wege (Nur reguläre Spielzeit)". Das sind zwei verschiedene Wetten mit
 * derselben Linie. Fielen sie auf denselben Schlüssel, würde ein Über mit
 * Verlängerung gegen ein Unter ohne gerechnet — eine Arbitrage, die genau
 * dann verliert, wenn es in die Verlängerung geht.
 *
 * `H1`/`H2` sind Halbzeiten (Fußball, Basketball, Handball, American
 * Football), `Q1`…`Q4` Viertel (Basketball, American Football), `P1`…`P3`
 * Drittel (Eishockey), `S1`…`S5` Sätze (Tennis, Volleyball, Darts).
 */
export type Period =
  | 'FT'
  | 'RT'
  | 'H1'
  | 'H2'
  | 'Q1'
  | 'Q2'
  | 'Q3'
  | 'Q4'
  | 'P1'
  | 'P2'
  | 'P3'
  | 'S1'
  | 'S2'
  | 'S3'
  | 'S4'
  | 'S5'

/**
 * Worin eine Linie zählt.
 *
 * Gesetzt wird sie **nur in Sportarten, die mehr als eine Einheit führen** —
 * sonst bleibt sie weg. Fußball, Basketball, Handball, Eishockey und American
 * Football haben je genau eine (Tore bzw. Punkte); dort wäre die Angabe
 * redundant, und jede redundante Angabe ist eine Stelle, an der ein Adapter
 * von den anderen abweichen kann.
 *
 * Zwingend ist sie dagegen bei:
 *   Tennis     — Satz-Handicap −1,5 und Spiele-Handicap −1,5 gleichzeitig,
 *                dazu Gesamtsätze 2,5 und Gesamtspiele 22,5
 *   Volleyball — Gesamtsätze 3,5 neben Gesamtpunkten 180,5
 *   Darts      — Gesamt-Legs 20,5 neben Gesamtsätzen 5,5
 *
 * Ohne Einheit fallen die Paare auf denselben Schlüssel, und dann wird ein
 * Satz-Über gegen ein Spiele-Unter gerechnet.
 */
export type Unit = 'GAMES' | 'SETS' | 'POINTS' | 'LEGS'

export type MarketType =
  /** Siegwette, 3-Weg */
  | '1X2'
  /** Siegwette, 2-Weg — Tennis kennt kein Unentschieden */
  | '2WAY'
  /** Über/Unter gesamt */
  | 'OU'
  /** Beide Teams treffen */
  | 'BTTS'
  /** Europäisches Handicap, 3-Weg (Tore-Vorsprung) */
  | 'EH'
  /** Handicap, 2-Weg — Tennis-Handicaps auf Sätze oder Spiele */
  | 'AH'
  /** Über/Unter für ein einzelnes Team bzw. einen einzelnen Spieler */
  | 'TEAM_OU'
  /** Gesamtzahl gerade/ungerade */
  | 'OE'

export type Side = 'HOME' | 'DRAW' | 'AWAY' | 'OVER' | 'UNDER' | 'YES' | 'NO' | 'ODD' | 'EVEN'

/**
 * Welche Seiten ein Markt haben muss, damit er vollständig ist. Nur
 * vollständige Märkte kommen in die Arbitrage-Berechnung — sonst würde ein
 * fehlendes Bein als "besonders profitabel" durchgehen.
 */
export const SIDES: Record<MarketType, Side[]> = {
  '1X2': ['HOME', 'DRAW', 'AWAY'],
  '2WAY': ['HOME', 'AWAY'],
  OU: ['OVER', 'UNDER'],
  BTTS: ['YES', 'NO'],
  EH: ['HOME', 'DRAW', 'AWAY'],
  AH: ['HOME', 'AWAY'],
  TEAM_OU: ['OVER', 'UNDER'],
  OE: ['ODD', 'EVEN'],
}

export type CanonicalMarket = {
  type: MarketType
  period: Period
  /**
   * Linie aus Heim-Sicht. Bei OU die Grenze (2.5), bei EH/AH der Vorsprung
   * des Heimteams (−1 wenn Heim ein Tor Rückstand gegeben bekommt).
   * `null` für Märkte ohne Linie.
   */
  line: number | null
  /** Nur bei TEAM_OU gesetzt: auf welches Team sich die Linie bezieht. */
  subject: 'HOME' | 'AWAY' | null
  /**
   * Worin die Linie zählt. Fehlt bei Fußball — dort sind es immer Tore.
   * Siehe `Unit`.
   */
  unit?: Unit
}

/**
 * Stabiler Schlüssel — identisch über alle Buchmacher hinweg.
 *
 * Die Einheit hängt nur dann hinten dran, wenn sie gesetzt ist. Damit bleiben
 * sämtliche Fußball-Schlüssel Zeichen für Zeichen dieselben wie zuvor, während
 * Tennis seine Satz- und Spiele-Märkte sauber auseinanderhält.
 */
export function marketKey(m: CanonicalMarket): string {
  const base = `${m.type}|${m.period}|${m.subject ?? '-'}|${m.line ?? '-'}`
  return m.unit ? `${base}|${m.unit}` : base
}

/** "Spiele" / "Sätze" — leer, wo die Sportart nur eine Einheit kennt. */
const UNIT_LABEL: Record<Unit, string> = {
  GAMES: ' Spiele',
  SETS: ' Sätze',
  POINTS: ' Punkte',
  LEGS: ' Legs',
}

const unitLabel = (u: Unit | undefined): string => (u ? UNIT_LABEL[u] : '')

/** Vorsatz für das 2-Weg-Handicap: "Satz-Handicap −1.5", "Legs-Handicap −3.5". */
const AH_PREFIX: Record<Unit | 'NONE', string> = {
  SETS: 'Satz-',
  GAMES: 'Spiele-',
  POINTS: 'Punkte-',
  LEGS: 'Legs-',
  NONE: '',
}

/** " (1. HZ)" / " (2. Satz)" — leer für die ganze Partie. */
function periodLabel(p: Period): string {
  if (p === 'FT') return ''
  // Ohne diesen Zusatz sind die beiden Varianten in der Liste nicht zu
  // unterscheiden: „Über/Unter 6.5" stünde zweimal da, einmal mit und einmal
  // ohne Verlängerung, und der Nutzer träfe die Wahl blind.
  if (p === 'RT') return ' (reg. Spielzeit)'
  if (p === 'H1') return ' (1. HZ)'
  if (p === 'H2') return ' (2. HZ)'
  if (p.startsWith('Q')) return ` (${p.slice(1)}. Viertel)`
  if (p.startsWith('P')) return ` (${p.slice(1)}. Drittel)`
  return ` (${p.slice(1)}. Satz)`
}

/** Menschenlesbarer Name für die UI. */
export function marketLabel(m: CanonicalMarket, home: string, away: string): string {
  const per = periodLabel(m.period)
  const unit = unitLabel(m.unit)
  switch (m.type) {
    case '1X2':
    case '2WAY':
      return `Siegwette${per}`
    case 'OU':
      return `Über/Unter ${m.line}${unit}${per}`
    case 'BTTS':
      return `Beide Teams treffen${per}`
    case 'EH':
      return `Handicap ${m.line! > 0 ? '+' : ''}${m.line}${per}`
    case 'AH':
      // Die Einheit gehört hier nach vorn: "Satz-Handicap −1.5" liest sich
      // richtig, "Handicap −1.5 Sätze" klingt nach einer Linie in Sätzen, die
      // auf etwas anderes angewendet wird.
      return `${AH_PREFIX[m.unit ?? 'NONE']}Handicap ${m.line! > 0 ? '+' : ''}${m.line}${per}`
    case 'TEAM_OU':
      return `${m.subject === 'HOME' ? home : away} Über/Unter ${m.line}${unit}${per}`
    case 'OE':
      // Nicht "Tore": im Basketball sind es Punkte, im Darts Legs. Die
      // Sportart steht an dieser Stelle nicht zur Verfügung, also bleibt die
      // Beschriftung neutral.
      return `Gesamtzahl gerade/ungerade${per}`
  }
}

export function sideLabel(side: Side, home: string, away: string, m: CanonicalMarket): string {
  const handicap = m.type === 'EH' || m.type === 'AH'
  switch (side) {
    case 'HOME':
      return handicap ? `${home} ${m.line! > 0 ? '+' : ''}${m.line}` : home
    case 'AWAY':
      return handicap ? `${away} ${-m.line! > 0 ? '+' : ''}${-m.line!}` : away
    case 'DRAW':
      return 'Unentschieden'
    case 'OVER':
      return `Über ${m.line}${unitLabel(m.unit)}`
    case 'UNDER':
      return `Unter ${m.line}${unitLabel(m.unit)}`
    case 'YES':
      return 'Ja'
    case 'NO':
      return 'Nein'
    case 'ODD':
      return 'Ungerade'
    case 'EVEN':
      return 'Gerade'
  }
}

export type RawOutcome = {
  market: CanonicalMarket
  side: Side
  /** Dezimalquote */
  odds: number
  /**
   * Beworbene Quote — Quotenboost, „SuperQuoten" und Ähnliches.
   *
   * Es ist **dieselbe** Wette wie der reguläre Markt, nur besser bepreist:
   * bei Betano steht "Endergebnis SuperQuoten" (1,53 / 4,80 / 6,10) neben
   * "Endergebnis" (1,52 / 4,60 / 5,80), jede Seite eine Spur höher. Deshalb
   * gehört sie auf denselben Schlüssel und nicht in einen eigenen.
   *
   * Zwei Dinge hängen daran. Erstens ist eine Dopplung auf einer Seite hier
   * **kein** Zuordnungsfehler, sondern erwartet — der Kollisionsmelder in
   * `server/scan.ts` muss sie in Ruhe lassen. Zweitens sind solche Quoten in
   * der Regel einsatzbegrenzt und nicht für jedes Konto verfügbar; der Fund
   * bekommt deshalb den Hinweis `promo-odds`.
   */
  promo?: boolean
}

/** Ein Event so, wie ein einzelner Buchmacher es sieht. */
export type RawEvent = {
  bookmakerId: string
  /** ID beim Buchmacher — für Deeplinks */
  bookEventId: string
  /** Sportradar-Match-ID: der Join-Key über Buchmacher hinweg */
  sportradarId: number | null
  sport: string
  league: string
  home: string
  away: string
  /** ISO-8601 */
  startTime: string
  isLive: boolean
  /** Direktlink zum Event beim Buchmacher */
  url: string
  outcomes: RawOutcome[]
  fetchedAt: string
}

/** Dasselbe Event, zusammengeführt über mehrere Buchmacher. */
export type MatchedEvent = {
  key: string
  sportradarId: number | null
  sport: string
  league: string
  home: string
  away: string
  startTime: string
  isLive: boolean
  sources: RawEvent[]
}
