import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchEvents, normalizeTeam, teamTokens } from './match.ts'
import type { CanonicalMarket, RawEvent, RawOutcome, Side } from './types.ts'

/**
 * Der Matcher ist die Stelle, an der ein Fehler Geld kostet statt nur Daten:
 * zwei verschiedene Partien zusammengeworfen oder eine Partie falsch herum
 * ausgerichtet ergibt eine Arbitrage, die es nicht gibt. Entsprechend liegt
 * der Schwerpunkt hier auf dem Ausrichten, nicht auf dem Gruppieren.
 */

const FT = { period: 'FT' as const, line: null, subject: null }

const oc = (market: CanonicalMarket, side: Side, odds: number): RawOutcome => ({ market, side, odds })

function ev(over: Partial<RawEvent> & Pick<RawEvent, 'bookmakerId' | 'home' | 'away'>): RawEvent {
  return {
    bookEventId: over.bookEventId ?? `${over.bookmakerId}-1`,
    sportradarId: null,
    sport: 'Fußball',
    league: 'Test',
    startTime: '2030-01-01T18:00:00.000Z',
    isLive: false,
    url: 'https://example.invalid',
    outcomes: [],
    fetchedAt: '2030-01-01T17:00:00.000Z',
    ...over,
  }
}

test('teamTokens entfernt Rechtsformen, Ziffern und Diakritika', () => {
  assert.deepEqual(teamTokens('1. FC Köln'), ['koln'])
  assert.deepEqual(teamTokens('MKS Pogoń Szczecin'), ['pogon', 'szczecin'])
  // Besteht ein Name nur aus Stoppwörtern, bleibt er lieber roh erhalten,
  // als zu nichts zu zerfallen — sonst würde er auf alles passen.
  assert.deepEqual(teamTokens('FC'), ['fc'])
})

test('normalizeTeam macht Zusätze im Vereinsnamen unerheblich', () => {
  assert.equal(normalizeTeam('Pogon Szczecin'), normalizeTeam('MKS Pogoń Szczecin'))
  assert.notEqual(normalizeTeam('Bayern München'), normalizeTeam('Bayer Leverkusen'))
})

test('Sportradar-ID gruppiert auch bei abweichender Schreibweise', () => {
  const { matched } = matchEvents([
    ev({ bookmakerId: 'a', home: 'Bayern München', away: 'Borussia Dortmund', sportradarId: 42 }),
    ev({ bookmakerId: 'b', home: 'FC Bayern', away: 'BV Borussia 09 Dortmund', sportradarId: 42 }),
  ])
  assert.equal(matched.length, 1)
  assert.equal(matched[0].sources.length, 2)
  assert.equal(matched[0].sportradarId, 42)
})

test('Quellen ohne ID docken an eine bestehende ID-Gruppe an', () => {
  // Kambi-Marken liefern keine Sportradar-ID. Ohne dieses Andocken blieben
  // sie für immer getrennt und fänden nie einen Gegenpart.
  const { matched } = matchEvents([
    ev({ bookmakerId: 'a', home: 'Bayern München', away: 'Borussia Dortmund', sportradarId: 42 }),
    ev({ bookmakerId: 'b', home: 'Bayern Munchen', away: 'Borussia Dortmund' }),
  ])
  assert.equal(matched.length, 1)
  assert.equal(matched[0].sources.length, 2)
})

test('Anstoßzeiten außerhalb des Fensters bilden getrennte Gruppen', () => {
  const { matched } = matchEvents([
    ev({ bookmakerId: 'a', home: 'Bayern', away: 'Dortmund', startTime: '2030-01-01T18:00:00.000Z' }),
    ev({ bookmakerId: 'b', home: 'Bayern', away: 'Dortmund', startTime: '2030-01-02T18:00:00.000Z' }),
  ])
  assert.equal(matched.length, 2)
})

test('gedrehte Quelle: Siegwette wird gespiegelt', () => {
  const { matched, stats } = matchEvents([
    ev({
      bookmakerId: 'anker',
      home: 'Cusco FC',
      away: 'Universitario',
      sportradarId: 7,
      // Der Anker ist die Quelle mit den meisten Märkten.
      outcomes: [
        oc({ type: '1X2', ...FT }, 'HOME', 2.0),
        oc({ type: '1X2', ...FT }, 'DRAW', 3.0),
        oc({ type: '1X2', ...FT }, 'AWAY', 4.0),
      ],
    }),
    ev({
      bookmakerId: 'gedreht',
      home: 'Universitario',
      away: 'Cusco FC',
      sportradarId: 7,
      outcomes: [oc({ type: '1X2', ...FT }, 'HOME', 3.9)],
    }),
  ])

  assert.equal(stats.flipped, 1)
  const src = matched[0].sources.find((s) => s.bookmakerId === 'gedreht')!
  // Die Heimquote der gedrehten Quelle gehört auf die Auswärtsseite des Ankers.
  assert.equal(src.outcomes[0].side, 'AWAY')
  assert.equal(src.outcomes[0].odds, 3.9)
  assert.equal(src.home, 'Cusco FC')
})

test('gedrehte Quelle: Handicap-Linie kehrt ihr Vorzeichen um', () => {
  const { matched } = matchEvents([
    ev({
      bookmakerId: 'anker',
      home: 'Cusco FC',
      away: 'Universitario',
      sportradarId: 7,
      outcomes: [
        oc({ type: 'EH', period: 'FT', line: 1, subject: null }, 'HOME', 2.0),
        oc({ type: 'EH', period: 'FT', line: 1, subject: null }, 'DRAW', 3.0),
      ],
    }),
    ev({
      bookmakerId: 'gedreht',
      home: 'Universitario',
      away: 'Cusco FC',
      sportradarId: 7,
      outcomes: [oc({ type: 'EH', period: 'FT', line: 1, subject: null }, 'HOME', 2.1)],
    }),
  ])

  const o = matched[0].sources.find((s) => s.bookmakerId === 'gedreht')!.outcomes[0]
  assert.equal(o.market.line, -1)
  assert.equal(o.side, 'AWAY')
})

test('gedrehte Quelle: auch das zweiwegige Handicap kehrt sein Vorzeichen um', () => {
  // Diesen Test gab es lange nur für `EH`, und genau dort schlüpfte der Fehler
  // durch: `flipOutcome` drehte die Linie ausschließlich beim dreiwegigen
  // Handicap. Solange zweiwegige Handicaps praktisch nur im Tennis vorkamen,
  // blieb es folgenlos. Im Basketball ist das Handicap der Hauptmarkt — dort
  // wurde damit ein Handicap auf die eine Mannschaft gegen eines auf die
  // andere gerechnet und als 32 % Rendite ausgewiesen.
  const { matched } = matchEvents([
    ev({
      bookmakerId: 'anker',
      home: 'Portland Fire',
      away: 'Indiana Fever',
      sportradarId: 11,
      outcomes: [
        oc({ type: 'AH', period: 'FT', line: -6.5, subject: null }, 'HOME', 5.5),
        oc({ type: 'AH', period: 'FT', line: -6.5, subject: null }, 'AWAY', 1.15),
      ],
    }),
    ev({
      bookmakerId: 'gedreht',
      home: 'Indiana Fever',
      away: 'Portland Fire',
      sportradarId: 11,
      outcomes: [oc({ type: 'AH', period: 'FT', line: -6.5, subject: null }, 'HOME', 1.75)],
    }),
  ])

  const o = matched[0].sources.find((s) => s.bookmakerId === 'gedreht')!.outcomes[0]
  assert.equal(o.market.line, 6.5, 'die Linie gehört nach dem Drehen auf die andere Seite')
  assert.equal(o.side, 'AWAY')
})

test('gedrehte Quelle: Team-Über/Unter wechselt das Team', () => {
  // Ohne diesen Tausch würde „Tore des Heimteams" der einen Quelle gegen
  // „Tore des Auswärtsteams" der anderen gerechnet — verschiedene Wetten.
  const { matched } = matchEvents([
    ev({
      bookmakerId: 'anker',
      home: 'Cusco FC',
      away: 'Universitario',
      sportradarId: 7,
      outcomes: [
        oc({ type: 'TEAM_OU', period: 'FT', line: 1.5, subject: 'HOME' }, 'OVER', 2.0),
        oc({ type: 'TEAM_OU', period: 'FT', line: 1.5, subject: 'HOME' }, 'UNDER', 1.8),
      ],
    }),
    ev({
      bookmakerId: 'gedreht',
      home: 'Universitario',
      away: 'Cusco FC',
      sportradarId: 7,
      outcomes: [oc({ type: 'TEAM_OU', period: 'FT', line: 1.5, subject: 'HOME' }, 'OVER', 2.2)],
    }),
  ])

  const o = matched[0].sources.find((s) => s.bookmakerId === 'gedreht')!.outcomes[0]
  assert.equal(o.market.subject, 'AWAY')
  // Über/Unter hat keine Heim/Auswärts-Seite — die Seite bleibt unberührt.
  assert.equal(o.side, 'OVER')
})

test('unklare Ausrichtung wird verworfen, nicht geraten', () => {
  const { matched, stats } = matchEvents([
    ev({
      bookmakerId: 'anker',
      home: 'Alpha',
      away: 'Beta',
      sportradarId: 7,
      outcomes: [oc({ type: '1X2', ...FT }, 'HOME', 2)],
    }),
    ev({ bookmakerId: 'fremd', home: 'Gamma', away: 'Delta', sportradarId: 7 }),
  ])
  assert.equal(stats.dropped, 1)
  assert.equal(matched[0].sources.length, 1)
})

test('Live-Zustand kommt aus der Anstoßzeit, nicht aus den Flags', () => {
  // Tipico markiert nahezu jedes Event als „running", Betano liefert das Feld
  // gar nicht — nur die Anstoßzeit ist über alle Quellen belastbar.
  const past = new Date(Date.now() - 60_000).toISOString()
  const { matched } = matchEvents([
    ev({ bookmakerId: 'a', home: 'Alpha', away: 'Beta', startTime: past, isLive: false }),
  ])
  assert.equal(matched[0].isLive, true)

  const future = new Date(Date.now() + 3_600_000).toISOString()
  const { matched: later } = matchEvents([
    ev({ bookmakerId: 'a', home: 'Alpha', away: 'Beta', startTime: future, isLive: true }),
  ])
  assert.equal(later[0].isLive, false)
})

test('nordische Sonderbuchstaben zerfallen nicht in Buchstabensalat', () => {
  // æ, ø, ð sind keine Diakritika: sie überleben das NFD und wurden danach zu
  // Leerzeichen zerhackt. "Stabæk" wurde zu ["stab", "k"] und fand seinen
  // eigenen Gegenpart "Stabaek IF" nie — beobachtet über zehn Buchmacher.
  assert.deepEqual(teamTokens('Stabæk'), ['stabaek'])
  assert.deepEqual(teamTokens('Hødd'), ['hodd'])
  assert.deepEqual(teamTokens('Breiðablik'), ['breidablik'])
  assert.equal(normalizeTeam('Stabæk'), normalizeTeam('Stabaek'))
})

test('Stabæk findet Stabaek IF trotz zusätzlichem Wort', () => {
  // Die Transliteration allein genügt nicht: "Stabæk Fotball" normalisiert zu
  // "stabaekfotball", nicht zu "stabaek". Erst das tolerante Andocken bringt
  // beide zusammen — die zehn Bücher dieser Partie lagen zuvor in zwei Töpfen.
  const { matched } = matchEvents([
    ev({ bookmakerId: 'a', home: 'Stabaek IF', away: 'Hödd', sportradarId: 3 }),
    ev({ bookmakerId: 'b', home: 'Stabæk Fotball', away: 'IL Hødd' }),
  ])
  assert.equal(matched.length, 1)
  assert.equal(matched[0].sources.length, 2)
})

test('Namenszusätze verhindern das Andocken nicht mehr', () => {
  // Vorher forderte Durchgang 2 exakte Signaturgleichheit. Jeder Zusatz —
  // "Deportes", "Riga", "Manizales" — trennte dieselbe Partie in zwei Gruppen,
  // und beide Hälften hatten dann zu wenig Bücher für einen Vergleich.
  const { matched } = matchEvents([
    ev({ bookmakerId: 'a', home: 'Deportes Concepcion', away: "O'Higgins FC", sportradarId: 7 }),
    ev({ bookmakerId: 'b', home: 'Concepción', away: "O'Higgins" }),
  ])
  assert.equal(matched.length, 1)
  assert.equal(matched[0].sources.length, 2)
})

test('eine starke und eine schwache Seite reichen nicht zum Andocken', () => {
  // Der Grund für das Minimum statt der Summe: LeoVegas führt eSports als
  // "Barcelona (Spieler) vs Real Madrid (Spieler)". Über die Summe zöge das
  // gemeinsame "barcelona" die Partien zusammen — und der Scanner rechnete
  // FIFA-Quoten gegen echten Fußball.
  const { matched } = matchEvents([
    ev({ bookmakerId: 'echt', home: 'Barcelona SC', away: 'LDU Quito', sportradarId: 11 }),
    ev({ bookmakerId: 'esport', home: 'Barcelona', away: 'Real Madrid' }),
  ])
  assert.equal(matched.length, 2)
})

/* ------------------------------------------------------------------ Tennis */

test('Tennis: abgekürzte und ausgeschriebene Spielernamen finden zusammen', () => {
  // Der Fall, an dem der Vereinsabgleich scheitert: beide Namen teilen genau
  // ein Wort. Abgemessen — Sportwetten.de schreibt "Gibson, Talia", Kambi
  // dieselbe Partie als "Talia Gibson", und Kambi liefert keine Sportradar-ID,
  // die den Namen ersetzen könnte.
  const start = new Date(Date.now() + 4 * 3600_000).toISOString()
  const { matched } = matchEvents([
    ev({ bookmakerId: 'sportwettende', sport: 'Tennis', home: 'Gibson, Talia', away: 'Maria, Tatjana', startTime: start, sportradarId: 73148794 }),
    ev({ bookmakerId: 'leovegas', sport: 'Tennis', home: 'Talia Gibson', away: 'Tatjana Maria', startTime: start, sportradarId: null }),
  ])
  assert.equal(matched.length, 1)
  assert.equal(matched[0].sources.length, 2)
})

test('Tennis: Doppel finden über die Reihenfolge hinweg zusammen', () => {
  const start = new Date(Date.now() + 4 * 3600_000).toISOString()
  const { matched } = matchEvents([
    ev({ bookmakerId: 'sportwettende', sport: 'Tennis', home: 'Errani S / Melichar-Martinez N', away: 'Boulter K / Iatcenko P', startTime: start, sportradarId: 73163220 }),
    ev({ bookmakerId: 'leovegas', sport: 'Tennis', home: 'N. Melichar-Martinez/S. Errani', away: 'P. Iatcenko/K. Boulter', startTime: start, sportradarId: null }),
  ])
  assert.equal(matched.length, 1)
  assert.equal(matched[0].sources.length, 2)
})

test('Tennis: Geschwister werden nicht zusammengeworfen', () => {
  // Über Wortmengen sind "Zverev A." und Mischa Zverev nicht zu trennen. Wer
  // hier danebengreift, rechnet die Quoten zweier verschiedener Partien
  // gegeneinander — der teuerste Fehler, den das Matching machen kann.
  const start = new Date(Date.now() + 4 * 3600_000).toISOString()
  const { matched } = matchEvents([
    ev({ bookmakerId: 'a', sport: 'Tennis', home: 'Zverev A.', away: 'Sinner J.', startTime: start, sportradarId: null }),
    ev({ bookmakerId: 'b', sport: 'Tennis', home: 'Mischa Zverev', away: 'Jannik Sinner', startTime: start, sportradarId: null }),
  ])
  assert.equal(matched.length, 2, 'zwei verschiedene Partien, zwei Gruppen')
})

test('eine Tennispartie dockt nie an einer Fußballgruppe an', () => {
  // Gleiche Namen, gleiche Anstoßzeit, verschiedene Sportarten. Ohne die
  // Sportart im Gruppenschlüssel würden hier Tennisquoten gegen Fußballquoten
  // gerechnet.
  const start = new Date(Date.now() + 4 * 3600_000).toISOString()
  const { matched } = matchEvents([
    ev({ bookmakerId: 'a', sport: 'Fußball', home: 'Bayern München', away: 'Real Madrid', startTime: start, sportradarId: null }),
    ev({ bookmakerId: 'b', sport: 'Tennis', home: 'Bayern München', away: 'Real Madrid', startTime: start, sportradarId: null }),
  ])
  assert.equal(matched.length, 2)
  for (const m of matched) assert.equal(m.sources.length, 1)
})
