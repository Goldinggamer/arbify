export type Bookmaker = {
  id: string
  name: string
  short: string
  color: string
  fg?: string
  licensedSince?: string
  url: string
  /** Ein-Klick-Wette / Deeplink direkt in den Wettschein möglich */
  oneClick?: boolean
  /** Für Live-Wetten geeignet (schnelle Odds-Updates) */
  bestForLive?: boolean
  popular?: boolean
}

export type BetWarningId =
  | 'betting-tax'
  | 'implausible-high'
  | 'stale-odds'
  | 'related-contingency'
  | 'promo-odds'
  | 'short-notice'
  | 'account-risk'
  | 'push-line'
  | 'overtime'
  | 'market-collision'

export type BetWarning = {
  id: BetWarningId
  label: string
  detail: string
}

export type BookOdds = {
  bookmakerId: string
  odds: number
}

export type Outcome = {
  /** z.B. "Over 3", "Liverpool FC", "Unentschieden" */
  label: string
  /** Der beste Buchmacher für dieses Outcome (Teil der Arb) */
  best: BookOdds
  /** Alle bekannten Quoten für dieses Outcome, für die Odds-Tabelle */
  all: BookOdds[]
}

export type Opportunity = {
  id: string
  sport: string
  league: string
  home: string
  away: string
  /** ISO Startzeit */
  startTime: string
  isLive: boolean
  /** Anzeigename des Markts, z.B. "Über/Unter 2.5" */
  market: string
  /** Familie für den Filter, z.B. "OU" — siehe data/markets.ts */
  marketFamily: string
  outcomes: Outcome[]
  warnings: BetWarningId[]
  /** Direktlinks je Buchmacher, vom Backend geliefert */
  links?: Record<string, string>
}

export type SortKey =
  | 'percentage-desc'
  | 'percentage-asc'
  | 'profit-desc'
  | 'time-asc'
  | 'time-desc'

export type Filters = {
  bookmakers: string[]
  /** Sportarten, wie sie das Backend schreibt — siehe data/markets.ts */
  sports: string[]
  minOdds: number
  maxOdds: number
  minPercentage: number
  maxPercentage: number
  markets: string[]
  warnings: BetWarningId[]
  search: string
}

/**
 * Zugang zum Meldedienst — getrennt von `Settings`, weil es Geheimnisse sind.
 * Liegt nur lokal (Browser, `.arbify-alerts.json`), nie im Repository.
 */
export type PushConfig = {
  /** `off` heißt: kein Versand, auch wenn Zugangsdaten hinterlegt sind. */
  service: 'off' | 'ntfy' | 'pushover' | 'webhook'
  /** Zufallszeichenkette, kein Wort — sie ist das Passwort des Kanals. */
  ntfyTopic: string
  /** Leer heißt `https://ntfy.sh`. */
  ntfyServer: string
  /** Nur nötig für zugriffsgeschützte Themen auf einem eigenen Server. */
  ntfyToken: string
  pushoverToken: string
  pushoverUser: string
  webhookUrl: string
}

export const EMPTY_PUSH_CONFIG: PushConfig = {
  service: 'off',
  ntfyTopic: '',
  ntfyServer: '',
  ntfyToken: '',
  pushoverToken: '',
  pushoverUser: '',
  webhookUrl: '',
}

export type Settings = {
  bankroll: number
  /** Einsätze auf dieses Vielfache runden (0 = keine Rundung) */
  roundTo: number
  currency: '€' | '$'
  /** Ab dieser Rendite wird gemeldet; 0 schaltet die Meldungen ab. */
  alertMinPercent: number
  /** Kurzer Zweiklang im Browser */
  alertSound: boolean
  /** Systemmeldung — auf macOS oben rechts */
  alertDesktop: boolean
  /** Meldung aufs Telefon, verschickt vom Server; eingerichtet im Reiter „Telefon“. */
  alertPush: boolean
  /** Nachtruhe: in diesen Stunden geht nichts aufs Telefon, und nachgeholt wird nichts. */
  alertQuiet: boolean
  /** Beginn der Nachtruhe, volle Stunde 0–23 */
  quietFrom: number
  /** Ende der Nachtruhe, volle Stunde 0–23 */
  quietTo: number
}
