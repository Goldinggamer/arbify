import { marketKey, marketLabel, OVERTIME_SPORTS, SIDES, sideLabel, sportFromLabel } from './types.ts'
import { noteCollision } from './diagnostics.ts'
import type { CanonicalMarket, MatchedEvent, Side } from './types.ts'

/**
 * Arbitrage-Suche über zusammengeführte Partien. Begründung der Schranken:
 * docs/schutzschranken.md.
 */

/** Eine Quote ohne Einsatzgrenze — Limits liefert kein Anbieter öffentlich. */
type ScanQuote = {
  bookmakerId: string
  odds: number
}

type ScanOutcome = {
  label: string
  best: ScanQuote
  all: ScanQuote[]
}

export type ScanOpportunity = {
  id: string
  sport: string
  league: string
  home: string
  away: string
  startTime: string
  isLive: boolean
  /** Anzeigename, z.B. "Über/Unter 2.5" */
  market: string
  /** Markt-Familie für den Filter, z.B. "OU" — siehe MarketType */
  marketFamily: string
  outcomes: ScanOutcome[]
  warnings: string[]
  /** Rendite in Prozent vom Gesamteinsatz, vor Rundung und Limits */
  arbPercent: number
  /** Direktlinks je Buchmacher */
  links: Record<string, string>
  updatedAt: string
}

const STALE_MS = 60_000

/** Implizite Summe darunter (≈ 33 % Rendite): praktisch immer ein Datenfehler — verwerfen und zählen. */
const MIN_PLAUSIBLE_IMPLIED = 0.75

/**
 * Darunter (≈ 11 % Rendite) wird ein Fund angezeigt, aber als
 * `implausible-high` markiert: eine nachhinkende Quote und ein
 * Zuordnungsfehler sehen gleich aus.
 */
const SUSPICIOUS_IMPLIED = 0.9

/** Ein Bein darüber trägt kaum Einsatz, aber das ganze Ausführungsrisiko. */
const MAX_LEG_ODDS = 30

/** Weniger Vorlauf bis zum Anpfiff wird markiert (`short-notice`), nicht verworfen. */
const MIN_LEAD_MINUTES = 30

/** Marktfamilien, die über Buchmacher hinweg verglichen werden. */
const COMPARABLE: ReadonlySet<string> = new Set(['1X2', '2WAY', 'OU', 'BTTS', 'EH', 'AH', 'OE', 'TEAM_OU'])

/**
 * Ganzzahlige Linie ("Über/Unter 2,0"): fällt genau die Linie, kommen beide
 * Einsätze zurück. Kein Verlust, aber die Rendite entfällt — deshalb
 * Warnung (`push-line`) statt Filter.
 */
const isWholeLine = (line: number | null): boolean => line !== null && Math.abs(line * 2) % 2 === 0

/**
 * Linienmärkte über die ganze Partie in Sportarten mit Verlängerung: die
 * Adapter lesen „ohne Angabe“ als „mit Verlängerung“. Das ist eine Regel über
 * Beschriftungen, keine Garantie — der Nutzer soll es prüfen (`overtime`).
 */
function needsOvertimeCheck(sportLabel: string, m: CanonicalMarket): boolean {
  if (m.period !== 'FT') return false
  if (m.type !== 'OU' && m.type !== 'AH' && m.type !== 'TEAM_OU') return false
  const sport = sportFromLabel(sportLabel)
  return sport !== null && OVERTIME_SPORTS.has(sport)
}

let rejected: { event: string; market: string; impliedPercent: number; legs: string }[] = []

export const rejectedReport = () => rejected.slice(0, 40)

type Quote = {
  bookmakerId: string
  odds: number
  fetchedAt: string
  /** Beworbene Quote (Quotenboost) — siehe `RawOutcome.promo`. */
  promo?: boolean
}

const toScanQuote = (q: Quote): ScanQuote => ({ bookmakerId: q.bookmakerId, odds: q.odds })

/** Knappste spielbare Vergleiche — Beleg, dass Matching und Zuordnung greifen. */
export type MarginRow = {
  event: string
  /** Sportart, damit die Oberfläche die Liste zum Sportfilter passend hält */
  sport: string
  league: string
  market: string
  impliedPercent: number
  legs: { label: string; odds: number; bookmakerId: string }[]
}

/**
 * „Hitze“ einer Partie: niedrigste implizite Summe über alle vollständigen
 * Märkte. Danach wählt der schnelle Takt aus, was nachgeladen wird.
 */
export function eventHeat(ev: MatchedEvent): number {
  if (ev.sources.length < 2) return Infinity

  const byMarket = new Map<string, Map<Side, number>>()
  for (const src of ev.sources) {
    for (const o of src.outcomes) {
      const key = marketKey(o.market)
      const sides = byMarket.get(key) ?? new Map<Side, number>()
      sides.set(o.side, Math.max(sides.get(o.side) ?? 0, o.odds))
      byMarket.set(key, sides)
    }
  }

  let best = Infinity
  for (const [key, sides] of byMarket) {
    const type = key.split('|')[0] as keyof typeof SIDES
    const required = SIDES[type]
    if (!required || required.some((s) => !sides.get(s))) continue
    const implied = required.reduce((sum, s) => sum + 1 / sides.get(s)!, 0)
    if (implied < best) best = implied
  }
  return best
}

export function scanForArbitrage(
  events: MatchedEvent[],
  minPercent = 0,
): { opportunities: ScanOpportunity[]; margins: MarginRow[] } {
  const found: ScanOpportunity[] = []
  const margins: MarginRow[] = []
  rejected = []

  for (const ev of events) {
    if (ev.sources.length < 2) continue

    // Laufende Spiele werden nicht bewertet (docs/schutzschranken.md#warum-kein-live).
    if (ev.isLive) continue

    // marketKey → side → Quoten aller Buchmacher
    const byMarket = new Map<string, { market: CanonicalMarket; sides: Map<Side, Quote[]> }>()

    for (const src of ev.sources) {
      for (const o of src.outcomes) {
        const key = marketKey(o.market)
        let entry = byMarket.get(key)
        if (!entry) {
          entry = { market: o.market, sides: new Map() }
          byMarket.set(key, entry)
        }
        const quotes = entry.sides.get(o.side) ?? []
        quotes.push({
          bookmakerId: src.bookmakerId,
          odds: o.odds,
          fetchedAt: src.fetchedAt,
          promo: o.promo,
        })
        entry.sides.set(o.side, quotes)
      }
    }

    for (const [key, { market, sides }] of byMarket) {
      if (!COMPARABLE.has(market.type)) continue
      const required = SIDES[market.type]
      if (required.some((s) => !sides.get(s)?.length)) continue

      // Mehrere Quoten eines Buchs auf derselben Seite: entweder ein
      // Quotenboost neben der normalen Quote (erwartet) oder zwei verschiedene
      // Märkte auf einem Schlüssel (Zuordnungsfehler). Letzteres wird gezählt
      // und markiert, gerechnet wird trotzdem mit der besten Quote — ein
      // verschluckter echter Fund fiele nie auf, ein falscher am Wettschein schon.
      let collided = false
      let boosted = false
      const best = required.map((side) => {
        const quotes = sides.get(side)!
        const perBook = new Map<string, Quote[]>()
        for (const q of quotes) {
          const list = perBook.get(q.bookmakerId)
          if (list) list.push(q)
          else perBook.set(q.bookmakerId, [q])
        }
        for (const [book, list] of perBook) {
          if (list.length > 1 && !list.some((q) => q.promo)) {
            noteCollision(book, key, `${ev.sport}: ${ev.home} — ${ev.away}`)
            collided = true
          }
        }

        const quote = quotes.reduce((a, b) => (b.odds > a.odds ? b : a))
        if (quote.promo) boosted = true
        return { side, quote, all: quotes }
      })

      // Alle Beine beim selben Buch sind keine Arbitrage.
      if (new Set(best.map((b) => b.quote.bookmakerId)).size < 2) continue

      const implied = best.reduce((s, b) => s + 1 / b.quote.odds, 0)

      // Vergleichsliste: nur spielbare Quoten und nur plausible Summen —
      // Ausreißer gehören in die Treffer- oder Ablehnungsliste, nicht hierher.
      const playable =
        best.every((b) => b.quote.odds >= 1.1 && b.quote.odds <= 15) &&
        implied >= SUSPICIOUS_IMPLIED
      if (playable) {
        margins.push({
          event: `${ev.home} vs ${ev.away}`,
          sport: ev.sport,
          league: ev.league,
          market: marketLabel(market, ev.home, ev.away),
          impliedPercent: implied * 100,
          legs: best.map((b) => ({
            label: sideLabel(b.side, ev.home, ev.away, market),
            odds: b.quote.odds,
            bookmakerId: b.quote.bookmakerId,
          })),
        })
      }

      if (!(implied < 1)) continue

      if (best.some((b) => b.quote.odds > MAX_LEG_ODDS)) {
        rejected.push({
          event: `${ev.home} vs ${ev.away}`,
          market: marketLabel(market, ev.home, ev.away),
          impliedPercent: implied * 100,
          legs: `Bein über Quote ${MAX_LEG_ODDS}: ` + best.map((b) => `${b.side} ${b.quote.odds}@${b.quote.bookmakerId}`).join(' | '),
        })
        continue
      }

      if (implied < MIN_PLAUSIBLE_IMPLIED) {
        rejected.push({
          event: `${ev.home} vs ${ev.away}`,
          market: marketLabel(market, ev.home, ev.away),
          impliedPercent: implied * 100,
          legs: best.map((b) => `${b.side} ${b.quote.odds}@${b.quote.bookmakerId}`).join(' | '),
        })
        continue
      }

      const arbPercent = (1 / implied - 1) * 100
      if (arbPercent < minPercent) continue

      const now = Date.now()
      const warnings: string[] = []
      const leadMinutes = (new Date(ev.startTime).getTime() - now) / 60_000
      if (leadMinutes < MIN_LEAD_MINUTES) warnings.push('short-notice')
      if (best.some((b) => now - new Date(b.quote.fetchedAt).getTime() > STALE_MS))
        warnings.push('stale-odds')
      if (implied < SUSPICIOUS_IMPLIED) warnings.push('implausible-high')
      if ((market.type === 'OU' || market.type === 'TEAM_OU') && isWholeLine(market.line))
        warnings.push('push-line')
      if (needsOvertimeCheck(ev.sport, market)) warnings.push('overtime')
      if (collided) warnings.push('market-collision')
      // Beworbene Quoten sind meist einsatzbegrenzt und nicht für jedes Konto da.
      if (boosted) warnings.push('promo-odds')

      const links: Record<string, string> = {}
      for (const src of ev.sources) links[src.bookmakerId] = src.url

      found.push({
        id: `${ev.key}::${key}`,
        sport: ev.sport,
        league: ev.league,
        home: ev.home,
        away: ev.away,
        startTime: ev.startTime,
        isLive: ev.isLive,
        market: marketLabel(market, ev.home, ev.away),
        marketFamily: market.type,
        outcomes: best.map((b) => ({
          label: sideLabel(b.side, ev.home, ev.away, market),
          best: toScanQuote(b.quote),
          all: b.all.map(toScanQuote).sort((x, y) => y.odds - x.odds),
        })),
        warnings,
        arbPercent,
        links,
        updatedAt: new Date().toISOString(),
      })
    }
  }

  return {
    opportunities: found.sort((a, b) => b.arbPercent - a.arbPercent),
    margins: margins.sort((a, b) => a.impliedPercent - b.impliedPercent).slice(0, 40),
  }
}
