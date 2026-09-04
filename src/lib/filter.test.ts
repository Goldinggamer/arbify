import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFilters } from './filter.ts'
import { ALL_SPORT_IDS, ALL_MARKET_IDS } from '../data/markets.ts'
import type { Filters, Opportunity, Settings } from '../types.ts'

/**
 * Der Sportfilter ist der einzige Weg, Fußball und Tennis auseinanderzuhalten
 * — die Suche über Freitext taugt dafür nicht, weil Ligennamen und
 * Spielernamen sich nicht zuverlässig nach Sportart unterscheiden.
 */

const SETTINGS: Settings = { bankroll: 500, roundTo: 1, currency: '€', alertMinPercent: 3, alertSound: false, alertDesktop: false, alertPush: false, alertQuiet: false, quietFrom: 23, quietTo: 8 }

const FILTERS: Filters = {
  bookmakers: ['a', 'b'],
  sports: [...ALL_SPORT_IDS],
  minOdds: 1,
  maxOdds: 100,
  minPercentage: 0,
  maxPercentage: 100,
  markets: [...ALL_MARKET_IDS],
  warnings: [],
  search: '',
}

/** Eine Wettmöglichkeit mit echter Arbitrage, damit sie die übrigen Filter passiert. */
function opp(over: Partial<Opportunity>): Opportunity {
  return {
    id: 'x',
    sport: 'Fußball',
    league: 'Testliga',
    home: 'Alpha',
    away: 'Beta',
    startTime: new Date(Date.now() + 4 * 3600_000).toISOString(),
    isLive: false,
    market: 'Über/Unter 2.5',
    marketFamily: 'OU',
    outcomes: [
      { label: 'Über 2.5', best: { bookmakerId: 'a', odds: 2.1 }, all: [{ bookmakerId: 'a', odds: 2.1 }] },
      { label: 'Unter 2.5', best: { bookmakerId: 'b', odds: 2.1 }, all: [{ bookmakerId: 'b', odds: 2.1 }] },
    ],
    warnings: [],
    ...over,
  }
}

const ids = (list: Opportunity[]) => list.map((o) => o.id).sort()

test('ohne Einschränkung kommen beide Sportarten durch', () => {
  const all = [opp({ id: 'f', sport: 'Fußball' }), opp({ id: 't', sport: 'Tennis', marketFamily: '2WAY' })]
  assert.deepEqual(ids(applyFilters(all, FILTERS, SETTINGS, 'percentage-desc')), ['f', 't'])
})

test('eine abgewählte Sportart verschwindet vollständig', () => {
  const all = [opp({ id: 'f', sport: 'Fußball' }), opp({ id: 't', sport: 'Tennis', marketFamily: '2WAY' })]

  assert.deepEqual(
    ids(applyFilters(all, { ...FILTERS, sports: ['Tennis'] }, SETTINGS, 'percentage-desc')),
    ['t'],
  )
  assert.deepEqual(
    ids(applyFilters(all, { ...FILTERS, sports: ['Fußball'] }, SETTINGS, 'percentage-desc')),
    ['f'],
  )
})

test('eine unbekannte Sportart wird nicht durchgelassen', () => {
  // Käme das Backend mit einer Sportart, die die Oberfläche nicht kennt, wäre
  // sie ungefiltert — und der Nutzer hätte keine Möglichkeit, sie abzuwählen.
  // Snooker ist bewusst gewählt: es kommt in `SPORTS` nicht vor. Hier stand
  // vorher Handball, und der Test wurde in dem Moment sinnlos, als Handball
  // eine echte Sportart wurde.
  const all = [opp({ id: 'x', sport: 'Snooker' })]
  assert.deepEqual(applyFilters(all, FILTERS, SETTINGS, 'percentage-desc'), [])
})

test('Sport- und Marktfilter greifen unabhängig voneinander', () => {
  const all = [
    opp({ id: 't-2way', sport: 'Tennis', marketFamily: '2WAY' }),
    opp({ id: 't-ou', sport: 'Tennis', marketFamily: 'OU' }),
  ]
  const nurZweiweg = { ...FILTERS, sports: ['Tennis'], markets: ['2WAY'] }
  assert.deepEqual(ids(applyFilters(all, nurZweiweg, SETTINGS, 'percentage-desc')), ['t-2way'])
})

/* ------------------------------------------------------------ Zeitfenster */

/**
 * Das Fenster kommt vom Aufrufer, weil der Server es kennt und die Oberfläche
 * es von dort gemeldet bekommt. Vorher stand hier eine eigene Konstante über
 * sieben Tage — war das Backend-Fenster größer, verschwanden Partien
 * stillschweigend, und für diesen Filter gibt es keine Bedienfläche, an der man
 * das gesehen hätte.
 */
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()

test('das Fenster kommt vom Aufrufer und schneidet zu', () => {
  const all = [
    opp({ id: 'bald', startTime: inHours(6) }),
    opp({ id: 'morgen', startTime: inHours(30) }),
  ]
  const tag = 24 * 3600_000

  assert.deepEqual(
    ids(applyFilters(all, FILTERS, SETTINGS, 'percentage-desc', tag)),
    ['bald'],
    'was nach 30 Stunden anpfeift, liegt außerhalb eines Tagesfensters',
  )
  assert.deepEqual(
    ids(applyFilters(all, FILTERS, SETTINGS, 'percentage-desc', 7 * tag)),
    ['bald', 'morgen'],
    'mit einer Woche kommt beides durch — der Aufrufer entscheidet, nicht der Filter',
  )
})

test('ohne Angabe gilt die gemeinsame Vorgabe von 24 Stunden', () => {
  const all = [opp({ id: 'bald', startTime: inHours(6) }), opp({ id: 'spaet', startTime: inHours(48) })]
  assert.deepEqual(ids(applyFilters(all, FILTERS, SETTINGS, 'percentage-desc')), ['bald'])
})

test('bereits angepfiffene Partien fallen immer heraus', () => {
  const all = [opp({ id: 'laeuft', startTime: inHours(-1) })]
  assert.deepEqual(applyFilters(all, FILTERS, SETTINGS, 'percentage-desc'), [])
})
