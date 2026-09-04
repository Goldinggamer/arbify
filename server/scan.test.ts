import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventHeat, rejectedReport, scanForArbitrage } from './scan.ts'
import type { CanonicalMarket, MatchedEvent, RawEvent, RawOutcome, Side } from './types.ts'

/**
 * Der Scanner entscheidet, was als Fund angezeigt wird. Jeder Test hier prüft
 * eine Schranke, die verhindert, dass eine Zahl ausgewiesen wird, die es in
 * der Praxis nicht gibt — das ist die teure Fehlerrichtung. Ein verpasster
 * Fund kostet eine Gelegenheit, ein falscher Fund kostet Geld.
 */

const FT = { period: 'FT' as const, line: null, subject: null }
const X12: CanonicalMarket = { type: '1X2', ...FT }
const OU25: CanonicalMarket = { type: 'OU', period: 'FT', line: 2.5, subject: null }
const OU2: CanonicalMarket = { type: 'OU', period: 'FT', line: 2, subject: null }

const oc = (market: CanonicalMarket, side: Side, odds: number): RawOutcome => ({ market, side, odds })

/** Anstoß weit in der Zukunft — sonst greift die Kurzfrist-Warnung. */
const START = () => new Date(Date.now() + 4 * 3600_000).toISOString()

function source(bookmakerId: string, outcomes: RawOutcome[], over: Partial<RawEvent> = {}): RawEvent {
  return {
    bookmakerId,
    bookEventId: `${bookmakerId}-1`,
    sportradarId: 1,
    sport: 'Fußball',
    league: 'Deutschland — 1. Bundesliga',
    home: 'Alpha',
    away: 'Beta',
    startTime: START(),
    isLive: false,
    url: `https://${bookmakerId}.invalid`,
    outcomes,
    fetchedAt: new Date().toISOString(),
    ...over,
  }
}

function event(sources: RawEvent[], over: Partial<MatchedEvent> = {}): MatchedEvent {
  return {
    key: 'sr:1',
    sportradarId: 1,
    sport: 'Fußball',
    league: 'Deutschland — 1. Bundesliga',
    home: 'Alpha',
    away: 'Beta',
    startTime: sources[0]?.startTime ?? START(),
    isLive: false,
    sources,
    ...over,
  }
}

/** Zwei Bücher, die zusammen eine echte Arbitrage von rund 2 % ergeben. */
const arbSources = () => [
  source('a', [oc(OU25, 'OVER', 2.1)]),
  source('b', [oc(OU25, 'UNDER', 2.1)]),
]

test('ganzzahlige Torlinien werden gefunden und als Push-Linie markiert', () => {
  // Der Fund selbst ist gültig: liegen beide Beine auf derselben ganzen Linie,
  // werden bei genau zwei Toren beide Wetten annulliert und der Einsatz kommt
  // zurück — der schlechteste Ausgang ist die Null, nicht der Verlust. Genau
  // deshalb darf die Linie nicht mehr verworfen werden, wie es drei Adapter
  // taten: Über/Unter 1,0 kam damit auf null buchübergreifende Vergleiche.
  const { opportunities } = scanForArbitrage([
    event([source('a', [oc(OU2, 'OVER', 2.1)]), source('b', [oc(OU2, 'UNDER', 2.1)])]),
  ])
  assert.equal(opportunities.length, 1)
  assert.equal(opportunities[0].market, 'Über/Unter 2')
  // Der Nutzer muss den Push-Fall kennen: eine ausgewiesene Rendite, die mit
  // gewisser Wahrscheinlichkeit zu 0 % wird, ist etwas anderes als eine, die
  // es nicht wird.
  assert.ok(opportunities[0].warnings.includes('push-line'))
})

test('halbe Linien tragen keine Push-Warnung', () => {
  // Die Gegenprobe: bei 2,5 gibt es kein Ergebnis, das den Einsatz zurückgibt.
  const { opportunities } = scanForArbitrage([event(arbSources())])
  assert.equal(opportunities.length, 1)
  assert.ok(!opportunities[0].warnings.includes('push-line'))
})

test('ganze und halbe Linien fallen nicht auf denselben Schlüssel', () => {
  // Über 2,0 und Über 2,5 sind verschiedene Wetten. Fielen sie zusammen, würde
  // ein Push-Bein gegen ein Nicht-Push-Bein gerechnet — und der Push-Fall wäre
  // dann kein Nullausgang mehr, sondern ein echter Verlust.
  const { opportunities } = scanForArbitrage([
    event([source('a', [oc(OU2, 'OVER', 2.1)]), source('b', [oc(OU25, 'UNDER', 2.1)])]),
  ])
  assert.deepEqual(opportunities, [])
})

test('vollständiger Markt über zwei Bücher ergibt einen Fund', () => {
  const { opportunities } = scanForArbitrage([event(arbSources())])
  assert.equal(opportunities.length, 1)
  const o = opportunities[0]
  assert.equal(o.marketFamily, 'OU')
  // 1/2,1 + 1/2,1 = 0,952 → 1/0,952 − 1 = 5,0 %
  assert.ok(Math.abs(o.arbPercent - 5) < 0.001, `arbPercent war ${o.arbPercent}`)
  assert.deepEqual(o.outcomes.map((x) => x.best.bookmakerId), ['a', 'b'])
})

test('fehlendes Bein ergibt keinen Fund', () => {
  // Ohne die Gegenseite wäre die implizite Summe künstlich klein und jede
  // Zahl daraus reine Erfindung.
  const { opportunities } = scanForArbitrage([
    event([source('a', [oc(OU25, 'OVER', 2.1)]), source('b', [oc(OU25, 'OVER', 2.2)])]),
  ])
  assert.equal(opportunities.length, 0)
})

test('beide Bestquoten beim selben Buch ergeben keinen Fund', () => {
  // Das wäre eine Marge unter null beim selben Anbieter — gibt es nicht.
  const { opportunities } = scanForArbitrage([
    event([
      source('a', [oc(OU25, 'OVER', 2.1), oc(OU25, 'UNDER', 2.1)]),
      source('b', [oc(OU25, 'OVER', 1.5), oc(OU25, 'UNDER', 1.5)]),
    ]),
  ])
  assert.equal(opportunities.length, 0)
})

test('nur eine Quelle ergibt keinen Fund', () => {
  const { opportunities } = scanForArbitrage([event([source('a', [oc(OU25, 'OVER', 2.1), oc(OU25, 'UNDER', 2.1)])])])
  assert.equal(opportunities.length, 0)
})

test('laufende Spiele werden nicht bewertet', () => {
  const { opportunities } = scanForArbitrage([event(arbSources(), { isLive: true })])
  assert.equal(opportunities.length, 0)
})

test('unplausibel niedrige Summe wird verworfen und gemeldet', () => {
  // 1/5 + 1/5 = 0,4 — zwischen echten Büchern unmöglich, also ein Datenfehler.
  const { opportunities } = scanForArbitrage([
    event([source('a', [oc(OU25, 'OVER', 5)]), source('b', [oc(OU25, 'UNDER', 5)])]),
  ])
  assert.equal(opportunities.length, 0)
  assert.equal(rejectedReport().length, 1)
  assert.match(rejectedReport()[0].market, /Über\/Unter 2\.5/)
})

test('ein Bein mit absurder Quote wird verworfen', () => {
  // Trägt kaum Einsatz, aber das ganze Ausführungsrisiko: 1/50 + 1/1,05
  // ergibt 0,972 — rechnerisch eine Arbitrage von 2,8 %, praktisch keine.
  const { opportunities } = scanForArbitrage([
    event([source('a', [oc(OU25, 'OVER', 50)]), source('b', [oc(OU25, 'UNDER', 1.05)])]),
  ])
  assert.equal(opportunities.length, 0)
  assert.match(rejectedReport()[0].legs, /Bein über Quote 30/)
})

test('Team-Über/Unter wird gegengerechnet', () => {
  // War früher aus dem Vergleich ausgeschlossen; siehe COMPARABLE in scan.ts.
  const home25: CanonicalMarket = { type: 'TEAM_OU', period: 'FT', line: 2.5, subject: 'HOME' }
  const { opportunities } = scanForArbitrage([
    event([source('a', [oc(home25, 'OVER', 2.1)]), source('b', [oc(home25, 'UNDER', 2.1)])]),
  ])
  assert.equal(opportunities.length, 1)
  assert.equal(opportunities[0].marketFamily, 'TEAM_OU')
  assert.match(opportunities[0].market, /Alpha Über\/Unter 2\.5/)
})

test('Halbzeit und Ganzspiel sind verschiedene Märkte', () => {
  // Genau diese Verwechslung erzeugte die Phantom-Arbitragen bei Team-Totals.
  const h1: CanonicalMarket = { type: 'OU', period: 'H1', line: 2.5, subject: null }
  const { opportunities } = scanForArbitrage([
    event([source('a', [oc(OU25, 'OVER', 2.1)]), source('b', [oc(h1, 'UNDER', 2.1)])]),
  ])
  assert.equal(opportunities.length, 0)
})

test('Team-Über/Unter trennt Heim- und Auswärtsteam', () => {
  const home: CanonicalMarket = { type: 'TEAM_OU', period: 'FT', line: 1.5, subject: 'HOME' }
  const away: CanonicalMarket = { type: 'TEAM_OU', period: 'FT', line: 1.5, subject: 'AWAY' }
  const { opportunities } = scanForArbitrage([
    event([source('a', [oc(home, 'OVER', 2.1)]), source('b', [oc(away, 'UNDER', 2.1)])]),
  ])
  assert.equal(opportunities.length, 0)
})

test('knapper Anpfiff und veraltete Quoten werden markiert, nicht verworfen', () => {
  const soon = new Date(Date.now() + 5 * 60_000).toISOString()
  const stale = new Date(Date.now() - 120_000).toISOString()
  const { opportunities } = scanForArbitrage([
    event(
      [
        source('a', [oc(OU25, 'OVER', 2.1)], { startTime: soon, fetchedAt: stale }),
        source('b', [oc(OU25, 'UNDER', 2.1)], { startTime: soon }),
      ],
      { startTime: soon },
    ),
  ])
  assert.equal(opportunities.length, 1)
  assert.deepEqual(opportunities[0].warnings.sort(), ['short-notice', 'stale-odds'])
})

test('minPercent filtert schwache Funde', () => {
  const { opportunities } = scanForArbitrage([event(arbSources())], 10)
  assert.equal(opportunities.length, 0)
})

test('Funde sind absteigend nach Rendite sortiert', () => {
  const strong = event(
    [source('a', [oc(OU25, 'OVER', 2.2)]), source('b', [oc(OU25, 'UNDER', 2.2)])],
    { key: 'sr:2' },
  )
  const { opportunities } = scanForArbitrage([event(arbSources()), strong])
  assert.equal(opportunities.length, 2)
  assert.ok(opportunities[0].arbPercent > opportunities[1].arbPercent)
})

test('Vergleichsliste enthält nur spielbare Paare', () => {
  // 31,00 gegen 1,01 steht rechnerisch nah an einer Arbitrage, ist aber wegen
  // Limits und Rundung nie eine — solche Zeilen würden die Liste fluten.
  const { margins } = scanForArbitrage([
    event([source('a', [oc(OU25, 'OVER', 31)]), source('b', [oc(OU25, 'UNDER', 1.01)])]),
  ])
  assert.equal(margins.length, 0)
})

test('eventHeat liefert die niedrigste implizite Summe über alle Märkte', () => {
  const ev = event([
    source('a', [oc(X12, 'HOME', 3), oc(X12, 'DRAW', 3), oc(X12, 'AWAY', 3), oc(OU25, 'OVER', 2.1)]),
    source('b', [oc(OU25, 'UNDER', 2.1)]),
  ])
  // 1X2: 3 × 1/3 = 1,0 · Über/Unter: 2 × 1/2,1 ≈ 0,952 → der kleinere Wert zählt.
  assert.ok(Math.abs(eventHeat(ev) - 0.95238) < 0.0001)
})

test('eventHeat ignoriert unvollständige Märkte und Einzelquellen', () => {
  assert.equal(eventHeat(event([source('a', [oc(OU25, 'OVER', 2.1), oc(OU25, 'UNDER', 2.1)])])), Infinity)
  assert.equal(
    eventHeat(event([source('a', [oc(X12, 'HOME', 2)]), source('b', [oc(X12, 'DRAW', 3)])])),
    Infinity,
  )
})

/* ------------------------------------- Zwei Märkte auf einem Schlüssel */

/**
 * Fällt bei **einem** Buch dieselbe Seite zweimal an, sind zwei verschiedene
 * Märkte auf einen Schlüssel gefallen — ein Zuordnungsfehler im Adapter.
 *
 * Die Zahlen stammen aus einem echten Fall: Tipico führte für Japan (F) gegen
 * Mali (F) „Wer gewinnt das 4. Viertel?" (1,45 / 15 / 2,75) und „Wer gewinnt
 * die 1. Halbzeit?" (1,16 / 22 / 4,60) auf demselben Schlüssel.
 *
 * Der Fund wird **nicht** unterdrückt: eine Regel, die im Zweifel die
 * schlechtere Quote nimmt, verschluckt auch echte Arbitragen, und zwar
 * unsichtbar. Er wird stattdessen markiert — sichtbar, prüfbar, meldbar.
 */
test('eine Marktverwechslung wird markiert, nicht verschluckt', () => {
  const H1: CanonicalMarket = { type: '1X2', period: 'H1', line: null, subject: null }
  const { opportunities } = scanForArbitrage(
    [
      event([
        source('tipico', [
          oc(H1, 'HOME', 1.45),
          oc(H1, 'DRAW', 15),
          oc(H1, 'HOME', 1.16),
          oc(H1, 'DRAW', 22),
        ]),
        source('winamax', [oc(H1, 'AWAY', 4.7)]),
      ]),
    ],
    0,
  )

  assert.equal(opportunities.length, 1, 'der Fund bleibt sichtbar')
  assert.ok(
    opportunities[0].warnings.includes('market-collision'),
    'und trägt den Hinweis, dass die Zuordnung unklar ist',
  )
  assert.equal(opportunities[0].outcomes[0].best.odds, 1.45, 'gerechnet wird mit der besten Quote')
})

test('ein sauberer Fund trägt den Hinweis nicht', () => {
  const { opportunities } = scanForArbitrage(
    [
      event([
        source('a', [oc(X12, 'HOME', 3.4), oc(X12, 'DRAW', 3.9)]),
        source('b', [oc(X12, 'HOME', 3.6), oc(X12, 'AWAY', 3.9)]),
      ]),
    ],
    0,
  )
  assert.equal(opportunities.length, 1)
  assert.ok(!opportunities[0].warnings.includes('market-collision'))
  const heim = opportunities[0].outcomes[0]
  assert.equal(heim.best.odds, 3.6, 'zwischen verschiedenen Büchern zählt die beste Quote')
  assert.equal(heim.best.bookmakerId, 'b')
})

/**
 * Eine beworbene Quote ist **keine** Verwechslung.
 *
 * Betano führt an derselben Partie "Endergebnis SuperQuoten" (1,53 / 4,80 /
 * 6,10) neben "Endergebnis" (1,52 / 4,60 / 5,80) — dieselbe Wette, jede Seite
 * eine Spur höher. Beide gehören auf denselben Schlüssel, und dass dort zwei
 * Quoten desselben Buchs stehen, ist erwartet.
 *
 * Würde das als Kollision gemeldet, wäre die Markierung wertlos: sie träfe
 * jeden beworbenen Fund und keinen echten Zuordnungsfehler mehr.
 */
test('ein Quotenboost gilt nicht als Verwechslung, wird aber ausgewiesen', () => {
  const { opportunities } = scanForArbitrage(
    [
      event([
        source('betano', [
          { ...oc(X12, 'HOME', 1.52), promo: undefined },
          { ...oc(X12, 'HOME', 1.53), promo: true },
          { ...oc(X12, 'DRAW', 4.6), promo: undefined },
          { ...oc(X12, 'DRAW', 4.8), promo: true },
        ]),
        source('tipico', [oc(X12, 'AWAY', 12)]),
      ]),
    ],
    0,
  )

  assert.equal(opportunities.length, 1)
  const o = opportunities[0]
  assert.ok(!o.warnings.includes('market-collision'), 'kein Zuordnungsfehler')
  assert.ok(o.warnings.includes('promo-odds'), 'aber als beworben gekennzeichnet')
  assert.equal(o.outcomes[0].best.odds, 1.53, 'gerechnet wird mit der besseren Quote')
})

test('ohne Boost bleibt die Dopplung eine Verwechslung', () => {
  const { opportunities } = scanForArbitrage(
    [
      event([
        source('betano', [
          // Zwei Heimquoten ohne Boost — im echten Fall stammten sie aus
          // "4. Viertel" und "1. Halbzeit".
          oc(X12, 'HOME', 1.52),
          oc(X12, 'HOME', 1.6),
          oc(X12, 'DRAW', 4.6),
        ]),
        source('tipico', [oc(X12, 'AWAY', 12)]),
      ]),
    ],
    0,
  )
  assert.equal(opportunities.length, 1)
  assert.ok(opportunities[0].warnings.includes('market-collision'))
  assert.ok(!opportunities[0].warnings.includes('promo-odds'))
})
