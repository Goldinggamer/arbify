import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nameMatch, parseName, playerMatch } from './players.ts'

/**
 * Spielernamen sind die fehleranfälligste Stelle beim Tennis-Matching: es gibt
 * keine Sportradar-ID bei Kambi, Winamax und NEO.bet, die Partien werden also
 * über den Namen zusammengeführt. Und die Bücher schreiben ihn verschieden —
 * die drei Formen unten sind alle abgemessen, nicht ausgedacht:
 *
 *   Kambi          "Alex Hernandez"
 *   bwin           "Alex Hernandez (MEX)"
 *   Sportwetten.de "Zarazua, Renata"
 *   NEO.bet        "De Minaur, Alex"
 */

const yes = (a: string, b: string) =>
  assert.ok(playerMatch(a, b) > 0, `"${a}" und "${b}" müssten zusammenfinden`)
const no = (a: string, b: string) =>
  assert.equal(playerMatch(a, b), 0, `"${a}" und "${b}" dürfen NICHT zusammenfinden`)

test('abgekürzter und ausgeschriebener Vorname sind dieselbe Person', () => {
  yes('Alcaraz C.', 'Carlos Alcaraz')
  yes('C. Alcaraz', 'Alcaraz, Carlos')
  yes('Djokovic N.', 'Novak Djokovic')
  yes('Swiatek I.', 'Iga Swiatek')
  yes('Medvedev D.', 'Daniil Medvedev')
})

test('das Länderkürzel der Entain-Marken trennt keine Namen', () => {
  // bwin schreibt "Alex Hernandez (MEX)", Kambi denselben Spieler ohne Zusatz.
  // Bliebe "(MEX)" ein Namenswort, fänden die beiden Bücher nie zusammen.
  yes('Alex Hernandez (MEX)', 'Alex Hernandez')
  yes('Bernard Tomic (AUS)', 'Tomic B.')
  assert.deepEqual(parseName('Alex Hernandez (MEX)').words, ['alex', 'hernandez'])
})

test('mehrteilige Nachnamen und Bindestriche überstehen den Abgleich', () => {
  yes('Auger-Aliassime F.', 'Felix Auger-Aliassime')
  yes('Bautista Agut R.', 'Roberto Bautista Agut')
  yes('Davidovich Fokina A.', 'Alejandro Davidovich Fokina')
  yes('de Minaur A.', 'Alex de Minaur')
  yes('De Minaur, Alex', 'Alex de Minaur')
  // "Nadal Parera" ist der volle Nachname — zusätzliche Nachnamenswörter auf
  // einer Seite dürfen den Treffer nicht kosten.
  yes('Nadal R.', 'Rafael Nadal Parera')
})

test('zwei Initialen werden beide geprüft', () => {
  yes('Etcheverry T.M.', 'Tomas Martin Etcheverry')
  yes('Cerundolo J.M.', 'Juan Manuel Cerundolo')
})

test('eine widersprechende Initiale schlägt den Treffer aus', () => {
  // Der teuerste Fall im ganzen Modul. Über Wortmengen sind die Brüder
  // ununterscheidbar (beide 0,50), bei Cerundolo gewann sogar der falsche
  // (Francisco 0,50 gegen Juan Manuel 0,33). Wer hier danebengreift, rechnet
  // die Quoten zweier verschiedener Partien gegeneinander.
  no('Zverev A.', 'Mischa Zverev')
  no('Zverev M.', 'Alexander Zverev')
  no('Cerundolo J.M.', 'Francisco Cerundolo')
  no('Cerundolo F.', 'Juan Manuel Cerundolo')
  no('Murray A.', 'Jamie Murray')

  // Gegenprobe: der jeweils richtige Bruder findet weiterhin zusammen.
  yes('Zverev A.', 'Alexander Zverev')
  yes('Cerundolo J.M.', 'Juan Manuel Cerundolo')
})

test('ein anderer Nachname ist eine andere Person, egal wie gut der Vorname passt', () => {
  no('Alcaraz C.', 'Carlos Moya')
  no('Djokovic N.', 'Novak Nikolic')
})

test('Doppel finden über Kreuz zusammen', () => {
  // Die Reihenfolge der beiden Spieler ist nicht zugesagt.
  yes('Bolelli/Vavassori', 'Simone Bolelli / Andrea Vavassori')
  yes('Granollers M. / Zeballos H.', 'Marcel Granollers/Horacio Zeballos')
  yes('R. Ram/J. Salisbury', 'Joe Salisbury / Rajeev Ram')

  // Ein ausgetauschter Partner ist eine andere Paarung.
  no('Bolelli/Vavassori', 'Simone Bolelli / Marcel Granollers')
  // Einzel gegen Doppel ist nie dasselbe.
  no('Bolelli/Vavassori', 'Simone Bolelli')
})

test('bestätigte Initialen ranken vor unbestätigten', () => {
  // Die Abstufung entscheidet, welcher Kandidat gewinnt, wenn mehrere passen.
  assert.ok(nameMatch('Alcaraz C.', 'Carlos Alcaraz') > nameMatch('Alcaraz C.', 'Alcaraz C.'))
  assert.ok(nameMatch('Alcaraz C.', 'Alcaraz C.') > 0)
})
