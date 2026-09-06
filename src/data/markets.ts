/**
 * Sportarten und Markt-Familien.
 *
 * Der Filter arbeitet auf Familien, nicht auf Anzeigenamen: "Über/Unter 2.5"
 * und "Über/Unter 3.5" sind zwei Märkte, aber eine Filteroption. Die IDs sind
 * dieselben wie im Backend (server/types.ts, MarketType).
 */

/**
 * Die IDs sind die Zeichenketten, die das Backend in `RawEvent.sport` schreibt
 * — nicht bloß Beschriftungen. Weicht eine davon ab, filtert die Oberfläche
 * eine ganze Sportart weg, ohne dass irgendwo ein Fehler auftaucht.
 */
export const SPORTS = [
  { id: 'Fußball', label: 'Fußball' },
  { id: 'Tennis', label: 'Tennis' },
  { id: 'Basketball', label: 'Basketball' },
  { id: 'Eishockey', label: 'Eishockey' },
  { id: 'Handball', label: 'Handball' },
  { id: 'Volleyball', label: 'Volleyball' },
  { id: 'American Football', label: 'American Football' },
  { id: 'Darts', label: 'Darts' },
] as const

export const ALL_SPORT_IDS: string[] = SPORTS.map((s) => s.id)

/**
 * Jede Familie gehört zu bestimmten Sportarten.
 *
 * Das ist nicht nur Aufräumen: ohne die Zuordnung stünden im Marktfilter
 * dauerhaft Optionen, die für die gewählte Sportart nie ein Ergebnis liefern
 * können.
 *
 * Die Zuordnung folgt einer Regel, nicht dem Gefühl — **kann es ein
 * Unentschieden geben?**
 *
 *   dreiseitig (1X2, EH)  nur wo ein Remis möglich ist. Im Basketball,
 *                         Eishockey und American Football ist es das
 *                         ausschließlich in der regulären Spielzeit; genau
 *                         darum führen die Bücher dort beides nebeneinander.
 *                         Tennis, Volleyball und Darts spielen immer aus.
 *   zweiseitig (2WAY, AH) überall, wo eine Partie zwingend einen Sieger hat.
 *                         Fußball fehlt hier, weil kein angebundener Anbieter
 *                         asiatische Handicaps für Fußball liefert.
 *
 * Zu großzügig kostet eine tote Auswahlbox, zu knapp verbirgt echte Wetten —
 * im Zweifel also lieber aufnehmen.
 */
const ALL: string[] = SPORTS.map((s) => s.id)

/** Sportarten mit möglichem Unentschieden in der gewerteten Spielzeit. */
const DRAWABLE = ['Fußball', 'Handball', 'Basketball', 'Eishockey', 'American Football']

/** Sportarten, die immer einen Sieger ergeben. */
const DECIDED = [
  'Tennis', 'Basketball', 'Eishockey', 'Handball', 'Volleyball', 'American Football', 'Darts',
]

export const MARKET_FAMILIES = [
  { id: '1X2', label: 'Siegwette (1X2)', sports: DRAWABLE },
  // Tennis kennt kein Unentschieden — Matchsieger und Satzsieger sind
  // zweiseitig und damit eine eigene Familie. Im Basketball und Eishockey
  // steht die 2-Weg-Siegwette daneben: sie schließt die Verlängerung ein.
  { id: '2WAY', label: 'Siegwette (2-Weg)', sports: DECIDED },
  { id: 'OU', label: 'Über/Unter', sports: ALL },
  // Eishockey führt den Markt ebenfalls — gemessen bei Kambi, dort sogar in
  // beiden Spielzeit-Varianten ("Both Teams To Score - Regular Time" neben
  // "… - Including Overtime and Penalty Shootout").
  { id: 'BTTS', label: 'Beide Teams treffen', sports: ['Fußball', 'Eishockey'] },
  { id: 'EH', label: 'Handicap (3-Weg)', sports: DRAWABLE },
  { id: 'AH', label: 'Handicap (2-Weg)', sports: DECIDED },
  { id: 'TEAM_OU', label: 'Team/Spieler Über/Unter', sports: ALL },
  { id: 'OE', label: 'Gerade/Ungerade', sports: ALL },
] as const

export const ALL_MARKET_IDS: string[] = MARKET_FAMILIES.map((m) => m.id)

/** Die Familien, die bei den gewählten Sportarten überhaupt vorkommen können. */
export function familiesForSports(sports: string[]) {
  return MARKET_FAMILIES.filter((m) => m.sports.some((s) => sports.includes(s)))
}
