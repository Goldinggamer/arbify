/**
 * Kanonisches Datenmodell. Jeder Adapter übersetzt seine Märkte hierhin; nur
 * Outcomes mit gleichem `marketKey` und gleicher `side` werden verglichen.
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
 * Anzeigename je Sportart und zugleich der Wert von `RawEvent.sport`. Der
 * Sportfilter der Oberfläche vergleicht ihn zeichengenau
 * (`src/data/markets.ts`) — Adapter nehmen ihn deshalb immer von hier.
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

/** Rückweg vom Anzeigenamen zur Kennung; `null` für Unbekanntes statt still Fußball. */
export const sportFromLabel = (label: string): Sport | null => SPORT_BY_LABEL.get(label) ?? null

/**
 * Wie `sportFromLabel`, fällt aber auf Fußball zurück: eine unbekannte
 * Sportart würde sonst still von der Tiefenstufe ausgeschlossen.
 */
export const sportOf = (label: string): Sport => sportFromLabel(label) ?? 'FOOTBALL'

/** Einzelsportler statt Mannschaften: Namensabgleich über `server/players.ts` (Nachname plus Initialen). */
export const INDIVIDUAL_SPORTS: ReadonlySet<Sport> = new Set<Sport>(['TENNIS', 'DARTS'])

/** Sportarten, in denen eine Verlängerung die Wertung ändern kann. */
export const OVERTIME_SPORTS: ReadonlySet<Sport> = new Set<Sport>([
  'BASKETBALL',
  'ICEHOCKEY',
  'AMERICANFOOTBALL',
])

/**
 * Spielabschnitt. `FT` ist die Partie, wie sie gewertet wird (im Basketball
 * mit Verlängerung), `RT` nur die reguläre Spielzeit — zwei verschiedene
 * Wetten, die nie gegeneinander laufen dürfen. Dazu Halbzeiten `H`, Viertel
 * `Q`, Drittel `P` und Sätze `S`.
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
 * Worin eine Linie zählt. Nur gesetzt in Sportarten mit mehr als einer
 * Einheit (Tennis: Sätze/Spiele, Volleyball: Sätze/Punkte, Darts:
 * Sätze/Legs) — sonst fielen etwa Satz- und Spiele-Handicap auf einen Schlüssel.
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

/** Seiten eines vollständigen Markts. Nur vollständige Märkte werden gerechnet — ein fehlendes Bein sähe sonst profitabel aus. */
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
  /** Worin die Linie zählt — siehe `Unit`. */
  unit?: Unit
}

/** Stabiler Schlüssel über alle Buchmacher; die Einheit nur, wenn gesetzt. */
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
      // Einheit vorn: "Satz-Handicap −1.5".
      return `${AH_PREFIX[m.unit ?? 'NONE']}Handicap ${m.line! > 0 ? '+' : ''}${m.line}${per}`
    case 'TEAM_OU':
      return `${m.subject === 'HOME' ? home : away} Über/Unter ${m.line}${unit}${per}`
    case 'OE':
      // Neutral, weil die Sportart hier unbekannt ist (Tore, Punkte, Legs).
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
   * Beworbene Quote („SuperQuoten“) — dieselbe Wette, derselbe Schlüssel.
   * Eine Dopplung auf der Seite ist dann keine Kollision; der Fund bekommt
   * `promo-odds`, weil solche Quoten meist einsatzbegrenzt sind.
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
