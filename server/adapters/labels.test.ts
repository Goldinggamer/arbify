import { test } from 'node:test'
import assert from 'node:assert/strict'
import { halfOf, num } from './labels.ts'

test('num: ein fehlender Wert ist keine Null', () => {
  // Number('') ist 0. Eine fehlende Linie wurde so zur Linie 0 und landete
  // als Handicap 0 im Bestand, statt verworfen zu werden.
  assert.equal(num(undefined), null)
  assert.equal(num(null), null)
  assert.equal(num(''), null)
  assert.equal(num('  '), null)

  assert.equal(num('0'), 0)
  assert.equal(num(0), 0)
  assert.equal(num('2,5'), 2.5)
  assert.equal(num(-1.5), -1.5)
  assert.equal(num('abc'), null)
})

test('halfOf: Lang- und Kurzformen, sonst null', () => {
  assert.equal(halfOf('1. Halbzeit Über/Unter'), 'H1')
  assert.equal(halfOf('1. HZ Heimteam Über/Unter'), 'H1')
  assert.equal(halfOf('Tore - 2. Hälfte'), 'H2')
  assert.equal(halfOf('Zweite Halbzeit'), 'H2')
  assert.equal(halfOf('Gesamttore'), null)
})
