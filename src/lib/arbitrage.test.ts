import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arbPercentOf, calculateArbitrage, taxedBooksOf } from './arbitrage.ts'
import type { Opportunity, Settings } from '../types.ts'

/**
 * Der Rechenkern schlägt die Einsätze vor, die tatsächlich gesetzt werden.
 * Die entscheidende Eigenschaft ist nicht die ausgewiesene Rendite, sondern
 * dass der **schlechteste** Ausgang noch positiv ist — alles andere ist eine
 * Wette, keine Arbitrage.
 */

const settings = (over: Partial<Settings> = {}) =>
  ({ bankroll: 1000, roundTo: 0, ...over }) as Settings

const leg = (odds: number, bookmakerId = `b${odds}`) => ({
  odds,
  label: `Quote ${odds}`,
  bookmakerId,
})

test('Auszahlung ist bei jedem Ausgang gleich', () => {
  // Das ist die Definition der Aufteilung: Einsatz proportional zu 1/Quote.
  const r = calculateArbitrage([leg(2.1), leg(2.1)], settings())
  const payouts = r.legs.map((l) => l.payout)
  assert.ok(Math.max(...payouts) - Math.min(...payouts) < 1e-9)
  assert.equal(r.totalStake, 1000)
})

test('garantierter Gewinn entspricht der theoretischen Rendite', () => {
  const r = calculateArbitrage([leg(2.1), leg(2.1)], settings())
  assert.equal(r.isArb, true)
  assert.ok(Math.abs(r.theoreticalPercent - 5) < 1e-9)
  assert.ok(Math.abs(r.arbPercent - r.theoreticalPercent) < 1e-9)
  assert.ok(Math.abs(r.guaranteedProfit - 50) < 1e-9)
})

test('funktioniert auch bei drei Beinen', () => {
  const r = calculateArbitrage([leg(3.1), leg(3.2), leg(3.3)], settings())
  const payouts = r.legs.map((l) => l.payout)
  assert.ok(Math.max(...payouts) - Math.min(...payouts) < 1e-9)
  assert.equal(r.legs.length, 3)
  assert.ok(r.guaranteedProfit > 0)
})

test('ohne Arbitrage ist der garantierte Gewinn negativ', () => {
  const r = calculateArbitrage([leg(1.9), leg(1.9)], settings())
  assert.equal(r.isArb, false)
  assert.ok(r.theoreticalPercent < 0)
  assert.ok(r.guaranteedProfit < 0)
})

test('Anteile summieren sich auf 1', () => {
  const r = calculateArbitrage([leg(2.5), leg(3.0), leg(4.0)], settings())
  assert.ok(Math.abs(r.legs.reduce((s, l) => s + l.share, 0) - 1) < 1e-9)
})

test('Rundung auf ganze Zehner hält den Gewinn positiv', () => {
  const r = calculateArbitrage([leg(2.1), leg(2.1)], settings({ roundTo: 10 }))
  for (const l of r.legs) assert.equal(l.stake % 10, 0)
  assert.ok(r.guaranteedProfit > 0)
  // Nach der Rundung zählt der tatsächliche Wert, nicht der theoretische.
  assert.ok(Math.abs(r.arbPercent - r.guaranteedProfit / r.totalStake * 100) < 1e-9)
})

test('Rundung bei ungleichen Quoten verzerrt die Rendite messbar', () => {
  // Grobe Stückelung kann einen knappen Fund unter Wasser drücken — deshalb
  // wird die Rendite nach Rundung ausgewiesen und nicht davor.
  const r = calculateArbitrage([leg(2.02), leg(2.02)], settings({ bankroll: 100, roundTo: 25 }))
  assert.ok(r.theoreticalPercent > 0)
  assert.ok(r.arbPercent <= r.theoreticalPercent)
})

test('arbPercentOf rechnet nur mit den Bestquoten', () => {
  const opp = {
    outcomes: [
      { best: { odds: 2.1 }, all: [] },
      { best: { odds: 2.1 }, all: [] },
    ],
  } as unknown as Opportunity
  assert.ok(Math.abs(arbPercentOf(opp) - 5) < 1e-9)
})

/* --------------------------------------------------------------- Wettsteuer */

test('die Wettsteuer verändert die Aufteilung nicht', () => {
  // Bewusst so: die App weist reine Quotenwerte aus. Winamax trägt die Steuer
  // selbst, Betano gibt sie weiter — an der Rechnung ändert das nichts, nur
  // am Hinweis.
  const frei = calculateArbitrage([leg(2.1, 'winamax'), leg(2.1, 'tipico')], settings())
  const besteuert = calculateArbitrage([leg(2.1, 'winamax'), leg(2.1, 'betano')], settings())

  assert.equal(frei.arbPercent, besteuert.arbPercent)
  assert.deepEqual(
    frei.legs.map((l) => l.stake),
    besteuert.legs.map((l) => l.stake),
  )
})

test('jedes Bein weiß, ob sein Anbieter die Steuer weitergibt', () => {
  const r = calculateArbitrage([leg(2.1, 'winamax'), leg(2.1, 'betano')], settings())
  assert.equal(r.legs[0].taxed, false)
  assert.equal(r.legs[1].taxed, true)
})

test('unbekannte Anbieter gelten vorsichtshalber als steuerpflichtig', () => {
  // Ein Hinweis zu viel kostet einen Blick in den Wettschein, ein Hinweis zu
  // wenig kostet Geld.
  const r = calculateArbitrage([leg(2.1, 'gibtsnicht')], settings())
  assert.equal(r.legs[0].taxed, true)
})

test('taxedBooksOf nennt nur die Bücher der Bestquoten', () => {
  const opp = {
    outcomes: [
      { best: { bookmakerId: 'winamax', odds: 2.1 }, all: [] },
      { best: { bookmakerId: 'betano', odds: 2.1 }, all: [] },
    ],
  } as unknown as Opportunity
  assert.deepEqual(taxedBooksOf(opp), ['betano'])
})
