import { BOOKMAKERS } from './bookmakers'
import type { BetWarningId, BookOdds, Opportunity, Outcome } from '../types'

/** Kleiner deterministischer RNG, damit die Demo-Daten reproduzierbar sind. */
function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Fixture = { sport: string; league: string; home: string; away: string }

const FIXTURES: Fixture[] = [
  { sport: 'Fußball', league: 'Deutschland — Bundesliga', home: 'Bayern München', away: 'Borussia Dortmund' },
  { sport: 'Fußball', league: 'Deutschland — Bundesliga', home: 'RB Leipzig', away: 'Bayer Leverkusen' },
  { sport: 'Fußball', league: 'Deutschland — Bundesliga', home: 'VfB Stuttgart', away: 'Eintracht Frankfurt' },
  { sport: 'Fußball', league: 'Deutschland — Bundesliga', home: 'SC Freiburg', away: 'Werder Bremen' },
  { sport: 'Fußball', league: 'Deutschland — 2. Bundesliga', home: 'Hamburger SV', away: 'FC Schalke 04' },
  { sport: 'Fußball', league: 'Deutschland — 2. Bundesliga', home: 'Hertha BSC', away: 'Fortuna Düsseldorf' },
  { sport: 'Fußball', league: 'England — Premier League', home: 'Liverpool FC', away: 'Newcastle United' },
  { sport: 'Fußball', league: 'England — Premier League', home: 'Arsenal FC', away: 'Manchester City' },
  { sport: 'Fußball', league: 'Spanien — La Liga', home: 'Real Madrid', away: 'Atlético Madrid' },
  { sport: 'Fußball', league: 'Italien — Serie A', home: 'Inter Mailand', away: 'SSC Neapel' },
  { sport: 'Fußball', league: 'UEFA — Champions League', home: 'Paris Saint-Germain', away: 'FC Porto' },
  { sport: 'Fußball', league: 'UEFA — Europa League', home: 'AS Rom', away: 'Ajax Amsterdam' },
  { sport: 'Basketball', league: 'Deutschland — BBL', home: 'Alba Berlin', away: 'Bayern München Basketball' },
  { sport: 'Basketball', league: 'EuroLeague', home: 'Olympiakos Piräus', away: 'Real Madrid Baloncesto' },
  { sport: 'Basketball', league: 'USA — NBA', home: 'Boston Celtics', away: 'Denver Nuggets' },
  { sport: 'Tennis', league: 'ATP — Hamburg', home: 'A. Zverev', away: 'C. Alcaraz' },
  { sport: 'Tennis', league: 'WTA — Berlin', home: 'A. Sabalenka', away: 'I. Swiatek' },
  { sport: 'Eishockey', league: 'Deutschland — DEL', home: 'Eisbären Berlin', away: 'Adler Mannheim' },
  { sport: 'Eishockey', league: 'USA — NHL', home: 'Colorado Avalanche', away: 'Vegas Golden Knights' },
  { sport: 'Handball', league: 'Deutschland — HBL', home: 'THW Kiel', away: 'SG Flensburg-Handewitt' },
]

type MarketTemplate = {
  market: string
  /** Familie für den Filter — muss zu data/markets.ts passen */
  family: string
  sports: string[]
  labels: (f: Fixture, rng: () => number) => string[]
}

const line = (rng: () => number, options: number[]) => options[Math.floor(rng() * options.length)]

const MARKET_TEMPLATES: MarketTemplate[] = [
  { market: 'Siegwette (1X2)', family: '1X2', sports: ['Fußball', 'Handball'], labels: (f) => [f.home, 'Unentschieden', f.away] },
  { market: 'Erste Halbzeit 1X2', family: '1X2', sports: ['Fußball'], labels: (f) => [f.home, 'Unentschieden', f.away] },
  { market: 'Moneyline', family: '1X2', sports: ['Basketball', 'Tennis', 'Eishockey'], labels: (f) => [f.home, f.away] },
  {
    market: 'Über/Unter Tore',
    family: 'OU',
    sports: ['Fußball', 'Eishockey'],
    labels: (_f, rng) => {
      const l = line(rng, [1.5, 2.5, 3, 3.5, 4.5])
      return [`Über ${l}`, `Unter ${l}`]
    },
  },
  {
    market: 'Über/Unter Punkte',
    family: 'OU',
    sports: ['Basketball'],
    labels: (_f, rng) => {
      const l = line(rng, [206.5, 213.5, 218.5, 224.5])
      return [`Über ${l}`, `Unter ${l}`]
    },
  },
  { market: 'Beide Teams treffen', family: 'BTTS', sports: ['Fußball'], labels: () => ['Ja', 'Nein'] },
  {
    market: 'Handicap',
    family: 'EH',
    sports: ['Fußball', 'Handball'],
    labels: (f, rng) => {
      const l = line(rng, [1, 1.5, 2])
      return [`${f.home} −${l}`, `${f.away} +${l}`]
    },
  },
  {
    market: 'Punkte-Handicap',
    family: 'EH',
    sports: ['Basketball'],
    labels: (f, rng) => {
      const l = line(rng, [3.5, 5.5, 7.5, 10.5])
      return [`${f.home} −${l}`, `${f.away} +${l}`]
    },
  },
  {
    market: 'Asian Handicap',
    family: 'EH',
    sports: ['Fußball'],
    labels: (f, rng) => {
      const l = line(rng, [0.25, 0.5, 0.75, 1])
      return [`${f.home} −${l}`, `${f.away} +${l}`]
    },
  },
  {
    market: 'Über/Unter Ecken',
    family: 'OU',
    sports: ['Fußball'],
    labels: (_f, rng) => {
      const l = line(rng, [8.5, 9.5, 10.5, 11.5])
      return [`Über ${l} Ecken`, `Unter ${l} Ecken`]
    },
  },
  {
    market: 'Über/Unter Karten',
    family: 'OU',
    sports: ['Fußball'],
    labels: (_f, rng) => {
      const l = line(rng, [3.5, 4.5, 5.5])
      return [`Über ${l} Karten`, `Unter ${l} Karten`]
    },
  },
]

const ALL_WARNINGS: BetWarningId[] = [
  'betting-tax',
  'stale-odds',
  'related-contingency',
  'promo-odds',
  'short-notice',
  'account-risk',
]

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]
}

function shuffle<T>(rng: () => number, arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Erzeugt eine Wettmöglichkeit mit einer vorgegebenen Ziel-Arbitrage.
 *
 * Vorgehen: faire Wahrscheinlichkeiten p_i (Summe 1) ziehen, daraus Bestquoten
 * so ableiten, dass Σ 1/quote = 1/(1+ziel) ergibt. Die restlichen Buchmacher
 * bekommen schlechtere Quoten über einen individuellen Margen-Aufschlag.
 */
function makeOpportunity(rng: () => number, id: number, targetArb: number, isLive: boolean): Opportunity {
  const fixture = pick(rng, FIXTURES)
  const templates = MARKET_TEMPLATES.filter((t) => t.sports.includes(fixture.sport))
  const template = pick(rng, templates.length ? templates : MARKET_TEMPLATES)
  const labels = template.labels(fixture, rng)
  const n = labels.length

  // Faire Wahrscheinlichkeiten
  const raw = Array.from({ length: n }, () => 0.6 + rng() * 1.4)
  const sum = raw.reduce((a, b) => a + b, 0)
  const probs = raw.map((r) => r / sum)

  const impliedTarget = 1 / (1 + targetArb / 100)
  const bestOdds = probs.map((p) => 1 / (p * impliedTarget))

  // Buchmacher-Auswahl: pro Outcome ein anderer "Gewinner"
  const books = shuffle(rng, BOOKMAKERS.map((b) => b.id))
  const bestBooks = books.slice(0, n)
  const field = books.slice(n, n + 5 + Math.floor(rng() * 4))

  const outcomes: Outcome[] = labels.map((label, i) => {
    const best: BookOdds = {
      bookmakerId: bestBooks[i],
      odds: Math.round(bestOdds[i] * 100) / 100,
    }
    const others: BookOdds[] = field.map((bookmakerId) => {
      // 1 % – 9 % schlechtere Quote als die Bestquote
      const worse = 1 - (0.01 + rng() * 0.08)
      return {
        bookmakerId,
        odds: Math.round(bestOdds[i] * worse * 100) / 100,
      }
    })
    return { label, best, all: [best, ...others].sort((a, b) => b.odds - a.odds) }
  })

  const warnings = shuffle(rng, ALL_WARNINGS).slice(0, rng() < 0.55 ? 0 : 1 + Math.floor(rng() * 2))

  const now = Date.now()
  const startTime = isLive
    ? new Date(now - Math.floor(rng() * 60) * 60_000).toISOString()
    : new Date(now + (10 + Math.floor(rng() * 22 * 60)) * 60_000).toISOString()

  return {
    id: `opp-${id}`,
    sport: fixture.sport,
    league: fixture.league,
    home: fixture.home,
    away: fixture.away,
    startTime,
    isLive,
    market: template.market,
    marketFamily: template.family,
    outcomes,
    warnings,
  }
}

export function generateOpportunities(count = 40, seed = 20260724): Opportunity[] {
  const rng = mulberry32(seed)
  const list: Opportunity[] = []
  for (let i = 0; i < count; i++) {
    // Verteilung: viele kleine Arbs, wenige große
    const r = rng()
    const targetArb = r < 0.55 ? 0.3 + rng() * 1.7 : r < 0.88 ? 2 + rng() * 2 : 4 + rng() * 4
    // Nur Vorspiel — laufende Partien sind bewusst kein Produkt.
    list.push(makeOpportunity(rng, i + 1, targetArb, false))
  }
  return list
}
