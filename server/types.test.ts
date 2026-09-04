import { test } from 'node:test'
import assert from 'node:assert/strict'
import { marketKey, marketLabel, sideLabel, SIDES } from './types.ts'
import type { CanonicalMarket } from './types.ts'

/**
 * `marketKey` ist die Schranke, an der entschieden wird, ob zwei Quoten
 * überhaupt dieselbe Wette meinen. Jeder Bestandteil des Schlüssels muss
 * trennen — fällt einer weg, werden verschiedene Märkte gegeneinander
 * gerechnet, und genau das war die Ursache der Team-Über/Unter-Ausreißer.
 */

const m = (over: Partial<CanonicalMarket>): CanonicalMarket => ({
  type: 'OU',
  period: 'FT',
  line: 2.5,
  subject: null,
  ...over,
})

test('marketKey trennt nach Typ, Periode, Team und Linie', () => {
  const base = marketKey(m({}))
  assert.notEqual(base, marketKey(m({ type: 'TEAM_OU', subject: 'HOME' })))
  assert.notEqual(base, marketKey(m({ period: 'H1' })))
  assert.notEqual(base, marketKey(m({ line: 3.5 })))
  assert.notEqual(
    marketKey(m({ type: 'TEAM_OU', subject: 'HOME' })),
    marketKey(m({ type: 'TEAM_OU', subject: 'AWAY' })),
  )
})

test('marketKey ist für dasselbe Objekt stabil', () => {
  assert.equal(marketKey(m({})), marketKey(m({})))
})

test('jede Marktfamilie hat mindestens zwei Seiten', () => {
  // Ein Markt mit einer Seite wäre immer „vollständig" und würde jede
  // beliebige Quote als Arbitrage ausweisen.
  for (const [type, sides] of Object.entries(SIDES)) {
    assert.ok(sides.length >= 2, `${type} hat nur ${sides.length} Seite(n)`)
    assert.equal(new Set(sides).size, sides.length, `${type} hat doppelte Seiten`)
  }
})

test('Beschriftungen benennen Team und Linie eindeutig', () => {
  assert.equal(marketLabel(m({ type: '1X2', line: null }), 'Alpha', 'Beta'), 'Siegwette')
  assert.equal(marketLabel(m({ period: 'H1' }), 'Alpha', 'Beta'), 'Über/Unter 2.5 (1. HZ)')
  assert.equal(
    marketLabel(m({ type: 'TEAM_OU', subject: 'AWAY', line: 1.5 }), 'Alpha', 'Beta'),
    'Beta Über/Unter 1.5',
  )
  assert.equal(marketLabel(m({ type: 'EH', line: 1 }), 'Alpha', 'Beta'), 'Handicap +1')
})

test('das Handicap wird je Seite aus deren Sicht beschriftet', () => {
  const eh = m({ type: 'EH', line: 1 })
  assert.equal(sideLabel('HOME', 'Alpha', 'Beta', eh), 'Alpha +1')
  assert.equal(sideLabel('AWAY', 'Alpha', 'Beta', eh), 'Beta -1')
})
