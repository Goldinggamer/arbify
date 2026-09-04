import { test } from 'node:test'
import assert from 'node:assert/strict'
import { marketKey } from '../types.ts'
import { resetDiagnostics, unmappedReport } from '../diagnostics.ts'
import { toMarket as kambiMarket } from './kambi.ts'
import { toMarket as winamaxMarket } from './winamax.ts'
import { toMarket as bcMarket } from './betconstruct.ts'
import { toMarket as tipicoMarket } from './tipico.ts'
import { toMarket as bwinMarket } from './bwin.ts'
import { toOutcomes as betanoToOutcomes } from './betano.ts'
import { toTennisMarket as winamaxTennis, toSide as winamaxSide } from './winamax.ts'
import { toTennisMarket as tipicoTennis } from './tipico.ts'
import { toTennisMarket as bcTennisMarket } from './betconstruct.ts'

/** VBET legt die Handicap-Linie am Heim-Outcome ab, nicht am Markt. */
const bcTennis = (type: string, name: string, base?: number, homeBase?: number) =>
  bcTennisMarket(
    {
      id: 1,
      type,
      name,
      base: base ?? null,
      event: homeBase === undefined ? {} : { '1': { type: 'Home', base: homeBase } },
    },
    'vbet',
  )

/**
 * Marktzuordnung der Adapter.
 *
 * Jede Beschriftung in dieser Datei ist **abgemessen**, nicht angenommen: sie
 * stammt aus einem Abruf gegen den echten Endpunkt. Das ist der Punkt der
 * Übung — die Muster sind der Teil des Systems, der lautlos ausfällt.
 *
 * Zwei Fehlerbilder gibt es, und beide sind hier vertreten:
 *
 *  - Ein Muster **greift nie**. So fehlte gerade/ungerade bei Kambi und bei
 *    Winamax vollständig: Kambi schreibt "Gesamttore ungerade/gerade", das
 *    Muster prüfte auf "gerade/ungerade" allein; Winamax schreibt "Anzahl
 *    **der** Tore", das Muster verlangte "Anzahl Tore". Beide Male stand kein
 *    falscher Wert im Bestand, es stand gar keiner — und weil die Meldung an
 *    `/api/diagnostics` erst hinter dem Zweig kommt, tauchte die Lücke dort
 *    nicht auf. Nur ein Test gegen die echte Beschriftung findet das.
 *  - Ein Muster greift **zu weit** und zieht einen fremden Markt herein. Das
 *    ist der teurere Fall, weil daraus Phantom-Arbitrage entsteht. Zu jeder
 *    Zuordnung steht deshalb der Nachbarmarkt daneben, der gerade nicht
 *    mitgehen darf.
 */

const key = (m: unknown) => (m ? marketKey(m as Parameters<typeof marketKey>[0]) : null)

// ---------------------------------------------------------------- Kambi

/** Kambi liefert Linien als Ganzzahl mal 1000. */
const kambi = (label: string, line?: number, type = 'Mehr als/Weniger als') =>
  kambiMarket(
    { id: 1, eventId: 1, criterion: { label }, betOfferType: { name: type } },
    line === undefined ? {} : { line: line * 1000 },
    'Palmeiras-SP',
    'Atlético Mineiro-MG',
    'leovegas',
  )

test('Kambi: die Gesamttore-Familie trennt Über/Unter von der Parität', () => {
  // Beide Beschriftungen beginnen mit "Gesamttore". Wird die Parität nicht
  // zuerst geprüft, fällt sie in den Über/Unter-Zweig, findet dort keine Linie
  // und verschwindet lautlos.
  assert.equal(key(kambi('Gesamttore', 3.5)), 'OU|FT|-|3.5')
  assert.equal(key(kambi('Gesamttore – 2. Hälfte', 0.5)), 'OU|H2|-|0.5')
  assert.equal(key(kambi('Gesamttore ungerade/gerade', undefined, 'Ungerade/Gerade')), 'OE|FT|-|-')
  assert.equal(key(kambi('Gesamttore gerade/ungerade', undefined, 'Ungerade/Gerade')), 'OE|FT|-|-')
})

test('Kambi: beide Teams treffen kennt die Halbzeiten', () => {
  assert.equal(key(kambi('Beide Teams treffen', undefined, 'Ja/Nein')), 'BTTS|FT|-|-')
  assert.equal(key(kambi('Beide Teams treffen – 1. Halbzeit', undefined, 'Ja/Nein')), 'BTTS|H1|-|-')
  assert.equal(key(kambi('Beide Teams treffen – 2. Hälfte', undefined, 'Ja/Nein')), 'BTTS|H2|-|-')

  // Nachbarmarkt: "in beiden Hälften" ist eine ganz andere Wette (Ja stand bei
  // bwin auf 11,00 gegen 1,58) und darf nicht als Ganzspiel-BTTS durchgehen.
  assert.equal(kambi('Beide Teams treffen in beiden Hälften', undefined, 'Ja/Nein'), null)
})

test('Kambi: das Drei-Wege-Handicap hat zwei Schreibweisen, das Zwei-Wege-Handicap keine Zuordnung', () => {
  assert.equal(key(kambi('Drei-Wege-Handicap', 1, '3-Wege-Handicap')), 'EH|FT|-|1')
  assert.equal(key(kambi('3-Wege Handicap - 1. Hälfte', 1, '3-Wege-Handicap')), 'EH|H1|-|1')

  // Das Kriterium "Handicap" ohne Zusatz ist die zweiwegige asiatische Linie
  // (nur OT_ONE und OT_TWO, kein OT_CROSS). Andere Auszahlungsregeln, darf
  // nicht ins europäische Handicap.
  assert.equal(kambi('Handicap', 0.5, 'Handicap'), null)
})

// -------------------------------------------------------------- Winamax

const winamax = (betTitle: string, template: string, special?: string) =>
  winamaxMarket(
    { betId: 1, matchId: 1, betTitle, template, specialBetValue: special },
    'New York City FC',
    'Toronto FC',
  )

test('Winamax: gerade/ungerade heißt "Anzahl der Tore"', () => {
  assert.equal(key(winamax('Anzahl der Tore - Gerade/Ungerade', '2way')), 'OE|FT|-|-')
  assert.equal(key(winamax('1. Halbzeit - Anzahl der Tore - Gerade/Ungerade', '2way')), 'OE|H1|-|-')

  // Nachbarmarkt: die Parität eines **einzelnen** Teams. Das Modell kennt bei
  // OE kein `subject`; als Gesamtparität verbucht wäre sie eine falsche
  // Meldung.
  assert.equal(winamax('Anzahl der Tore von Toronto FC - Gerade/Ungerade', '2way'), null)
})

test('Winamax: beide Titel für beide Teams treffen führen auf denselben Schlüssel', () => {
  // Übersicht und Detailseite benennen dieselbe Wette verschieden.
  assert.equal(key(winamax('Schießen beide Mannschaften ein Tor?', '2way')), 'BTTS|FT|-|-')
  assert.equal(key(winamax('Beide Mannschaften treffen', '2way')), 'BTTS|FT|-|-')
  assert.equal(key(winamax('1. Halbzeit - Beide Mannschaften treffen', '2way')), 'BTTS|H1|-|-')
})

test('Winamax: das Team-Total der Halbzeit ist anders benannt als das des Ganzspiels', () => {
  // Ganzspiel: "Anzahl Tore von X". Halbzeit: "1. Halbzeit - Anzahl der Tore X".
  assert.equal(key(winamax('Anzahl Tore von Toronto FC', 'OverUnder', 'total=1.5')), 'TEAM_OU|FT|AWAY|1.5')
  assert.equal(
    key(winamax('1. Halbzeit - Anzahl der Tore Toronto FC', 'OverUnder', 'total=1.5')),
    'TEAM_OU|H1|AWAY|1.5',
  )
  assert.equal(
    key(winamax('1. Halbzeit - Anzahl der Tore New York City FC', 'OverUnder', 'total=0.5')),
    'TEAM_OU|H1|HOME|0.5',
  )

  // Ein fremder Name gehört zu keinem der beiden Teams — verwerfen, nicht raten.
  assert.equal(winamax('1. Halbzeit - Anzahl der Tore FC Cincinnati', 'OverUnder', 'total=1.5'), null)
})

test('Winamax: ganzzahlige Torlinien bleiben erhalten', () => {
  // Früher verworfen, weil bei genau N Toren der Einsatz zurückkommt. Das
  // stimmt, macht die Linie aber nicht unvergleichbar: liegen beide Beine auf
  // derselben ganzen Linie, ist der Push der einzige Ausgang ohne Rendite —
  // und er kostet nichts. Verworfen hat der Filter dagegen echte
  // Vergleichsfläche: AdmiralBet und VBET führen dieselben Linien, Über/Unter
  // 1,0 kam damit auf null buchübergreifende Vergleiche.
  assert.equal(key(winamax('Anzahl Tore', 'OverUnder', 'total=1')), 'OU|FT|-|1')
  assert.equal(key(winamax('Anzahl Tore', 'OverUnder', 'total=2')), 'OU|FT|-|2')
  assert.equal(
    key(winamax('1. Halbzeit - Anzahl der Tore Toronto FC', 'OverUnder', 'total=1')),
    'TEAM_OU|H1|AWAY|1',
  )

  // Die halben Linien bleiben unberührt und fallen weiterhin auf eigene Schlüssel.
  assert.equal(key(winamax('Anzahl Tore', 'OverUnder', 'total=1.5')), 'OU|FT|-|1.5')
})

test('Winamax: Kombiwetten tragen die Namen echter Märkte und gehen trotzdem nicht durch', () => {
  assert.equal(winamax('Ergebnis und Anzahl Tore', 'ListOdd', 'total=2.5'), null)
  assert.equal(winamax('Doppelte Chance und beide Mannschaften treffen', 'ListOdd'), null)
  assert.equal(winamax('1. Tor und Ergebnis', 'ListOdd'), null)

  // Die Grundmärkte bleiben davon unberührt.
  assert.equal(key(winamax('Anzahl Tore', 'OverUnder', 'total=2.5')), 'OU|FT|-|2.5')
  assert.equal(key(winamax('Ergebnis', '3way')), '1X2|FT|-|-')
})

// --------------------------------------------------------- BetConstruct

/** BetConstruct legt die Handicap-Linie am Outcome ab, nicht am Markt. */
const bc = (type: string, name: string, opts: { base?: number; homeBase?: number } = {}) =>
  bcMarket(
    {
      id: 1,
      type,
      name,
      base: opts.base ?? null,
      event: opts.homeBase === undefined ? {} : { '1': { type: 'Home', base: opts.homeBase } },
    },
    'vbet',
  )

test('BetConstruct: die Halbzeit steht im Typnamen, nicht nur im deutschen Marktnamen', () => {
  assert.equal(key(bc('1stHalfBothTeamsToScore', '1. Halbzeit: Beide Teams treffen')), 'BTTS|H1|-|-')
  assert.equal(key(bc('2ndHalfBothTeamsToScore', '2. Halbzeit: Beide Teams treffen')), 'BTTS|H2|-|-')

  // Dieselben Typen mit englischem Marktnamen — die Zuordnung darf nicht an
  // der Sprache der Sitzung hängen.
  assert.equal(key(bc('1stHalfBothTeamsToScore', '1st Half: Both Teams To Score')), 'BTTS|H1|-|-')
})

test('BetConstruct: dritte Schreibweise für gerade/ungerade', () => {
  assert.equal(key(bc('EvenOddTotal', 'Gesamttore Ungerade/Gerade')), 'OE|FT|-|-')
  assert.equal(key(bc('TotalEvenOdd', 'Gesamttore Ungerade/Gerade')), 'OE|FT|-|-')
})

test('BetConstruct: das Handicap der ersten Hälfte liest die Linie aus dem Heim-Outcome', () => {
  // Am Markt steht base=1, am Heim-Outcome base=-1. Maßgeblich ist die
  // Heimsicht; wer market.base nimmt, dreht das Vorzeichen.
  assert.equal(key(bc('FirstHalfHandicap', '1. Halbzeit: Tore Handicap (3-Wege)', { base: 1, homeBase: -1 })), 'EH|H1|-|-1')
  assert.equal(key(bc('Handicap', 'Handicap (3-Wege)', { base: 2, homeBase: -2 })), 'EH|FT|-|-2')
})

test('BetConstruct: "Team trifft" bleibt bewusst unzugeordnet', () => {
  // Inhaltlich ist "Team 1 trifft" dasselbe wie Team-Über/Unter 0,5. Zugeordnet
  // war es deshalb auch — und wurde zurückgenommen: VBET liefert für dieselbe
  // Partie **beide** Formen, sie fallen auf denselben Schlüssel, und damit
  // stehen zwei Quoten desselben Buchmachers auf derselben Seite (gemessen 80
  // bzw. 96 Kollisionen je Lauf). Vergleichsfläche kommt dabei keine hinzu,
  // der Schlüssel existiert schon über `Team1OverUnder`; die Kollisionszählung
  // verliert aber ihre Aussagekraft.
  assert.equal(bc('Team1ScoreYes/no', 'Team 1 trifft'), null)
  assert.equal(bc('Team2ScoreYes/No', 'Team 2 trifft'), null)
  assert.equal(bc('Team1ScoreBothInHalvesYes/no', 'Team 1 trifft in beiden Halbzeiten'), null)

  // Die Über/Unter-Form, die VBET ohnehin liefert, bleibt zugeordnet.
  assert.equal(key(bc('Team1OverUnder', 'Team 1. Gesamttore', { base: 0.5 })), 'TEAM_OU|FT|HOME|0.5')
})

// --------------------------------------------------------------- Tipico

const TEAMS = { home: 'Randers FC', away: 'Silkeborg IF' }
const tipico = (type: string, caption: string, fixedParam?: string, section?: number) =>
  tipicoMarket(type, fixedParam, section, caption, TEAMS)

test('Tipico: "Tor <Team> ?" ist das Team-Total über 0,5', () => {
  // Derselbe Markt, den VBET als `Team1ScoreYes/no` führt. Beide müssen auf
  // denselben Schlüssel fallen, sonst werden sie nie gegeneinander gerechnet.
  assert.equal(key(tipico('team-scores', 'Tor Randers FC ?')), 'TEAM_OU|FT|HOME|0.5')
  assert.equal(key(tipico('team-scores', 'Tor Silkeborg IF ?')), 'TEAM_OU|FT|AWAY|0.5')
  assert.equal(key(tipico('team-scores-halftime', 'Tor Randers FC 1.HZ?')), 'TEAM_OU|H1|HOME|0.5')
  assert.equal(key(tipico('team-scores-halftime', 'Tor Silkeborg IF 2.HZ?')), 'TEAM_OU|H2|AWAY|0.5')

  // Ohne Beschriftung ist die Seite nicht bestimmbar — verwerfen statt raten.
  assert.equal(tipico('team-scores', ''), null)
  // Halbzeit-Typ ohne Halbzeitangabe: nicht als Ganzspiel durchwinken.
  assert.equal(tipico('team-scores-halftime', 'Tor Randers FC ?'), null)
})

test('Tipico: die bestehenden Team-Totals bleiben unberührt', () => {
  assert.equal(key(tipico('team-points-more-less', 'Randers FC', '1:2.5')), 'TEAM_OU|FT|HOME|2.5')
  assert.equal(key(tipico('standard', '')), '1X2|FT|-|-')
})

// -------------------------------------------------------------- Betano

/**
 * Betano bündelt **alle** Torgrenzen in einem Marktobjekt: `HCTG` trägt
 * `handicap: 0.5`, darunter hängen vierzehn Auswahlmöglichkeiten von "Über 0,5"
 * bis "Unter 6,5", jede mit eigener `handicap`-Angabe. Wer die Linie am Markt
 * abliest, schreibt "Über 6,5" als "Über 0,5" in den Bestand.
 */
const betanoOutcomes = (market: Record<string, unknown>, teams = { home: 'Lyngby BK', away: 'Aarhus GF' }) =>
  betanoToOutcomes({ id: '1', name: `${teams.home} - ${teams.away}`, startTime: 0, markets: [market] } as never)

test('Betano: die Linie steht an der Auswahl, nicht am Markt', () => {
  const out = betanoOutcomes({
    id: 'm1',
    name: 'Über/Unter Tore Gesamt',
    type: 'HCTG',
    handicap: 0.5,
    selections: [
      { id: 'a', name: 'Über 2.5', price: 1.8, handicap: 2.5 },
      { id: 'b', name: 'Unter 2.5', price: 2.0, handicap: 2.5 },
      { id: 'c', name: 'Über 0.5', price: 1.05, handicap: 0.5 },
      { id: 'd', name: 'Unter 0.5', price: 9.0, handicap: 0.5 },
    ],
  })
  assert.deepEqual(
    out.map((o) => `${marketKey(o.market)} ${o.side} ${o.odds}`),
    [
      'OU|FT|-|2.5 OVER 1.8',
      'OU|FT|-|2.5 UNDER 2',
      'OU|FT|-|0.5 OVER 1.05',
      'OU|FT|-|0.5 UNDER 9',
    ],
  )
})

test('Betano: das Halbzeitergebnis beschriftet seine Seiten mit Mannschaftsnamen', () => {
  // Das Endergebnis nutzt "1"/"X"/"2", `H1RS` dagegen die Namen. Ohne diesen
  // Zweig war die Familie zwar zugeordnet, aber keine einzige Seite — der
  // Markt verschwand vollständig.
  const out = betanoOutcomes({
    id: 'm2',
    name: '1. Halbzeit Ergebnis',
    type: 'H1RS',
    handicap: 0,
    selections: [
      { id: 'a', name: 'Lyngby BK', price: 4.3, handicap: 0 },
      { id: 'b', name: 'Unentschieden', price: 2.22, handicap: 0 },
      { id: 'c', name: 'Aarhus GF', price: 2.47, handicap: 0 },
    ],
  })
  assert.deepEqual(
    out.map((o) => `${marketKey(o.market)} ${o.side}`),
    ['1X2|H1|-|- HOME', '1X2|H1|-|- DRAW', '1X2|H1|-|- AWAY'],
  )
})

test('Betano: Team-Totals trennen Heim und Auswärts', () => {
  const home = betanoOutcomes({
    id: 'm3', name: 'Lyngby BK - Über/Unter Tore Gesamt', type: 'OUHG', handicap: 0.5,
    selections: [{ id: 'a', name: 'Über 1.5', price: 2.92, handicap: 1.5 }],
  })
  const away = betanoOutcomes({
    id: 'm4', name: 'Aarhus GF - Über/Unter Tore Gesamt', type: 'OUAG', handicap: 0.5,
    selections: [{ id: 'a', name: 'Über 1.5', price: 1.85, handicap: 1.5 }],
  })
  assert.equal(marketKey(home[0].market), 'TEAM_OU|FT|HOME|1.5')
  assert.equal(marketKey(away[0].market), 'TEAM_OU|FT|AWAY|1.5')
})

test('Betano: FHMR ist das Handicap, nicht die Halbzeit-Siegwette', () => {
  // Der Typ heißt im Klartext "Handicap Spielergebnis". Als 1X2 der ersten
  // Hälfte verbucht — so stand es hier — wäre er eine Phantom-Arbitrage-Quelle:
  // ein Ganzspiel-Handicap gegen echte Halbzeit-Quoten anderer Bücher.
  const out = betanoOutcomes({
    id: 'm5', name: 'Handicap Spielergebnis', type: 'FHMR', handicap: -2,
    selections: [{ id: 'a', name: 'Lyngby BK', price: 5.0, handicap: -2 }],
  })
  assert.deepEqual(out, [])
})

// ---------------------------------------------------------------- bwin

test('bwin: Team-Totals überstehen das deutsche Exonym', () => {
  // bwin schreibt im Marktnamen "Rapid Bukarest", in der Teilnehmerliste
  // "Rapid Bucuresti 1923". Der exakte Zeichenvergleich, der hier stand,
  // verwarf dadurch sämtliche Team-Totals dieser Partie — bei allen drei
  // Entain-Marken zugleich, und in der Diagnose nur als "unklares Präfix".
  const m = (name: string, attr: string) => ({ id: '1', name: { value: name }, attr, options: [] })
  const teams = { home: 'FC Botosani', away: 'Rapid Bucuresti 1923' }
  assert.equal(
    key(bwinMarket(m('Rapid Bukarest - Gesamtanzahl Tore', '2.5'), teams.home, teams.away, 'bwin')),
    'TEAM_OU|FT|AWAY|2.5',
  )
  assert.equal(
    key(bwinMarket(m('Lech Posen - Gesamtanzahl Tore', '1.5'), 'Lech Poznan', 'Legia Warschau', 'bwin')),
    'TEAM_OU|FT|HOME|1.5',
  )

  // Das Gesamtergebnis bleibt das Gesamtergebnis — kein Präfix, kein Team.
  assert.equal(key(bwinMarket(m('Gesamtanzahl Tore', '2.5'), teams.home, teams.away, 'bwin')), 'OU|FT|-|2.5')
})

test('bwin: ein mehrdeutiges Präfix wird verworfen statt geraten', () => {
  // "Manchester" passt zu beiden Mannschaften gleich gut. Ein geratenes Team
  // ist im Modell dasselbe wie eine erfundene Wette, deshalb muss der Abstand
  // zwischen den beiden Kandidaten stimmen.
  const m = { id: '1', name: { value: 'Manchester - Gesamtanzahl Tore' }, attr: '2.5', options: [] }
  assert.equal(bwinMarket(m, 'Manchester United', 'Manchester City', 'bwin'), null)

  // Ein Präfix, das zu keiner der beiden Mannschaften gehört, ebenfalls.
  const fremd = { id: '1', name: { value: 'FC Cincinnati - Gesamtanzahl Tore' }, attr: '2.5', options: [] }
  assert.equal(bwinMarket(fremd, 'FC Botosani', 'Rapid Bucuresti 1923', 'bwin'), null)
})

// ---------------------------------------------------- Diagnose-Hygiene

test('bekannte Märkte ohne Gegenstück melden keine Lücke', () => {
  // Der Bericht unter `/api/diagnostics` ist nur brauchbar, solange dort die
  // echten Lücken stehen. Kambi führt Ecken und Torschüsse je Team, also mit
  // dem Teamnamen in der Beschriftung — ungefiltert erzeugt jede Partie eigene
  // Zeilen und verdeckt damit genau das, was der Bericht zeigen soll.
  resetDiagnostics()

  kambi('Handicap', 0.5, 'Handicap')
  kambi('Gesamte Eckstöße von Palmeiras-SP', 4.5)
  kambi('Erstes Tor (Unentschieden: Keine Tore)', undefined, 'Spiel')
  kambi('Tor in beiden Hälften', undefined, 'Ja/Nein')
  kambi('Interval Gewinner - 75:00-89:59', undefined, 'Spiel')
  winamax('Ergebnis und Anzahl Tore', 'ListOdd', 'total=2.5')
  winamax('Genaue Anzahl Tore', 'dynamic')
  winamax('Gewinnspanne', 'List')
  winamax('Halbzeit/Endstand', 'ListOdd')
  bc('TotalGoalsExact', 'Gesamttore (Exakt)')
  bc('FirstTeamToScore', 'Welches Team trifft als Erstes?')
  bc('MatchHomeMultiGoalInterval', 'Team 1. Gesamttore (Verlängertes Intervall)')
  bc('Team1ScoreYes/no', 'Team 1 trifft')
  kambi('Gesamte Treffer - 45:00-59:59', 1.5)
  kambi('Randers FC siegt zu null', undefined, 'Ja/Nein')
  winamax('Randers FC ohne Gegentor', '2way')
  winamax('Randers FC trifft in beiden Halbzeiten', '2way')
  tipico('team-number-of-points', 'Anzahl Tore Randers FC')
  tipico('team-to-win-to-nil', 'Randers FC siegt zu null')
  tipico('goal-scorer-yes', 'Trifft Spieler X?')

  assert.deepEqual(unmappedReport(), [])
})

test('ein wirklich unbekannter Markt wird weiterhin gemeldet', () => {
  // Die Gegenprobe zur Positivliste: sie darf nicht so weit werden, dass sie
  // alles verschluckt. Ohne diese Meldung gäbe es keinen Hinweis mehr darauf,
  // wo Abdeckung fehlt.
  resetDiagnostics()
  kambi('Völlig neuer Markt von morgen', 2.5)
  assert.equal(unmappedReport().length, 1)
  assert.match(unmappedReport()[0].label, /Völlig neuer Markt/)
  resetDiagnostics()
})

// -------------------------------------------------------- Tennis: Winamax

const winaTennis = (betTitle: string, template: string, special?: string) =>
  winamaxTennis({ betId: 1, matchId: 1, betTitle, template, specialBetValue: special }, 'Kei Nishikori', 'Juncheng Shang')

test('Winamax Tennis: Satznummer steht im specialBetValue, nicht im Titel', () => {
  assert.equal(key(winaTennis('Gewinner', '2way', 'type=live')), '2WAY|FT|-|-')
  assert.equal(key(winaTennis('1. Satz - Gewinner', '2way', 'setnr=1')), '2WAY|S1|-|-')
  assert.equal(key(winaTennis('2. Satz - Gewinner', '2way', 'setnr=2')), '2WAY|S2|-|-')
})

test('Winamax Tennis: Sätze und Spiele fallen auf verschiedene Schlüssel', () => {
  // Der ganze Zweck der Einheit im Schlüssel. Ohne sie läge das Satz-Handicap
  // über −1,5 im selben Fach wie ein Spiele-Handicap über −1,5.
  assert.equal(key(winaTennis('Anzahl Sätze', 'OverUnder', 'total=2.5')), 'OU|FT|-|2.5|SETS')
  assert.equal(
    // `hcp=`, nicht `handicap=` — so steht es im Feed. Eine erfundene
    // Schreibweise hätte den Test grün gehalten, während der Adapter im
    // Betrieb keine einzige Handicap-Linie fand.
    key(winaTennis('Differenz der Sätze (Handicap)', 'asian_handicap', 'hcp=-1.5')),
    'AH|FT|-|-1.5|SETS',
  )
  assert.notEqual(
    key(winaTennis('Anzahl Sätze', 'OverUnder', 'total=2.5')),
    key(winaTennis('Anzahl Spiele', 'OverUnder', 'total=2.5')),
  )
})

test('Winamax Tennis: "Sieger" ist der Turniersieger, nicht der Matchsieger', () => {
  // Namensähnlich zum echten Markt "Gewinner" — als Matchsieger verbucht wäre
  // es ein Feld mit dutzenden Teilnehmern gegen ein Zwei-Weg-Rennen.
  assert.equal(winaTennis('Sieger', 'ListOdd', 'variant=pre:markettext:384254'), null)
  assert.equal(winaTennis('Siegerin', 'ListOdd'), null)
})

test('Winamax Tennis: die Handicap-Seite steht in der Beschriftung, nicht im Code', () => {
  // Der teuerste Fall dieses Adapters. Winamax beschriftet die beiden Seiten
  // eines Handicaps mit `yes`/`no` — und welcher Code welchen Spieler meint,
  // **kippt mit dem Vorzeichen**: bei hcp=-1.5 ist `yes` der Heimspieler
  // ("K. Nishikori -1.5"), bei hcp=+1.5 ist `yes` der Gast ("J. Shang -1.5").
  // Wer den Code als Seite nimmt, dreht bei jedem zweiten Handicap die Beine.
  const ah = winaTennis('Differenz der Sätze (Handicap)', 'asian_handicap', 'hcp=-1.5')!
  const side = (label: string, code: string) =>
    winamaxSide({ betId: 1, label, code }, ah, 'Kei Nishikori', 'Juncheng Shang')

  assert.equal(side('K. Nishikori -1.5', 'yes'), 'HOME')
  assert.equal(side('J. Shang +1.5', 'no'), 'AWAY')
  // Gegenprobe mit umgekehrtem Vorzeichen: derselbe Code, andere Seite.
  assert.equal(side('J. Shang -1.5', 'yes'), 'AWAY')
  assert.equal(side('K. Nishikori +1.5', 'no'), 'HOME')

  // Ein fremder Name gehört zu keiner der beiden Seiten.
  assert.equal(side('C. Alcaraz -1.5', 'yes'), null)
})

// ------------------------------------------- Tennis: geteilte Typnamen

test('Tipico Tennis: "standard" ist zweiseitig, nicht 1X2', () => {
  // Der teuerste Fall. Als `1X2` verbucht verlangt der Markt über `SIDES` eine
  // Unentschieden-Seite, die es im Tennis nie gibt — er wäre nie vollständig
  // geworden und bei allen 162 Partien lautlos aus der Auswertung gefallen.
  assert.equal(key(tipicoTennis('standard', '', 'Tipp')), '2WAY|FT|-|-')
  // Gegenprobe: im Fußball bleibt derselbe Typ die dreiwegige Siegwette.
  assert.equal(key(tipicoMarket('standard', undefined, undefined, '', TEAMS)), '1X2|FT|-|-')
})

test('Tipico Tennis: "section-win" meint den Satz, nicht die Halbzeit', () => {
  assert.equal(key(tipicoTennis('section-win', '1', 'Sieger 1.Satz')), '2WAY|S1|-|-')
  assert.equal(key(tipicoTennis('section-win', '2', 'Sieger 2.Satz')), '2WAY|S2|-|-')
})

test('Tipico Tennis: Handicap und Über/Unter zählen Sätze, nicht Tore', () => {
  assert.equal(key(tipicoTennis('handicap', '0:1.5', 'Handicap (0:1,5)')), 'AH|FT|-|-1.5|SETS')
  assert.equal(key(tipicoTennis('handicap', '1.5:0', 'Handicap (1,5:0)')), 'AH|FT|-|1.5|SETS')
  assert.equal(
    key(tipicoTennis('points-more-less-than', '2.5', '+/- Sätze im Match (2,5)')),
    'OU|FT|-|2.5|SETS',
  )

  // Ohne Einheit in der Beschriftung ist nicht zu entscheiden, ob in Sätzen
  // oder Spielen gezählt wird — verwerfen statt raten.
  assert.equal(tipicoTennis('points-more-less-than', '2.5', ''), null)
})

test('BetConstruct Tennis: "Handicap" ist hier zweiwegig und zählt Spiele', () => {
  // Derselbe Typname trägt im Fußball das dreiwegige Tore-Handicap. Ein
  // gemeinsamer Zweig wäre nicht bloß unsauber, sondern falsch.
  const games = bcTennis('Handicap', 'Games Handicap', 2.5, -2.5)
  assert.equal(key(games), 'AH|FT|-|-2.5|GAMES')
  assert.equal(key(bcMarket({ id: 1, type: 'Handicap', name: 'Handicap (3-Wege)', base: 2, event: { '1': { type: 'Home', base: -2 } } }, 'vbet')), 'EH|FT|-|-2')
})

test('BetConstruct Tennis: Satz- und Spiele-Handicap fallen auseinander', () => {
  // Beide zweiseitig, beide mit Linie am Outcome, beide über −1,5. Ohne die
  // Einheit im Schlüssel wäre das dasselbe Fach.
  assert.equal(key(bcTennis('Sets Handicap', 'Sätze Handicap', 1.5, -1.5)), 'AH|FT|-|-1.5|SETS')
  assert.equal(key(bcTennis('Handicap', 'Games Handicap', 1.5, -1.5)), 'AH|FT|-|-1.5|GAMES')
  assert.notEqual(
    key(bcTennis('Sets Handicap', 'Sätze Handicap', 1.5, -1.5)),
    key(bcTennis('Handicap', 'Games Handicap', 1.5, -1.5)),
  )
})

test('BetConstruct Tennis: die Satznummer steht nur im Marktnamen', () => {
  assert.equal(key(bcTennis('SetWinner', '1. Satz: Sieger')), '2WAY|S1|-|-')
  assert.equal(key(bcTennis('SetWinner', '2. Satz: Sieger')), '2WAY|S2|-|-')
  assert.equal(key(bcTennis('P1P2', 'Sieger')), '2WAY|FT|-|-')
  // Ohne Satzangabe im Namen nicht raten.
  assert.equal(bcTennis('SetWinner', 'Sieger'), null)
})
