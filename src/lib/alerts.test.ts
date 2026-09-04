import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectAlerts, type AlertCandidate } from './alerts.ts'

/**
 * Der Scanner fragt im Zwei-Sekunden-Takt. Die ganze Schwierigkeit liegt darin,
 * **nicht** alle zwei Sekunden erneut zu klingeln — und trotzdem zu klingeln,
 * wenn eine Quote weglief und wiederkommt.
 */

const c = (id: string, percent: number): AlertCandidate => ({ id, percent, label: id })

test('nur Funde über der Schwelle lösen aus', () => {
  const { fresh } = selectAlerts([c('a', 2.9), c('b', 3.0), c('c', 5.1)], 3, new Set())
  assert.deepEqual(
    fresh.map((f) => f.id),
    ['c', 'b'],
    'genau auf der Schwelle zählt mit, darunter nicht — höchste Rendite zuerst',
  )
})

test('derselbe Fund klingelt nicht zweimal', () => {
  const list = [c('a', 4.2)]
  const first = selectAlerts(list, 3, new Set())
  assert.equal(first.fresh.length, 1)

  // Zweiter Takt, unveränderte Lage: nichts Neues.
  const second = selectAlerts(list, 3, first.next)
  assert.deepEqual(second.fresh, [])
  assert.deepEqual([...second.next], ['a'])
})

test('ein Fund, der weglief und wiederkommt, klingelt erneut', () => {
  // Das ist der Grund, warum `next` neu aufgebaut wird statt zu wachsen: eine
  // Quote, die verschwindet und später wieder auftaucht, ist ein neuer Anlass.
  const first = selectAlerts([c('a', 4.2)], 3, new Set())
  const gone = selectAlerts([], 3, first.next)
  assert.deepEqual([...gone.next], [], 'verschwundene Funde fallen aus dem Gedächtnis')

  const back = selectAlerts([c('a', 4.2)], 3, gone.next)
  assert.deepEqual(
    back.fresh.map((f) => f.id),
    ['a'],
  )
})

test('ein Fund, der unter die Schwelle fällt, klingelt beim Wiederanstieg', () => {
  const first = selectAlerts([c('a', 4.2)], 3, new Set())
  const dipped = selectAlerts([c('a', 1.1)], 3, first.next)
  assert.deepEqual(dipped.fresh, [])
  assert.deepEqual([...dipped.next], [], 'unter der Schwelle zählt wie nicht vorhanden')

  const risen = selectAlerts([c('a', 3.4)], 3, dipped.next)
  assert.deepEqual(
    risen.fresh.map((f) => f.id),
    ['a'],
  )
})

test('ein zweiter Fund neben einem bekannten klingelt allein', () => {
  const first = selectAlerts([c('a', 4.2)], 3, new Set())
  const second = selectAlerts([c('a', 4.2), c('b', 3.8)], 3, first.next)
  assert.deepEqual(
    second.fresh.map((f) => f.id),
    ['b'],
    'der bekannte Fund bleibt still, der neue nicht',
  )
  assert.deepEqual([...second.next].sort(), ['a', 'b'])
})

test('leere Eingabe und Schwelle null bleiben harmlos', () => {
  assert.deepEqual(selectAlerts([], 3, new Set()).fresh, [])
  // Schwelle 0: alles zählt, aber immer noch nur einmal.
  const all = selectAlerts([c('a', 0)], 0, new Set())
  assert.equal(all.fresh.length, 1)
  assert.deepEqual(selectAlerts([c('a', 0)], 0, all.next).fresh, [])
})
