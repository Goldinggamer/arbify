import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, emptyState, formatMessage, inQuietHours, type AlertConfig } from './alerts.ts'
import { ALL_MARKET_IDS, ALL_SPORT_IDS } from '../src/data/markets.ts'
import type { Filters, Opportunity, Settings } from '../src/types.ts'

/**
 * Der Melde-Motor entscheidet, was auf dem Telefon landet — und zwar während
 * niemand hinsieht. Genau deshalb sind seine Regeln hier festgenagelt: ein
 * Fehler nach oben macht das Telefon unbenutzbar, ein Fehler nach unten bleibt
 * unbemerkt, weil eine Meldung, die nie kommt, sich nicht beschwert.
 */

const SETTINGS: Settings = {
  bankroll: 500,
  roundTo: 1,
  currency: '€',
  alertMinPercent: 3,
  alertSound: false,
  alertDesktop: false,
  alertPush: true,
  alertQuiet: false,
  quietFrom: 23,
  quietTo: 8,
}

const FILTERS: Filters = {
  bookmakers: ['tipico', 'bwin'],
  sports: [...ALL_SPORT_IDS],
  minOdds: 1,
  maxOdds: 100,
  minPercentage: 0,
  maxPercentage: 100,
  markets: [...ALL_MARKET_IDS],
  warnings: [],
  search: '',
}

const config = (over: Partial<Settings> = {}, filters: Partial<Filters> = {}): AlertConfig => ({
  filters: { ...FILTERS, ...filters },
  settings: { ...SETTINGS, ...over },
  updatedAt: new Date(0).toISOString(),
})

/**
 * Eine Wettmöglichkeit mit einstellbarer Rendite.
 *
 * Zwei gleiche Quoten ergeben eine implizite Summe von 2/`odds`; bei 2,10
 * sind das 95,238 % und damit genau 5,00 % Rendite.
 */
function opp(id: string, odds: number, over: Partial<Opportunity> = {}): Opportunity {
  return {
    id,
    sport: 'Fußball',
    league: 'Testliga',
    home: 'Alpha',
    away: 'Beta',
    startTime: new Date(Date.now() + 4 * 3600_000).toISOString(),
    isLive: false,
    market: 'Über/Unter 2.5',
    marketFamily: 'OU',
    outcomes: [
      { label: 'Über 2.5', best: { bookmakerId: 'tipico', odds }, all: [{ bookmakerId: 'tipico', odds }] },
      { label: 'Unter 2.5', best: { bookmakerId: 'bwin', odds }, all: [{ bookmakerId: 'bwin', odds }] },
    ],
    warnings: [],
    links: { tipico: 'https://tipico.example/1', bwin: 'https://bwin.example/1' },
    ...over,
  }
}

const T0 = new Date('2026-08-08T14:00:00Z').getTime()
const ids = (d: ReturnType<typeof decide>) => d.send.map((o) => o.id)

test('nur Funde über der Schwelle werden gemeldet', () => {
  // 2,10 → 5,00 % (über der Schwelle), 2,02 → 1,00 % (darunter).
  const d = decide([opp('gut', 2.1), opp('schwach', 2.02)], config(), emptyState(), T0)
  assert.deepEqual(ids(d), ['gut'])
})

test('derselbe Fund meldet sich nicht zweimal', () => {
  const list = [opp('a', 2.1)]
  const first = decide(list, config(), emptyState(), T0)
  assert.deepEqual(ids(first), ['a'])

  // Zehn Sekunden später, unveränderte Lage — der Refresh läuft im
  // Zehn-Sekunden-Takt, ohne Entdopplung wären das 360 Meldungen je Stunde.
  const second = decide(list, config(), first.next, T0 + 10_000)
  assert.deepEqual(ids(second), [])
})

test('nach der Ruhezeit meldet sich derselbe Fund erneut', () => {
  const list = [opp('a', 2.1)]
  const first = decide(list, config(), emptyState(), T0)
  const later = decide(list, config(), first.next, T0 + 31 * 60_000)
  assert.deepEqual(ids(later), ['a'], 'eine halbe Stunde später ist es eine neue Gelegenheit')
})

test('der Filter des Nutzers gilt — ein abgewählter Buchmacher meldet nicht', () => {
  // Ohne bwin bleibt nur ein Bein, und ein Bein ist keine Arbitrage.
  const d = decide([opp('a', 2.1)], config({}, { bookmakers: ['tipico'] }), emptyState(), T0)
  assert.deepEqual(ids(d), [])
})

test('eine abgewählte Sportart meldet nicht', () => {
  const d = decide(
    [opp('a', 2.1, { sport: 'Basketball', marketFamily: 'OU' })],
    config({}, { sports: ['Fußball'] }),
    emptyState(),
    T0,
  )
  assert.deepEqual(ids(d), [])
})

test('eine ausgeblendete Warnung meldet nicht', () => {
  const d = decide(
    [opp('a', 2.1, { warnings: ['overtime'] })],
    config({}, { warnings: ['overtime'] }),
    emptyState(),
    T0,
  )
  assert.deepEqual(ids(d), [], 'wer die Warnung ausblendet, will die Wette auch nicht aufs Telefon')
})

test('abgeschaltet meldet nichts und leert das Gedächtnis', () => {
  const first = decide([opp('a', 2.1)], config(), emptyState(), T0)
  assert.equal(first.send.length, 1)

  const off = decide([opp('a', 2.1)], config({ alertPush: false }), first.next, T0 + 1000)
  assert.deepEqual(ids(off), [])
  assert.deepEqual(off.next, emptyState(), 'sonst bliebe es nach dem Wiedereinschalten stumm')

  // Wieder an: der Fund ist wieder neu.
  const on = decide([opp('a', 2.1)], config(), off.next, T0 + 2000)
  assert.deepEqual(ids(on), ['a'])
})

test('Schwelle null schaltet ab', () => {
  const d = decide([opp('a', 2.1)], config({ alertMinPercent: 0 }), emptyState(), T0)
  assert.deepEqual(ids(d), [])
  assert.equal(d.reason, 'aus')
})

test('die Mengenbegrenzung deckelt eine Lawine und behält die besten Funde', () => {
  // Zwölf Funde auf einmal — so sieht ein Datenfehler bei einem Anbieter aus.
  // Gemeldet werden acht, und zwar die mit der höchsten Rendite.
  const many = Array.from({ length: 12 }, (_, i) => opp(`f${i}`, 2.1 + i * 0.02))
  const d = decide(many, config(), emptyState(), T0)
  assert.equal(d.send.length, 8)
  assert.equal(d.suppressed, 4)
  assert.equal(d.reason, 'menge')
  assert.equal(d.send[0].id, 'f11', 'die höchste Rendite zuerst')
})

test('nach dem Fenster ist die Mengenbegrenzung wieder offen', () => {
  const many = Array.from({ length: 12 }, (_, i) => opp(`f${i}`, 2.1 + i * 0.02))
  const first = decide(many, config(), emptyState(), T0)
  assert.equal(first.send.length, 8)

  // Elf Minuten später ist das Zehn-Minuten-Fenster leer — und die Ruhezeit
  // der bereits gemeldeten läuft noch, also kommen genau die vier Übrigen.
  const later = decide(many, config(), first.next, T0 + 11 * 60_000)
  assert.equal(later.send.length, 4)
})

test('Nachtruhe schweigt, ohne den Fund zu verbrauchen', () => {
  // 02:00 Ortszeit liegt in 23–8.
  const nacht = new Date('2026-08-08T02:00:00')
  const d = decide([opp('a', 2.1)], config({ alertQuiet: true }), emptyState(), nacht.getTime())
  assert.deepEqual(ids(d), [])
  assert.equal(d.reason, 'nachtruhe')
  assert.deepEqual(d.next.sent, {}, 'nicht als gemeldet vermerken')

  // Morgens um neun steht der Fund noch — jetzt meldet er sich.
  const morgens = new Date('2026-08-08T09:00:00')
  const nachher = decide([opp('a', 2.1)], config({ alertQuiet: true }), d.next, morgens.getTime())
  assert.deepEqual(ids(nachher), ['a'])
})

test('inQuietHours rechnet über Mitternacht', () => {
  const at = (h: number) => new Date(2026, 7, 8, h, 30)
  assert.equal(inQuietHours(at(23), 23, 8), true)
  assert.equal(inQuietHours(at(3), 23, 8), true)
  assert.equal(inQuietHours(at(7), 23, 8), true)
  assert.equal(inQuietHours(at(8), 23, 8), false)
  assert.equal(inQuietHours(at(14), 23, 8), false)
  // Tagsüber, ohne Mitternacht dazwischen.
  assert.equal(inQuietHours(at(10), 9, 12), true)
  assert.equal(inQuietHours(at(13), 9, 12), false)
  // Gleicher Beginn und Ende heißt **keine** Ruhezeit — sonst verschluckt eine
  // versehentliche Einstellung jede Meldung für immer.
  assert.equal(inQuietHours(at(5), 8, 8), false)
})

test('die Meldung trägt beide Beine mit Quote und Buchmacher', () => {
  const m = formatMessage(opp('a', 2.1))
  assert.match(m.title, /5,00 % · Fußball/)
  assert.match(m.body, /Alpha — Beta/)
  assert.match(m.body, /Über 2\.5 — 2,10 @ Tipico/)
  assert.match(m.body, /Unter 2\.5 — 2,10 @ bwin/)
  // Ohne Knöpfe müsste man die App öffnen, um überhaupt zum Wettschein zu
  // kommen — und dafür ist eine Arbitrage zu kurzlebig.
  assert.deepEqual(
    m.actions?.map((a) => a.label),
    ['Tipico', 'bwin'],
  )
  assert.equal(m.clickUrl, 'https://tipico.example/1')
})

test('hohe Renditen werden lauter gemeldet', () => {
  assert.equal(formatMessage(opp('a', 2.05)).priority, 'default')
  assert.equal(formatMessage(opp('a', 2.2)).priority, 'high')
})

test('Warnungen stehen in der Meldung', () => {
  const m = formatMessage(opp('a', 2.1, { warnings: ['overtime', 'push-line'] }))
  assert.match(m.body, /Achtung: Verlängerung prüfen · Ganze Linie/)
})
