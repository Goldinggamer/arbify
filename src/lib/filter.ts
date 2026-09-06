import type { Filters, Opportunity, Settings, SortKey } from '../types'
// Endung ausgeschrieben wie überall sonst im Projekt: Vite kommt mit beidem
// zurecht, `node --test` nur damit — und ohne sie ließe sich diese Datei nicht
// testen.
import { arbFor, arbPercentOf, taxedBooksOf } from './arbitrage.ts'
import { DEFAULT_WINDOW_HOURS, hoursToMs } from './window.ts'

/**
 * Reduziert eine Wettmöglichkeit auf die ausgewählten Buchmacher und wählt
 * pro Outcome die dort beste Quote neu aus. Gibt `null` zurück, wenn dadurch
 * keine Arbitrage mehr übrig bleibt.
 */
function restrictToBookmakers(opp: Opportunity, allowed: Set<string>): Opportunity | null {
  const outcomes = opp.outcomes.map((o) => {
    const candidates = o.all.filter((b) => allowed.has(b.bookmakerId))
    if (!candidates.length) return null
    const best = candidates.reduce((a, b) => (b.odds > a.odds ? b : a))
    return { ...o, best, all: candidates }
  })
  if (outcomes.some((o) => o === null)) return null

  const next: Opportunity = { ...opp, outcomes: outcomes as Opportunity['outcomes'] }

  // Mindestens zwei verschiedene Buchmacher — nicht einer je Bein.
  // Eine Dreiwege-Wette mit zwei Beinen bei Tipico und einem bei
  // Sportwetten.de ist eine völlig gültige Arbitrage; man platziert eben zwei
  // Wetten beim selben Anbieter. Die frühere Regel verlangte einen eigenen
  // Buchmacher je Bein und hat solche Funde stillschweigend unterschlagen —
  // das Backend hatte sie korrekt gemeldet, die Liste blieb trotzdem leer.
  const books = new Set(next.outcomes.map((o) => o.best.bookmakerId))
  if (books.size < 2) return null
  return arbPercentOf(next) > 0 ? next : null
}

export function applyFilters(
  all: Opportunity[],
  filters: Filters,
  settings: Settings,
  sort: SortKey,
  /**
   * Anzeigefenster in Millisekunden.
   *
   * Kommt vom Aufrufer, weil der Server es kennt und die Oberfläche es von
   * dort meldet bekommt. Hier stand vorher eine eigene Konstante über sieben
   * Tage — war das Backend-Fenster größer, filterte die Oberfläche die
   * zusätzlichen Partien stillschweigend weg, und für diesen Zeitfilter gibt
   * es keine Bedienfläche, an der man das gesehen hätte.
   */
  windowMs: number = hoursToMs(DEFAULT_WINDOW_HOURS),
): Opportunity[] {
  const allowed = new Set(filters.bookmakers)
  const now = Date.now()
  const q = filters.search.trim().toLowerCase()

  const list: Opportunity[] = []

  for (const raw of all) {
    // Nur Vorspiel: laufende Partien sind bewusst kein Produkt mehr (siehe
    // server/scan.ts). Anstoß muss in der Zukunft und im Fenster liegen.
    const start = new Date(raw.startTime).getTime()
    if (raw.isLive || start < now || start > now + windowMs) continue

    if (!filters.sports.includes(raw.sport)) continue
    if (!filters.markets.includes(raw.marketFamily)) continue

    if (q) {
      const hay = `${raw.home} ${raw.away} ${raw.league} ${raw.market} ${raw.sport}`.toLowerCase()
      if (!hay.includes(q)) continue
    }

    const restricted = restrictToBookmakers(raw, allowed)
    if (!restricted) continue

    if (restricted.outcomes.some((o) => o.best.odds < filters.minOdds || o.best.odds > filters.maxOdds))
      continue

    // Die Steuer-Warnung entsteht erst hier: welche Anbieter die Beine
    // tragen, steht erst fest, nachdem auf die ausgewählten Bücher
    // eingeschränkt wurde.
    const taxed = taxedBooksOf(restricted)
    const opp: Opportunity =
      taxed.length && !restricted.warnings.includes('betting-tax')
        ? { ...restricted, warnings: [...restricted.warnings, 'betting-tax'] }
        : restricted

    if (opp.warnings.some((w) => filters.warnings.includes(w))) continue

    const p = arbPercentOf(opp)
    if (p < filters.minPercentage || p > filters.maxPercentage) continue

    list.push(opp)
  }

  const profit = (o: Opportunity) => arbFor(o, settings).guaranteedProfit
  const time = (o: Opportunity) => new Date(o.startTime).getTime()
  const percent = (o: Opportunity) => arbPercentOf(o)

  return list.sort((a, b) => {
    switch (sort) {
      case 'percentage-asc':
        return percent(a) - percent(b)
      case 'profit-desc':
        return profit(b) - profit(a)
      case 'time-asc':
        return time(a) - time(b)
      case 'time-desc':
        return time(b) - time(a)
      default:
        return percent(b) - percent(a)
    }
  })
}

export function countActiveFilters(filters: Filters, defaults: Filters): number {
  let n = 0
  if (filters.bookmakers.length !== defaults.bookmakers.length) n++
  if (filters.sports.length !== defaults.sports.length) n++
  if (filters.minOdds !== defaults.minOdds || filters.maxOdds !== defaults.maxOdds) n++
  if (filters.minPercentage !== defaults.minPercentage || filters.maxPercentage !== defaults.maxPercentage) n++
  if (filters.markets.length !== defaults.markets.length) n++
  if (filters.warnings.length) n++
  return n
}
