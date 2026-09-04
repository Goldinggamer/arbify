import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allocateDepth, istVerbindungsabbruch, versuchen } from './store.ts'

/**
 * Das Tiefenbudget ist knapp und teuer: eine Tiefenabfrage kostet bei bwin
 * rund 170 kB, und die Obergrenze schützt vor den Sperren der Anbieter. Wie es
 * verteilt wird, entscheidet also unmittelbar über die Vergleichsfläche.
 */

const ev = (sport: string, minutesFromNow: number, id: string) => ({
  sport,
  id,
  startTime: new Date(Date.now() + minutesFromNow * 60_000).toISOString(),
})

/** Wie viele Kandidaten je Sportart in der Auswahl gelandet sind. */
const countBySport = (list: { sport: string }[]) => {
  const n = new Map<string, number>()
  for (const e of list) n.set(e.sport, (n.get(e.sport) ?? 0) + 1)
  return n
}

test('eine Sportart allein bekommt das ganze Budget', () => {
  const targets = Array.from({ length: 200 }, (_, i) => ev('Fußball', i, `f${i}`))
  const got = allocateDepth(targets, 120)
  assert.equal(got.length, 120)
  assert.equal(countBySport(got).get('Fußball'), 120)
})

test('eine kleine Sportart verschenkt nichts an Budget', () => {
  // Der Normalfall: Tennis hat bei einem Buch deutlich weniger vergleichbare
  // Partien als Fußball. Es darf nicht die Hälfte des Budgets blockieren.
  const targets = [
    ...Array.from({ length: 300 }, (_, i) => ev('Fußball', 500 + i, `f${i}`)),
    ...Array.from({ length: 20 }, (_, i) => ev('Tennis', i, `t${i}`)),
  ]
  const got = allocateDepth(targets, 120)
  const n = countBySport(got)
  assert.equal(got.length, 120)
  assert.equal(n.get('Tennis'), 20, 'Tennis bekommt alle seine Kandidaten')
  assert.equal(n.get('Fußball'), 100, 'der Rest geht an Fußball')
})

test('bei reichlich Kandidaten teilen sich die Sportarten gleichmäßig', () => {
  const targets = [
    ...Array.from({ length: 300 }, (_, i) => ev('Fußball', 500 + i, `f${i}`)),
    ...Array.from({ length: 300 }, (_, i) => ev('Tennis', i, `t${i}`)),
  ]
  const n = countBySport(allocateDepth(targets, 120))
  assert.equal(n.get('Fußball'), 60)
  assert.equal(n.get('Tennis'), 60)
})

test('die frühe Anstoßzeit einer Sportart verdrängt die andere nicht mehr', () => {
  // Das war der gemessene Fehler: Tennis wird über den Tag verteilt angesetzt,
  // Fußball geballt am Abend. Global nach Anstoß sortiert und abgeschnitten,
  // war das Budget vorne von Tennis aufgebraucht — bei bwin fiel die Tiefe
  // dadurch von 120 auf 55 vertiefte Partien.
  const targets = [
    ...Array.from({ length: 200 }, (_, i) => ev('Tennis', i, `t${i}`)),
    ...Array.from({ length: 200 }, (_, i) => ev('Fußball', 1000 + i, `f${i}`)),
  ]
  const n = countBySport(allocateDepth(targets, 120))
  assert.equal(n.get('Fußball'), 60, 'Fußball verliert nicht, nur weil es später anpfeift')
  assert.equal(n.get('Tennis'), 60)
})

test('innerhalb einer Sportart entscheidet weiterhin der Anstoß', () => {
  const targets = [
    ev('Fußball', 900, 'spaet'),
    ev('Fußball', 10, 'frueh'),
    ev('Fußball', 400, 'mitte'),
  ]
  assert.deepEqual(
    allocateDepth(targets, 2).map((e) => e.id),
    ['frueh', 'mitte'],
  )
})

test('die Auswahl kommt reihum gemischt, nicht nach Sportart geblockt', () => {
  // Winamax deckelt die übergebene Liste intern noch einmal bei 60. Käme sie
  // nach Sportart sortiert, bekäme dieser Adapter ausschließlich die
  // alphabetisch erste — der ganze Sinn der Aufteilung wäre dahin.
  const targets = [
    ...Array.from({ length: 10 }, (_, i) => ev('Fußball', i, `f${i}`)),
    ...Array.from({ length: 10 }, (_, i) => ev('Tennis', i, `t${i}`)),
  ]
  const got = allocateDepth(targets, 20)
  const ersteVier = countBySport(got.slice(0, 4))
  assert.equal(ersteVier.get('Fußball'), 2)
  assert.equal(ersteVier.get('Tennis'), 2)
})

test('ein Budget kleiner als die Zahl der Sportarten verteilt reihum', () => {
  const targets = [ev('Fußball', 1, 'f'), ev('Tennis', 1, 't'), ev('Handball', 1, 'h')]
  assert.equal(allocateDepth(targets, 1).length, 1)
  assert.equal(allocateDepth(targets, 2).length, 2)
})

test('leere Eingabe und Budget null liefern nichts', () => {
  assert.deepEqual(allocateDepth([], 120), [])
  assert.deepEqual(allocateDepth([ev('Fußball', 1, 'f')], 0), [])
})

test('es werden nie mehr Kandidaten zurückgegeben als vorhanden', () => {
  const targets = [ev('Fußball', 1, 'f'), ev('Tennis', 1, 't')]
  assert.equal(allocateDepth(targets, 500).length, 2)
})

/* ------------------------------------------------ Abgerissene Verbindungen */

/**
 * Ein Abriss der Dauerverbindung kostete bisher das ganze Buch für den
 * Durchlauf — `sweep` gibt bei einer Ausnahme `events: []` zurück. Beim
 * Aufwachen des Rechners passiert das zuverlässig bei allen dreien.
 */

const buch = (transport: 'websocket' | 'impit') =>
  ({ id: 'x', name: 'X', transport, fetchEvents: async () => [] }) as any

const echteMeldungen = [
  'Verbindung geschlossen',
  'LiveDoc: Verbindung geschlossen',
  'ASW: Verbindung geschlossen',
  'Antwort auf rid 540 überschritten',
  'LiveDoc: keine Antwort auf eventmap/upcomingTNS',
  'ASW: keine Antwort auf RetrieveSportsbookView',
  'LiveDoc: Gegenstelle hat geschlossen (1006)',
  'Verbindung nicht offen',
]

test('alle Abbruchmeldungen der drei Transporte werden erkannt', () => {
  for (const m of echteMeldungen)
    assert.equal(istVerbindungsabbruch(new Error(m)), true, m)
})

test('ein inhaltlicher Fehler ist kein Abbruch', () => {
  // Sonst würde jeder Mapping- oder Parserfehler doppelt so teuer.
  assert.equal(istVerbindungsabbruch(new Error('Ungültiges JSON von https://…')), false)
  assert.equal(istVerbindungsabbruch(new Error('HTTP 403 für https://…')), false)
})

test('nach einem Abriss wird genau einmal wiederholt', async () => {
  let rufe = 0
  let grund: string | undefined
  const wert = await versuchen(
    buch('websocket'),
    async () => {
      if (++rufe === 1) throw new Error('LiveDoc: Verbindung geschlossen')
      return 'da'
    },
    (g) => (grund = g),
  )
  assert.equal(wert, 'da')
  assert.equal(rufe, 2)
  assert.equal(grund, 'LiveDoc: Verbindung geschlossen')
})

test('ein zweiter Abriss wird durchgereicht statt endlos wiederholt', async () => {
  let rufe = 0
  await assert.rejects(
    versuchen(buch('websocket'), async () => {
      rufe++
      throw new Error('Verbindung geschlossen')
    }),
    /Verbindung geschlossen/,
  )
  assert.equal(rufe, 2)
})

test('HTTP-Adapter wiederholen hier nicht — das tut bereits fetchText', async () => {
  let rufe = 0
  await assert.rejects(
    versuchen(buch('impit'), async () => {
      rufe++
      throw new Error('Verbindung geschlossen')
    }),
  )
  assert.equal(rufe, 1)
})
