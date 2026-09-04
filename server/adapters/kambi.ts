import { fetchJson, pooled } from '../http.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport, Unit } from '../types.ts'
import { SPORT_LABEL, sportFromLabel } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'
import { teamTokens, tokenSimilarity } from '../match.ts'

/**
 * Kambi — die zweite Plattform, die mehrere Marken auf einmal abdeckt.
 *
 * Kambi ist ein B2B-Sportsbook-Anbieter; die Offering-API ist öffentlich und
 * unterscheidet Marken nur über ein Kürzel im Pfad. LeoVegas läuft darauf.
 *
 * Zwei Eigenheiten:
 *
 *  - Quoten und Linien kommen als **Ganzzahl mal 1000** (1,95 → 1950).
 *  - Es gibt **keine Sportradar-ID**. Anders als bei Tipico, Betano und
 *    Entain läuft das Matching hier über normalisierte Teamnamen plus
 *    Anstoßzeit. Das ist der schwächere Weg — dafür liefert Kambi `homeName`
 *    und `awayName` getrennt, sodass zumindest die Ausrichtung eindeutig ist.
 *
 * Die Marktzuordnung arbeitet mit einer **Positivliste**: nur ausdrücklich
 * bekannte Kriterien werden übernommen. Kambi liefert unter anderem
 * "Ecken insgesamt" und "Nächstes Tor" im selben Format wie "Gesamttore" —
 * würde man nach Struktur statt nach Bezeichnung mappen, entstünden
 * Vergleiche zwischen Ecken und Toren.
 */

const API = 'https://eu-offering-api.kambicdn.com/offering/v2018'
const QUERY = 'lang=de_DE&market=DE&client_id=2&channel_id=1&ncid=1'
const OPTS = { transport: 'impit' as const, minIntervalMs: 100 }

type Brand = {
  id: string
  name: string
  code: string
  webHost: string
  /** Abweichendes Muster für den Tiefenlink; sonst `/de-de/sports/event/{id}`. */
  eventUrl?: (id: number) => string
}

type KambiOutcome = {
  label?: string
  type?: string
  /** Dezimalquote mal 1000 */
  odds?: number
  /** Linie mal 1000 */
  line?: number
  participant?: string
}

type BetOffer = {
  id: number
  eventId: number
  /**
   * `englishLabel` ist der verlässlichere der beiden Namen.
   *
   * Die deutsche Beschriftung schwankt selbst innerhalb einer Antwort:
   * "Gesamte Punkte by X - einchließlich Verlängerung" steht neben
   * "Gesamtpunkte durch Y - einschließlich Verlängerung" — verschiedene
   * Präpositionen, ein Tippfehler, dieselbe Wette. Das englische Kriterium
   * schreibt beide Male "Total Points by … - Including Overtime".
   */
  criterion?: { label?: string; englishLabel?: string }
  betOfferType?: { name?: string }
  outcomes?: KambiOutcome[]
}

type KambiEvent = {
  id: number
  name?: string
  homeName?: string
  awayName?: string
  start?: string
  group?: string
  path?: { name?: string }[]
  state?: string
  nonLiveBoCount?: number
  liveBoCount?: number
}

const dec = (v: number | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v / 1000 : null

/**
 * Ordnet ein Kambi-Kriterium dem kanonischen Modell zu.
 *
 * Bewusst als Positivliste: alles, was hier nicht ausdrücklich steht, wird
 * verworfen. Der teuerste Fehler wäre, "Ecken insgesamt" oder "Nächstes Tor"
 * versehentlich als Gesamttore zu behandeln.
 */
export function toMarket(
  offer: BetOffer,
  outcome: KambiOutcome,
  home: string,
  away: string,
  bookId: string,
): CanonicalMarket | null {
  const label = offer.criterion?.label ?? ''
  // Kambi mischt Gedankenstrich und Bindestrich ("Gesamttore – 1. Hälfte"
  // gegen "Gesamte Treffer von X - 1. Halbzeit"). Vereinheitlichen, sonst
  // greifen die Muster nur zufällig.
  const l = label.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()
  const line = dec(outcome.line)

  /** Hängt an einem Kriterium eine Halbzeitangabe? */
  const suffixPeriod = (rest: string): Period | null => {
    const s = rest.trim()
    if (!s) return 'FT'
    if (/^- 1\. (hälfte|halbzeit)$/.test(s)) return 'H1'
    if (/^- 2\. (hälfte|halbzeit)$/.test(s)) return 'H2'
    return null
  }

  // Siegwette. "Reguläre Spielzeit" ist das Endergebnis, "Halbzeit" die
  // erste Hälfte — nicht intuitiv, aber so heißen sie bei Kambi.
  if (l === 'reguläre spielzeit') return { type: '1X2', period: 'FT', line: null, subject: null }
  if (l === 'halbzeit' || l === '1. hälfte') return { type: '1X2', period: 'H1', line: null, subject: null }
  if (l === '2. hälfte') return { type: '1X2', period: 'H2', line: null, subject: null }

  // Die Halbzeit hängt hier als Suffix am Kriterium ("Beide Teams treffen -
  // 1. Halbzeit"). "Beide Teams treffen in beiden Hälften" ist ein anderer
  // Markt und fällt durch `suffixPeriod` heraus, statt als Ganzspiel-BTTS
  // durchzugehen.
  if (l.startsWith('beide teams treffen')) {
    const period = suffixPeriod(l.slice('beide teams treffen'.length))
    return period ? { type: 'BTTS', period, line: null, subject: null } : null
  }

  // Die "Gesamttore"-Familie trägt **zwei** verschiedene Märkte: Über/Unter
  // ("Gesamttore – 2. Hälfte") und die Parität ("Gesamttore ungerade/gerade").
  // Die Parität muss zuerst geprüft werden — sonst landet sie im
  // Über/Unter-Zweig, findet dort keine Linie und wird stillschweigend
  // verworfen. Genau daran fehlte gerade/ungerade bei Kambi vollständig, ohne
  // je in der Diagnose aufzutauchen: die Meldung steht erst hinter diesem
  // Block, erreicht wurde sie nie.
  if (l.startsWith('gesamttore')) {
    const rest = l.slice('gesamttore'.length).trim()
    const parity = /^(un)?gerade\/(un)?gerade/.exec(rest)
    if (parity) {
      const period = suffixPeriod(rest.slice(parity[0].length))
      return period ? { type: 'OE', period, line: null, subject: null } : null
    }
    const period = suffixPeriod(rest)
    if (!period || line === null) return null
    return { type: 'OU', period, line, subject: null }
  }

  // "Gesamte Treffer von Cerro Porteño" — Team-Total. Muss sauber vom
  // Gesamtergebnis getrennt bleiben, sonst werden verschiedene Wetten
  // gegeneinander gerechnet.
  if (l.startsWith('gesamte treffer von')) {
    if (line === null) return null
    const rest = l.slice('gesamte treffer von'.length).trim()
    for (const [name, subject] of [
      [home.toLowerCase(), 'HOME'],
      [away.toLowerCase(), 'AWAY'],
    ] as const) {
      if (!rest.startsWith(name)) continue
      const period = suffixPeriod(rest.slice(name.length))
      if (!period) return null
      return { type: 'TEAM_OU', period, line, subject }
    }
    return null
  }

  // Zwei Schreibweisen für denselben Markt, je nach Periode:
  // "Drei-Wege-Handicap" (Ganzspiel) und "3-Wege Handicap - 1. Hälfte".
  //
  // Wichtig ist die Abgrenzung zum Kriterium **"Handicap"** ohne Zusatz: das
  // ist bei Kambi die zweiwegige asiatische Linie (nachgemessen: nur
  // OT_ONE@0.5 und OT_TWO@-0.5, kein OT_CROSS). Sie hat andere
  // Auszahlungsregeln und darf nicht in denselben Topf — deshalb wird hier
  // ausdrücklich auf die Drei-Wege-Schreibweisen geprüft und nicht auf
  // "handicap" als Teilwort.
  const eh = /^(drei-wege-handicap|3-wege[- ]handicap)/.exec(l)
  if (eh) {
    const period = suffixPeriod(l.slice(eh[0].length))
    if (!period || line === null) return null
    return { type: 'EH', period, line, subject: null }
  }

  if (l === 'gerade/ungerade' || l === 'ungerade/gerade')
    return { type: 'OE', period: 'FT', line: null, subject: null }

  // Nicht unterstützt, aber bekannt — ohne Warnung verwerfen:
  // Doppelte Chance und Unentschieden-keine-Wette (keine Zerlegung),
  // Korrektes Ergebnis (zu viele Seiten), Asian- und Zwei-Wege-Handicap
  // (Rückerstattung), Ecken/Schüsse/Karten (anderer Gegenstand), Nächstes Tor
  // und Intervalle (Restspielzeit), Spieler- und Opta-Wetten.
  //
  // Die Liste ist länger als die der wirklich unbekannten Märkte, und das ist
  // ihr Zweck: Kambi führt Ecken und Torschüsse **je Team** und je Intervall,
  // also mit dem Teamnamen im Kriterium. Jede Partie erzeugt dadurch eigene
  // Zeilen, die den Bericht unter `/api/diagnostics` fluten und die paar
  // echten Lücken unsichtbar machen. Was hier steht, ist geprüft und
  // absichtlich draußen — nicht übersehen.
  const known =
    /doppelte chance|unentschieden keine wette|korrektes ergebnis|asian|^handicap$|ecken|eckstöße|eckbälle|schüsse|paraden|opta|karten|nächste|nächstes tor|erstes tor|art des nächsten tors|interval|\d+:\d{2}-\d+:\d{2}|siegt|gewinnt mindestens|spieler|trifft|erzielt|vorlage|halbzeit\/|torschütze|tor in beiden|eigentor|elfmeter/.test(
      l,
    )
  if (!known) noteUnmapped(bookId, `${label} | ${offer.betOfferType?.name ?? ''}`)
  return null
}

/**
 * Tennis-Kriterien.
 *
 * Eigene Tabelle statt eines Zweigs in `toMarket`: die Fußball-Zuordnung
 * arbeitet mit Präfixen wie "gesamttore", und Tennis führt daneben ein halbes
 * Dutzend Kriterien, die strukturell **identisch** aussehen und Verschiedenes
 * bedeuten. Eine Partie trägt gleichzeitig:
 *
 *   [Satz-Handicap]     Handicap  OT_ONE@-1.5 / OT_TWO@1.5
 *   [Game Handicap]     Handicap  OT_ONE@3.5  / OT_TWO@-3.5
 *   [Gesamtsätze]       Über/Unter @2.5
 *   [Spiele insgesamt]  Über/Unter @22.5
 *
 * Beide Handicaps sind zweiseitig, tragen ihre Linie am Outcome und
 * unterscheiden sich **nur** in der Beschriftung. Ohne die Einheit im
 * Schlüssel fiele ein Satz-Handicap über −1,5 auf dasselbe Fach wie ein
 * Spiele-Handicap über −1,5 — und dann würde ein Satz-Bein gegen ein
 * Spiele-Bein gerechnet.
 */
export function toTennisMarket(
  offer: BetOffer,
  home: string,
  away: string,
  bookId: string,
): CanonicalMarket | null {
  const label = offer.criterion?.label ?? ''
  const l = label.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()

  /**
   * Die Linie steht bei den Handicaps **spiegelbildlich** an den beiden Seiten
   * (Heim 3.5, Gast −3.5). Maßgeblich ist immer die Heimsicht, also OT_ONE —
   * würde jede Auswahl ihre eigene Linie mitbringen, fielen die beiden Beine
   * desselben Marktes auf zwei verschiedene Schlüssel und der Markt käme nie
   * vollständig zustande.
   */
  const homeLine = (): number | null => {
    const one = (offer.outcomes ?? []).find((o) => o.type === 'OT_ONE')
    return dec(one?.line)
  }
  /** Bei Über/Unter tragen beide Seiten denselben Wert. */
  const anyLine = (): number | null => dec((offer.outcomes ?? [])[0]?.line)

  // "Satz 1" / "Satz 2" — Satzsieger, zweiseitig.
  const setWinner = /^satz ([1-5])$/.exec(l)
  if (setWinner) return { type: '2WAY', period: `S${setWinner[1]}` as CanonicalMarket['period'], line: null, subject: null }

  if (l === 'matchquoten') return { type: '2WAY', period: 'FT', line: null, subject: null }

  if (l === 'satz-handicap') {
    const line = homeLine()
    return line === null ? null : { type: 'AH', period: 'FT', line, subject: null, unit: 'SETS' }
  }
  if (l === 'game handicap' || l === 'spiel handicap') {
    const line = homeLine()
    return line === null ? null : { type: 'AH', period: 'FT', line, subject: null, unit: 'GAMES' }
  }

  if (l === 'gesamtsätze' || l === 'gesamtsatze') {
    const line = anyLine()
    return line === null ? null : { type: 'OU', period: 'FT', line, subject: null, unit: 'SETS' }
  }

  // "Spiele insgesamt" (ganze Partie) und "Spiele insgesamt - Satz 1".
  const totalGames = /^spiele insgesamt(?: - satz ([1-5]))?$/.exec(l)
  if (totalGames) {
    const line = anyLine()
    if (line === null) return null
    const period = (totalGames[1] ? `S${totalGames[1]}` : 'FT') as CanonicalMarket['period']
    return { type: 'OU', period, line, subject: null, unit: 'GAMES' }
  }

  // "Gesamte Spiele gewonnen von Alex Hernandez" — das Spieler-Total.
  if (l.startsWith('gesamte spiele gewonnen von')) {
    const line = anyLine()
    if (line === null) return null
    const rest = l.slice('gesamte spiele gewonnen von'.length).trim()
    const subject = rest.startsWith(home.toLowerCase())
      ? 'HOME'
      : rest.startsWith(away.toLowerCase())
        ? 'AWAY'
        : null
    return subject ? { type: 'TEAM_OU', period: 'FT', line, subject, unit: 'GAMES' } : null
  }

  // Bekannt und bewusst draußen — ohne Warnung verwerfen.
  //
  // "Meisten Asse" und "Die meisten Spiele" tragen ein OT_CROSS, sind also
  // dreiseitig und im Zwei-Weg-Modell nicht abbildbar. Tiebreaks, Breakpunkte
  // und Aufschlagspiele haben einen anderen Gegenstand als Sätze oder Spiele.
  // "Satzwetten" und "Korrektes Ergebnis" haben zu viele Seiten.
  // Bei laufenden Partien öffnet Kambi zusätzlich Märkte auf **einzelne Spiele
  // und Punkte** ("Satz 3 - Spiel 8", "Punkt 2 - Satz 3, Spiel 7", "Deuce in
  // Satz 2 - Spiel 3"). Davon gibt es je Partie dutzende, sie leben Sekunden
  // und haben bei keinem anderen Buch ein Gegenstück. Ungefiltert stellen sie
  // allein den halben Bericht unter `/api/diagnostics` und verdecken die
  // echten Lücken.
  const known =
    /^(satzwetten|korrektes ergebnis|meisten asse|die meisten spiele|tiebreaks insgesamt|gesamtes break punkte|total number of service breaks|asse insgesamt|doppelfehler)/.test(
      l,
    ) ||
    /gewinnt mindestens einen satz|gewinnt sein .*aufschlagspiel|erstaufschlag|holt den ersten|breakpunkt|as$|aufschlag/.test(
      l,
    ) ||
    // Spiel- und Punktebene sowie deren Sonderformen — sämtlich Live-Märkte.
    /spiel \d+|punkt \d+|deuce|tie ?break|gesamtpunktzahl|game handicap - satz|satz \d+ - spiel/.test(l)
  if (!known) noteUnmapped(bookId, `TENNIS ${label} | ${offer.betOfferType?.name ?? ''}`)
  return null
}

/* ------------------------ Basketball, Eishockey, Volleyball, Darts u. a. */

/**
 * Märkte der übrigen Sportarten — abgebildet aus dem **englischen** Kriterium.
 *
 * Kambi baut es nach einer festen Grammatik: ein Grundbegriff, dahinter durch
 * " - " getrennte Zusätze für Abschnitt und Verlängerung.
 *
 *   Moneyline - Including Overtime
 *   Puck Line - Regular Time
 *   Total Points by Chicago Sky (W) - 2nd Half - Including Overtime
 *   Total Points - Set 2
 *
 * Damit ist die Verlängerungsfrage hier **nicht** zu erraten: sie steht als
 * Zusatz da, und zwar auf beiden Seiten. Eishockey führt jede Wette doppelt,
 * einmal "Regular Time" und einmal "Including Overtime and Penalty Shootout".
 * Wer die beiden zusammenwirft, rechnet ein Über 7,5 mit Verlängerung gegen
 * ein Unter 7,5 ohne — und verliert genau dann, wenn verlängert wird.
 */
function toCourtMarket(
  offer: BetOffer,
  outcome: KambiOutcome,
  home: string,
  away: string,
  sport: Sport,
  bookId: string,
): CanonicalMarket | null {
  const raw = (offer.criterion?.englishLabel ?? offer.criterion?.label ?? '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  if (!raw) return null

  const parts = raw.split(' - ').map((s) => s.trim())
  const base = parts[0]
  const suffixes = parts.slice(1)
  const line = dec(outcome.line)
  const hasDraw = (offer.outcomes ?? []).some((o) => o.type === 'OT_CROSS')

  /**
   * Ein Zusatz benennt entweder den Abschnitt oder die Verlängerungsregel.
   * `null` heißt: unbekannt — und dann ist es ein anderer Markt.
   */
  const abschnitt = (s: string): Period | 'ot' | null => {
    const q = /^quarter ([1-4])$/.exec(s)
    if (q) return `Q${q[1]}` as Period
    const p = /^period ([1-3])$/.exec(s)
    if (p) return `P${p[1]}` as Period
    const set = /^set ([1-5])$/.exec(s)
    if (set) return `S${set[1]}` as Period
    if (/^1st half$/.test(s)) return 'H1'
    if (/^2nd half$/.test(s)) return 'H2'
    if (/^regular time$/.test(s)) return 'RT'
    if (/^including overtime( and penalty shootout)?$/.test(s)) return 'ot'
    return null
  }

  /**
   * **Jeder** Zusatz muss verstanden sein, sonst wird verworfen.
   *
   * Vorher wurde nur der Grundbegriff geprüft und alles dahinter ignoriert.
   * Damit ging "Quarter 1 - First to 15 Points" als Viertelsieger durch: der
   * Grundbegriff "quarter 1" passte, der Zusatz „wer zuerst 15 Punkte hat"
   * fiel unter den Tisch. Fünf solcher Rennen — 10, 15, 20, 25 und 30 Punkte —
   * landeten damit auf demselben Schlüssel wie der echte Viertelsieger.
   *
   * Ein unbekannter Zusatz bedeutet fast immer einen anderen Markt. Ihn zu
   * verwerfen kostet eine Gelegenheit; ihn durchzulassen erzeugt Vergleiche
   * zwischen Wetten, die nichts miteinander zu tun haben.
   */
  let period: Period = 'FT'
  for (const s of suffixes) {
    const a = abschnitt(s)
    if (a === null) {
      noteUnmapped(bookId, `${sport} unbekannter Zusatz :: ${raw}`)
      return null
    }
    if (a !== 'ot') period = a
  }
  // Steht der Abschnitt im Grundbegriff selbst ("Quarter 1", "Set 2"), zählt
  // er ebenfalls — dort ist er aber optional, nicht jeder Markt trägt ihn.
  const ausBasis = abschnitt(base)
  if (ausBasis && ausBasis !== 'ot') period = ausBasis

  // Einheit nur, wo die Sportart mehr als eine führt — siehe `Unit`.
  const unitOf = (kind: 'points' | 'sets' | 'legs' | 'goals'): Unit | undefined => {
    if (sport === 'VOLLEYBALL') return kind === 'sets' ? 'SETS' : 'POINTS'
    if (sport === 'DARTS') return kind === 'sets' ? 'SETS' : 'LEGS'
    return undefined
  }

  // Bekannt und bewusst draußen. "Draw No Bet" erstattet beim Unentschieden
  // den Einsatz und ist damit **keine** zweiseitige Wette; würde man es als
  // solche führen, käme gegen ein echtes 2-Weg-Angebot eine Scheinrendite
  // heraus, weil das Remis-Risiko fehlt.
  if (
    /^(draw no bet|correct score|double chance|winning margin|half time\/full time|race to|highest scoring|which team|method of|\d+\+ )/.test(
      base,
    ) ||
    /by the player|player performance|to win (both|either)|margin of victory/.test(raw)
  )
    return null

  // Siegwette. Ein Kreuz unter den Ausgängen entscheidet zwischen drei- und
  // zweiseitig — nicht die Sportart: bei Kambi hat dieselbe Eishockeypartie
  // "Match Odds - Regular Time" mit Kreuz und "Moneyline - Including
  // Overtime" ohne.
  if (/^(moneyline|match odds|to win the match|winner)$/.test(base))
    return { type: hasDraw ? '1X2' : '2WAY', period, line: null, subject: null }

  // "Quarter 3" / "Set 1" ganz ohne Grundbegriff ist der Abschnittssieger.
  if (/^(quarter [1-4]|period [1-3]|set [1-5]|1st half|2nd half)$/.test(base))
    return { type: hasDraw ? '1X2' : '2WAY', period, line: null, subject: null }

  if (/^(point spread|puck line|handicap|set handicap|spread|game handicap|leg handicap)$/.test(base)) {
    // **Nicht** `outcome.line`, sondern die Linie der Heimauswahl.
    //
    // Kambi hängt die Linie an jeden Ausgang einzeln, und zwar gespiegelt:
    // "Universidad De Concepción[-12500] / Mun. Puente Alto[12500]". Wer sie
    // je Ausgang liest, legt die beiden Beine derselben Wette auf **zwei
    // verschiedene Schlüssel** — das Heimbein auf −12,5, das Auswärtsbein auf
    // +12,5. Dort trifft es dann auf das Heimbein eines ganz anderen
    // Handicaps und ergibt eine Rendite, die es nicht gibt: gemessen 24,6 %
    // auf "Portland Fire −5,5", wo in Wahrheit zwei verschiedene Linien
    // gegeneinander standen.
    //
    // Das Modell führt die Linie aus Heimsicht, also ist OT_ONE maßgeblich.
    const homeLine = dec((offer.outcomes ?? []).find((o) => o.type === 'OT_ONE')?.line)
    if (homeLine === null) return null
    const unit = /set/.test(base) ? unitOf('sets') : /leg/.test(base) ? unitOf('legs') : unitOf('points')
    return hasDraw
      ? { type: 'EH', period, line: homeLine, subject: null }
      : { type: 'AH', period, line: homeLine, subject: null, unit }
  }

  if (/^both teams to score$/.test(base))
    return { type: 'BTTS', period, line: null, subject: null }

  // Gesamtzahl — auch die Parität, die denselben Grundbegriff trägt.
  const total = /^total (points|goals|sets|legs|games)( odd\/even)?(?: by (.+))?$/.exec(base)
  if (total) {
    const kind = total[1] as 'points' | 'goals' | 'sets' | 'legs' | 'games'
    const unit = unitOf(kind === 'games' ? 'legs' : (kind as 'points' | 'sets' | 'legs' | 'goals'))
    if (total[2]) return { type: 'OE', period, line: null, subject: null }
    if (line === null) return null

    // Team-Total: der Mannschaftsname steht hinter "by".
    if (total[3]) {
      const who = total[3]
      const h = tokenSimilarity(teamTokens(who), teamTokens(home))
      const a = tokenSimilarity(teamTokens(who), teamTokens(away))
      // Derselbe Abstand wie beim Zusammenführen der Partien: ein Name, der zu
      // beiden Seiten gleich gut passt, wird verworfen statt geraten.
      if (Math.max(h, a) < 0.5 || Math.abs(h - a) < 0.25) return null
      return { type: 'TEAM_OU', period, line, subject: h > a ? 'HOME' : 'AWAY', unit }
    }
    return { type: 'OU', period, line, subject: null, unit }
  }

  noteUnmapped(bookId, `${sport} ${raw}`)
  return null
}

function toSide(outcome: KambiOutcome, market: CanonicalMarket): Side | null {
  const twoWay = market.type === '2WAY' || market.type === 'AH'
  switch (outcome.type) {
    case 'OT_ONE':
      return market.type === '1X2' || market.type === 'EH' || twoWay ? 'HOME' : null
    case 'OT_CROSS':
      return market.type === '1X2' || market.type === 'EH' ? 'DRAW' : null
    case 'OT_TWO':
      return market.type === '1X2' || market.type === 'EH' || twoWay ? 'AWAY' : null
    case 'OT_OVER':
      return market.type === 'OU' || market.type === 'TEAM_OU' ? 'OVER' : null
    case 'OT_UNDER':
      return market.type === 'OU' || market.type === 'TEAM_OU' ? 'UNDER' : null
    case 'OT_YES':
      return market.type === 'BTTS' ? 'YES' : null
    case 'OT_NO':
      return market.type === 'BTTS' ? 'NO' : null
    case 'OT_ODD':
      return market.type === 'OE' ? 'ODD' : null
    case 'OT_EVEN':
      return market.type === 'OE' ? 'EVEN' : null
    default:
      return null
  }
}

function toOutcomes(
  offers: BetOffer[],
  home: string,
  away: string,
  bookId: string,
  sport: Sport = 'FOOTBALL',
): RawOutcome[] {
  const out: RawOutcome[] = []
  for (const offer of offers) {
    // Bei Tennis hängt die Linie am Markt, nicht an der einzelnen Auswahl —
    // deshalb einmal je Wettangebot bestimmen statt je Outcome.
    const tennisMarket = sport === 'TENNIS' ? toTennisMarket(offer, home, away, bookId) : null
    if (sport === 'TENNIS' && !tennisMarket) continue

    for (const o of offer.outcomes ?? []) {
      const odds = dec(o.odds)
      if (odds === null || odds <= 1) continue
      const market =
        tennisMarket ??
        (sport === 'FOOTBALL'
          ? toMarket(offer, o, home, away, bookId)
          : toCourtMarket(offer, o, home, away, sport, bookId))
      if (!market) continue
      const side = toSide(o, market)
      if (side) out.push({ market, side, odds })
    }
  }
  return out
}


/**
 * Kambis Pfadname je Sportart, gemessen am Gruppenbaum (`group.json`).
 *
 * Der Baum nennt 34 Sportarten; hier stehen die acht, die das Modell führt.
 * Kambi ist derzeit die ergiebigste Quelle für die neuen Sportarten, weil die
 * Sommerligen mitlaufen: 86 Partien American Football (CFL), 20 Basketball,
 * 15 Darts und 10 Eishockey (AIHL) — dort, wo die deutschen Bücher Ende Juli
 * gar nichts anbieten.
 */
const SPORTS: { sport: Sport; path: string }[] = [
  { sport: 'FOOTBALL', path: 'football' },
  { sport: 'TENNIS', path: 'tennis' },
  { sport: 'BASKETBALL', path: 'basketball' },
  { sport: 'ICEHOCKEY', path: 'ice_hockey' },
  { sport: 'HANDBALL', path: 'handball' },
  { sport: 'VOLLEYBALL', path: 'volleyball' },
  { sport: 'AMERICANFOOTBALL', path: 'american_football' },
  { sport: 'DARTS', path: 'darts' },
]

function makeAdapter(brand: Brand): BookmakerAdapter {
  const base = `${API}/${brand.code}`

  const build = (e: KambiEvent, offers: BetOffer[], sport: (typeof SPORTS)[number]): RawEvent | null => {
    const home = e.homeName?.trim()
    const away = e.awayName?.trim()
    if (!home || !away || !e.start) return null
    const outcomes = toOutcomes(offers, home, away, brand.id, sport.sport)
    if (!outcomes.length) return null

    const path = (e.path ?? []).map((p) => p.name).filter(Boolean)
    return {
      bookmakerId: brand.id,
      bookEventId: String(e.id),
      // Kambi liefert keine Sportradar-ID — Matching läuft über Namen + Zeit.
      sportradarId: null,
      sport: SPORT_LABEL[sport.sport],
      league: path.slice(1).join(' — ') || e.group || 'Unbekannt',
      home,
      away,
      startTime: new Date(e.start).toISOString(),
      isLive: e.state === 'STARTED',
      url: brand.eventUrl?.(e.id) ?? `https://${brand.webHost}/de-de/sports/event/${e.id}`,
      outcomes,
      fetchedAt: new Date().toISOString(),
    }
  }

  return {
    id: brand.id,
    name: brand.name,
    transport: 'impit',

    async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
      const cutoff = Date.now() + ctx.windowMs
      const out: RawEvent[] = []

      // Je Sportart ein Abruf. Fällt einer aus, kostet das nicht die andere
      // Sportart — bei Kambi hängen beide am selben Host und derselben Sperre.
      const pages = await Promise.allSettled(
        SPORTS.map((s) =>
          fetchJson<{ events?: { event: KambiEvent; betOffers?: BetOffer[] }[] }>(
            `${base}/listView/${s.path}.json?${QUERY}`,
            OPTS,
          ).then((res) => ({ sport: s, res })),
        ),
      )

      for (const p of pages) {
        if (p.status !== 'fulfilled') continue
        for (const item of p.value.res.events ?? []) {
          const e = item.event
          if (!e?.start || new Date(e.start).getTime() > cutoff) continue
          const ev = build(e, item.betOffers ?? [], p.value.sport)
          if (ev) out.push(ev)
        }
      }
      return out.slice(0, ctx.maxEvents)
    },

    async fetchDepth(events: RawEvent[]): Promise<RawEvent[]> {
      const results = await pooled(events, 4, async (ev) => {
        const d = await fetchJson<{ betOffers?: BetOffer[]; events?: KambiEvent[] }>(
          `${base}/betoffer/event/${ev.bookEventId}.json?${QUERY}`,
          OPTS,
        )
        const sport: Sport = sportFromLabel(ev.sport) ?? 'FOOTBALL'
        const outcomes = toOutcomes(d.betOffers ?? [], ev.home, ev.away, brand.id, sport)
        return outcomes.length > ev.outcomes.length
          ? { ...ev, outcomes, fetchedAt: new Date().toISOString() }
          : ev
      })
      return results.map((r, i) => (r.status === 'fulfilled' ? r.value : events[i]))
    },
  }
}

export const leovegas = makeAdapter({
  id: 'leovegas',
  name: 'LeoVegas',
  code: 'leo',
  webHost: 'www.leovegas.de',
})

/**
 * 888sport — **italienisches Buch**, ausdrücklich so gewollt.
 *
 * Vorgeschichte: eine deutsche Kambi-Kennung für 888 existiert nicht. Alle
 * Kandidaten (`888de`, `888ger`, `888sportde`, `888at`, …) antworten mit
 * HTTP 400. Der Grund ist inzwischen belegt: 888sport.de läuft gar nicht mehr
 * auf Kambi, sondern auf **Spectate** (`spectate-web.888sport.de`, Bootstrap
 * per `POST /spectate/load/state`, Quoten danach über WebSocket). Das ist ein
 * eigener Adapter und steht noch aus.
 *
 * Bis dahin auf Wunsch die italienische Marke `888it`. Zwei Dinge dazu, damit
 * niemand die Zahlen falsch liest:
 *
 *  - Die Quoten sind **eigenständig**, nicht bloß ein Abbild von LeoVegas:
 *    von 228 gemeinsamen Partien weichen 209 im 1X2 ab. Als Vergleichsfläche
 *    taugt die Marke also.
 *  - Ein Bein hier ist aus Deutschland aber **nicht spielbar**. Nachgemessen:
 *    `sport.888casino.it` liefert von einer deutschen Leitung auf jeden
 *    Wettpfad HTTP 404, nur die Startseite antwortet. Deshalb heißt die Marke
 *    im Frontend „888sport (IT)" — der Zusatz steht an jedem Bein und der
 *    Tiefenlink zeigt auf die Startseite statt ins Leere.
 */
export const sport888 = makeAdapter({
  id: 'sport888',
  name: '888sport (IT)',
  code: '888it',
  webHost: 'sport.888casino.it',
  eventUrl: () => 'https://sport.888casino.it/',
})
