import { test } from 'node:test'
import assert from 'node:assert/strict'
import { halfOf, num, ouSideFromText } from './labels.ts'

test('ouSideFromText: dieselben Schreibweisen für alle Adapter', () => {
  // bwin verlangte „mehr als“, Betano nahm auch „mehr“ — jetzt einheitlich.
  for (const s of ['Über 2,5', 'Over 2.5', 'Mehr als 182,5', 'Mehr 182,5', '  über 1.5']) assert.equal(ouSideFromText(s), 'OVER', s)
  for (const s of ['Unter 2,5', 'Under 2.5', 'Weniger als 182,5', 'Weniger 182,5']) assert.equal(ouSideFromText(s), 'UNDER', s)
  assert.equal(ouSideFromText('Ja'), null)
})
import { inWindow } from './types.ts'

test('inWindow: eine unlesbare Anstoßzeit liegt nicht im Fenster', () => {
  // NaN > cutoff ist false — ohne Prüfung ging die Partie durch, und das
  // anschließende toISOString() warf und kostete den ganzen Sweep des Buchs.
  const cutoff = Date.UTC(2030, 0, 2)
  assert.equal(inWindow(NaN, cutoff), false)
  assert.equal(inWindow(Date.parse('kein Datum'), cutoff), false)
  assert.equal(inWindow(undefined, cutoff), false)

  assert.equal(inWindow(Date.UTC(2030, 0, 1), cutoff), true)
  assert.equal(inWindow(cutoff, cutoff), true)
  assert.equal(inWindow(cutoff + 1, cutoff), false)
})

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
