import { fetchJson, pooled } from '../http.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport, Unit } from '../types.ts'
import { OVERTIME_SPORTS, SPORT_LABEL, sportFromLabel } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'
import { teamTokens, tokenSimilarity } from '../match.ts'
import { nameMatch } from '../players.ts'

/**
 * bwin — Entains "cds-api".
 *
 * Die `x-bwin-accessid` ist eine statische, öffentliche Client-ID (base64
 * eines festen GUID), kein Zugangstoken. Dieselbe API bedient auch andere
 * Entain-Marken, u.a. Sportingbet — der Adapter ist deshalb über `brand`
 * parametrisiert.
 *
 * Der Unterschied zwischen den Stufen steckt allein in `offerMapping`:
 *   Filtered → rund 13 Märkte je Event, kompakt genug für den Sweep
 *   All      → rund 87 Märkte, aber 16,8 MB pro 100 Events
 * Deshalb läuft `All` nur über `fixture-view` für einzelne Events.
 */

/** Entain-Sportkennungen: 4 ist Fußball, 5 ist Tennis. */
const ACCESS_ID = 'NWQyNmIwMjUtZDQ3NC00NDQxLWI5YTktNjdkYjZjOTg1OWEz'
const OPTS = { transport: 'impit' as const, minIntervalMs: 120 }
const PAGE_SIZE = 100

type Brand = {
  id: string
  name: string
  /** Host der Daten-API */
  host: string
  /** Host der Wett-Oberfläche — bei Entain eine eigene Subdomain */
  webHost: string
}

type Option = {
  name: { value: string }
  price?: { odds?: number }
}

type OptionMarket = {
  id: string
  name: { value: string }
  options: Option[]
  attr?: string
  /**
   * Strukturierte Beschreibung des Markts — nur bei manchen Sportarten
   * gefüllt, dann aber wesentlich verlässlicher als die Beschriftung.
   * Volleyball liefert darüber `Happening=Set`, `MarketType=Over/Under` und
   * `DecimalValue=3.5`, wo Basketball nur "Gesamtzahl" schreibt.
   */
  parameters?: { key?: string; value?: string }[]
}

/**
 * Ein Markt in der **Tennis**-Darstellung.
 *
 * Entain liefert Tennis nicht über `optionMarkets`, sondern über `games` —
 * eine andere Form mit `results` statt `options` und `odds` als blanker Zahl
 * statt `price.odds`. Gemessen: `optionMarkets` ist bei jeder Tennispartie
 * **leer**, auch mit `offerMapping=All` und ohne `offerCategories`-Filter.
 * Wer nur den Fußball-Zweig kennt, sieht dort schlicht nichts und hält den
 * Anbieter für tennislos.
 */
type Game = {
  id?: number
  name?: { value?: string }
  templateId?: number
  categoryId?: number
  /** Linie, wo es eine gibt: "182,5". Beim Handicap steht sie stattdessen im Optionstext. */
  attr?: string
  results?: { odds?: number; name?: { value?: string }; sourceName?: { value?: string } }[]
}

type Fixture = {
  id: string
  name: { value: string }
  startDate: string
  stage?: string
  /** Sportart laut Antwort — der Adapter pflegt keine eigene Kennungsliste mehr. */
  sport?: { id?: number; name?: { value?: string } }
  participants?: { name: { value: string } }[]
  competition?: { name: { value: string } }
  region?: { name: { value: string } }
  addons?: { betRadar?: number }
  optionMarkets?: OptionMarket[]
  games?: Game[]
  totalMarketsCount?: number
}

const num = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const lineFrom = (text: string): number | null => {
  const m = text.match(/(-?\d+[.,]?\d*)/)
  return m ? num(m[1]) : null
}

function periodOf(name: string): Period {
  const s = name.toLowerCase()
  if (s.includes('1. hälfte') || s.includes('1. halbzeit')) return 'H1'
  if (s.includes('2. hälfte') || s.includes('2. halbzeit')) return 'H2'
  return 'FT'
}

/** Normalisiert für Vergleiche: Kleinschreibung, Umlaute, Satzzeichen weg. */
const simplify = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '')

/**
 * Mindestähnlichkeit, damit ein Präfix als Mannschaftsname gilt, und der
 * Vorsprung, den der Treffer vor der anderen Mannschaft haben muss.
 *
 * Der Abstand ist die eigentliche Sicherung. Ein Präfix wie "Manchester" passt
 * zu "Manchester United" und "Manchester City" gleich gut — ohne
 * Abstandsforderung würde das Team-Total willkürlich einer der beiden Seiten
 * zugeschlagen, und ein vertauschtes Team ist im Modell dasselbe wie eine
 * erfundene Wette.
 */
const SUBJECT_THRESHOLD = 0.5
const SUBJECT_MARGIN = 0.25

/**
 * Ordnet das Präfix eines Team-Totals einer der beiden Mannschaften zu.
 *
 * Der exakte Zeichenvergleich, der hier stand, verlor systematisch Märkte:
 * bwin schreibt im Marktnamen das **deutsche Exonym**, in der
 * Teilnehmerliste aber den Originalnamen — "Rapid Bukarest - Gesamtanzahl
 * Tore" gegen "Rapid Bucuresti 1923", "Lech Posen" gegen "Lech Poznan". Jede
 * dieser Partien verlor sämtliche Team-Totals beider Hälften, und zwar bei
 * allen drei Entain-Marken zugleich; in der Diagnose tauchten sie nur als
 * "unklares Präfix" auf. Betroffen ist jeder Verein mit gängigem deutschen
 * Namen (Warschau, Prag, Moskau, Kiew, Roter Stern Belgrad).
 *
 * Verglichen wird deshalb über Wortmengen — dasselbe Werkzeug, mit dem
 * `match.ts` schon die Partien selbst zusammenführt.
 */
function subjectOf(prefix: string, home: string, away: string): 'HOME' | 'AWAY' | null {
  const p = simplify(prefix)
  if (!p) return null
  // Exakte Schreibweise bleibt der schnelle Weg und der häufigste Fall.
  if (p === simplify(home)) return 'HOME'
  if (p === simplify(away)) return 'AWAY'

  const tokens = teamTokens(prefix)
  if (!tokens.length) return null
  const h = tokenSimilarity(tokens, teamTokens(home))
  const a = tokenSimilarity(tokens, teamTokens(away))
  if (Math.max(h, a) < SUBJECT_THRESHOLD) return null
  if (Math.abs(h - a) < SUBJECT_MARGIN) return null
  return h > a ? 'HOME' : 'AWAY'
}

export function toMarket(m: OptionMarket, home: string, away: string, bookId: string): CanonicalMarket | null {
  const raw = m.name?.value ?? ''
  const name = raw.toLowerCase()
  const period = periodOf(raw)
  const firstOption = m.options?.[0]?.name?.value ?? ''

  // Kombinationswetten ("Spielresultat und Gesamtanzahl Tore 2,5") enthalten
  // die Namen echter Märkte und würden sonst als solche durchgehen. Sie sind
  // Schnittmengen zweier Ereignisse und damit keine Zerlegung.
  if (/\bund\b/.test(name)) return null

  // Restzeit-Märkte laufender Spiele: strukturell wie ein Ganzspielmarkt,
  // inhaltlich etwas völlig anderes. Nicht vergleichbar.
  if (/restzeit|restliche|rest der|ab jetzt|nächste[rs]?\s/.test(name)) return null

  if (
    name === 'spielresultat' ||
    name.startsWith('spielresultat -') ||
    name.startsWith('endergebnis') ||
    name.startsWith('ergebnis') ||
    name.includes('1x2')
  )
    return { type: '1X2', period, line: null, subject: null }

  // Exakt statt "enthält": bwin führt neben "Beide Teams treffen" (Ja 1,58)
  // auch "Beide Teams treffen in beiden Hälften" (Ja 11,00). Eine lose
  // Prüfung nimmt beide und rechnet sie gegeneinander — dabei kamen
  // Renditen von angeblich 85 % heraus.
  if (/^beide (teams|mannschaften) treffen( in der [12]\. hälfte)?$/.test(name))
    return { type: 'BTTS', period, line: null, subject: null }

  if (/^(gesamtanzahl tore )?(un)?gerade\/(un)?gerade( - [12]\. hälfte)?$/.test(name))
    return { type: 'OE', period, line: null, subject: null }

  // Asiatische Handicaps haben andere Auszahlungsregeln (Einsatzrückgabe bei
  // bestimmten Ergebnissen) und dürfen nicht mit dem europäischen Handicap
  // in denselben Topf.
  if (name.includes('handicap') && !name.includes('asian') && !name.includes('asiatisch')) {
    const line = lineFrom(m.attr ?? raw)
    return line === null ? null : { type: 'EH', period, line, subject: null }
  }

  if (name.includes('gesamtanzahl tore') || name.includes('gesamtzahl der tore')) {
    const line = lineFrom(m.attr ?? '') ?? lineFrom(firstOption)
    if (line === null) return null

    // "Velez Sarsfield - Gesamtanzahl Tore" ist ein Team-Total,
    // "Gesamtanzahl Tore" das Gesamtergebnis. Werden die verwechselt,
    // entstehen Vergleiche zwischen völlig verschiedenen Wetten — genau das
    // erzeugt Phantom-Arbs mit absurden Renditen.
    const rawPrefix = raw.split(' - ')[0] ?? ''
    const prefix = simplify(rawPrefix)
    const subject = subjectOf(rawPrefix, home, away)
    if (subject) return { type: 'TEAM_OU', period, line, subject }

    // Ein Präfix, das weder leer noch eines der beiden Teams ist, gehört zu
    // einem Markt, den wir nicht kennen — verwerfen statt raten.
    const generic = ['gesamtanzahltore', 'gesamtzahldertore', '1halfte', '2halfte']
    if (prefix && !generic.includes(prefix)) {
      // "Gesamtanzahl Tore (0-4+)" ist eine Intervallwette mit mehreren
      // Spannen statt zwei Seiten — bekannt, ohne Gegenstück und deshalb
      // stumm. Sie ist kein unklares Präfix, sondern ein anderer Markt.
      if (!/\(\d+-\d+\+?\)/.test(raw)) noteUnmapped(bookId, `unklares Präfix :: ${raw}`)
      return null
    }
    return { type: 'OU', period, line, subject: null }
  }

  // Bekannt und bewusst ausgeschlossen — ohne Warnung verwerfen.
  //
  // Doppelte Chance und "Unentschieden - Einsatz zurück" haben überlappende
  // bzw. erstattete Optionen, genaues Ergebnis und Torschützen zu viele
  // Seiten, "n. Tor" und "Hälfte mit den meisten Toren" einen anderen
  // Gegenstand. Alle drei Entain-Marken liefern diese Märkte für praktisch
  // jede Partie; ungefiltert stellen sie allein rund fünfzig Zeilen mit
  // dreistelligen Zählern und verdrängen damit jede echte Lücke aus dem
  // Bericht unter `/api/diagnostics`.
  const known =
    /doppelte chance|einsatz zurück|genaues ergebnis|halbzeit ?[\/|oder] ?endstand|torschütze|spieler erzielt|^\d+\. tor$|hälfte mit den meisten toren|toren unterschied|einem tor unterschied|in beiden hälften|gewinnt beide hälften|gewinnt mind|qualifiziert sich|elfmeterschießen/.test(
      name,
    )
  if (!known) noteUnmapped(bookId, raw)
  return null
}

function toSide(opt: Option, market: CanonicalMarket, home: string, away: string): Side | null {
  const raw = opt.name?.value ?? ''
  const n = raw.trim().toLowerCase()
  const s = simplify(raw)

  if (market.type === '1X2' || market.type === 'EH') {
    if (n === '1' || s === simplify(home)) return 'HOME'
    if (n === 'x' || n === 'unentschieden' || n === 'remis') return 'DRAW'
    if (n === '2' || s === simplify(away)) return 'AWAY'
    return null
  }
  if (market.type === 'OU' || market.type === 'TEAM_OU') {
    if (n.startsWith('mehr als') || n.startsWith('über') || n.startsWith('over')) return 'OVER'
    if (n.startsWith('weniger als') || n.startsWith('unter') || n.startsWith('under')) return 'UNDER'
    return null
  }
  if (market.type === 'BTTS') {
    if (n === 'ja') return 'YES'
    if (n === 'nein') return 'NO'
    return null
  }
  if (market.type === 'OE') {
    if (n.startsWith('ungerade')) return 'ODD'
    if (n.startsWith('gerade')) return 'EVEN'
    return null
  }
  return null
}

/* ------------------------------------------------------------------ Tennis */

/** "Alex Hernandez (MEX) +1,5" → { who: "Alex Hernandez (MEX)", line: 1.5 } */
function splitHandicapLabel(raw: string): { who: string; line: number | null } {
  const m = /^(.*?)\s*([+-]\s*[\d.,]+)\s*$/.exec(raw.trim())
  if (!m) return { who: raw.trim(), line: null }
  return { who: m[1].trim(), line: num(m[2].replace(/\s+/g, '')) }
}

/**
 * Ordnet eine Auswahl einem der beiden Spieler zu.
 *
 * Die Schreibweisen unterscheiden sich **innerhalb derselben Antwort**: der
 * Siegermarkt kürzt ab ("A. Hernandez"), das Handicap schreibt aus und hängt
 * das Länderkürzel an ("Alex Hernandez (MEX) −1,5"). Ein Zeichenvergleich
 * scheitert daran, deshalb der Spielerabgleich aus `server/players.ts`.
 */
function playerSide(label: string, home: string, away: string): Side | null {
  const h = nameMatch(label, home)
  const a = nameMatch(label, away)
  if (h > a) return 'HOME'
  if (a > h) return 'AWAY'
  return null
}

/**
 * Tennis-Märkte aus `games`.
 *
 * Bewusst nach `templateId` **und** Beschriftung: die Kennung allein ist über
 * die Jahre nicht zugesagt, die Beschriftung allein zu schwammig.
 */
function tennisOutcomes(f: Fixture, home: string, away: string, bookId: string): RawOutcome[] {
  const out: RawOutcome[] = []

  for (const g of f.games ?? []) {
    const raw = g.name?.value ?? ''
    const name = raw.toLowerCase()
    const results = g.results ?? []

    const push = (market: CanonicalMarket, side: Side | null, odds: number | null) => {
      if (side && odds !== null && odds > 1) out.push({ market, side, odds })
    }

    // Matchsieger — die einzige Stelle mit "1"/"2" in `sourceName`.
    if (name === 'sieger') {
      const market: CanonicalMarket = { type: '2WAY', period: 'FT', line: null, subject: null }
      for (const r of results) {
        const src = r.sourceName?.value
        const side = src === '1' ? 'HOME' : src === '2' ? 'AWAY' : playerSide(r.name?.value ?? '', home, away)
        push(market, side, num(r.odds))
      }
      continue
    }

    // "Sieger Satz 1" / "Sieger Satz 2" — Satzsieger, ebenfalls zweiseitig.
    const setWinner = /^sieger satz ([1-5])$/.exec(name)
    if (setWinner) {
      const market: CanonicalMarket = {
        type: '2WAY',
        period: `S${setWinner[1]}` as CanonicalMarket['period'],
        line: null,
        subject: null,
      }
      for (const r of results) push(market, playerSide(r.name?.value ?? '', home, away), num(r.odds))
      continue
    }

    // "Wer gewinnt das Match? (Satz-Handicap)". Es gibt **zwei** solche
    // Märkte je Partie, einen mit Heim +1,5 und einen mit Heim −1,5. Die
    // Linie steht nur in der Beschriftung, und maßgeblich ist die Heimsicht —
    // wer die Linie der Gastseite nimmt, dreht das Vorzeichen.
    if (name.includes('satz-handicap')) {
      let line: number | null = null
      const parsed = results.map((r) => {
        const p = splitHandicapLabel(r.name?.value ?? '')
        const side = playerSide(p.who, home, away)
        if (side === 'HOME') line = p.line
        return { side, odds: num(r.odds) }
      })
      if (line === null) continue
      const market: CanonicalMarket = { type: 'AH', period: 'FT', line, subject: null, unit: 'SETS' }
      for (const p of parsed) push(market, p.side, p.odds)
      continue
    }

    // "Sätze im Match (Best-of-3)" mit den Auswahlmöglichkeiten "2 Sätze" und
    // "3 Sätze". Im Best-of-3 ist das **exakt** Über/Unter 2,5 Sätze: mehr als
    // zwei Sätze heißt drei, weniger heißt zwei, ein anderer Ausgang existiert
    // nicht. Damit steht der Markt auf demselben Schlüssel wie die
    // Gesamtsätze-Wette der übrigen Bücher.
    //
    // Die Verankerung auf "Best-of-3" ist keine Vorsicht, sondern notwendig:
    // im Best-of-5 sind drei, vier und fünf Sätze möglich, und die Gleichung
    // stimmt dann nicht mehr.
    if (name.startsWith('sätze im match') && name.includes('best-of-3')) {
      const market: CanonicalMarket = { type: 'OU', period: 'FT', line: 2.5, subject: null, unit: 'SETS' }
      for (const r of results) {
        const n = /^([23]) sätze$/.exec((r.name?.value ?? '').trim().toLowerCase())?.[1]
        if (!n) continue
        push(market, n === '3' ? 'OVER' : 'UNDER', num(r.odds))
      }
      continue
    }

    // Bekannt und bewusst draußen — ohne Warnung verwerfen. Die Satz-Wette ist
    // ein genaues Ergebnis mit vier Seiten, "Sieg trotz Rückstand" und
    // "Mindestens ein Satz" haben einen anderen Gegenstand, der Tie-Break
    // ebenfalls.
    const known =
      /^satz-wette|^tie-?break|^mindestens ein satz|^sieg trotz|^sätze im match|genaues ergebnis|aufschlag|^ass|doppelfehler|spiele im match|^anzahl games/.test(
        name,
      )
    if (!known) noteUnmapped(bookId, `TENNIS ${raw}`)
  }

  return out
}

/* -------------------------------------------- Basketball, Eishockey, u. a. */

/**
 * Ordnet eine Auswahl einer der beiden Mannschaften zu.
 *
 * Nicht über Zeichengleichheit: bwin schreibt in der Siegwette die Kurzform
 * ("Panthers"), im Handicap den vollen Namen ("Florida Panthers"). Über
 * Wortmengen passt beides, und der geforderte Abstand verhindert, dass bei
 * "Los Angeles Lakers" gegen "Los Angeles Clippers" die gemeinsame Stadt
 * entscheidet.
 */
function teamSide(label: string, home: string, away: string): Side | null {
  const s = simplify(label)
  if (!s) return null
  if (s === simplify(home)) return 'HOME'
  if (s === simplify(away)) return 'AWAY'
  const tokens = teamTokens(label)
  if (!tokens.length) return null
  const h = tokenSimilarity(tokens, teamTokens(home))
  const a = tokenSimilarity(tokens, teamTokens(away))
  if (Math.max(h, a) < SUBJECT_THRESHOLD) return null
  if (Math.abs(h - a) < SUBJECT_MARGIN) return null
  return h > a ? 'HOME' : 'AWAY'
}

/**
 * Spielabschnitt aus der Beschriftung — inklusive der Verlängerungsfrage.
 *
 * Die Zuordnung folgt dem, was bwin an derselben Partie tatsächlich schreibt:
 *
 *   "Drei Wege (Nur reguläre Spielzeit)"                  → RT
 *   "3-Weg (reguläre Spielzeit)"                          → RT
 *   "Gesamt (inkl. Verlängerung und Penalties)"           → FT
 *   "Gesamtzahl"                                          → FT
 *
 * Die **reguläre** Spielzeit wird also ausdrücklich markiert, die Variante mit
 * Verlängerung meist gar nicht. Schweigen heißt darum FT. Wer es umgekehrt
 * annähme, würde die 3-Weg-Wette gegen die 2-Weg-Wette derselben Partie
 * rechnen — und die unterscheiden sich genau um die Verlängerung.
 *
 * Halbzeiten, Viertel und Drittel brauchen die Frage nicht: eine Verlängerung
 * liegt außerhalb von ihnen.
 */
function courtPeriod(name: string): Period {
  const s = name.toLowerCase()
  const q = /(\d)\.\s*(viertel|quarter)/.exec(s)
  if (q) return `Q${q[1]}` as Period
  const p = /(\d)\.\s*(drittel|periode)/.exec(s)
  if (p) return `P${p[1]}` as Period
  if (/1\.\s*(halbzeit|hälfte)/.test(s)) return 'H1'
  if (/2\.\s*(halbzeit|hälfte)/.test(s)) return 'H2'
  if (/regulär(e|er)\s+spielzeit/.test(s)) return 'RT'
  return 'FT'
}

/**
 * Märkte der Mannschaftssportarten aus `games`.
 *
 * Basketball, Eishockey, American Football und Handball teilen sich bei Entain
 * dieselbe Beschriftungssprache, deshalb ein gemeinsamer Abbilder. Anders als
 * beim Fußball steht die Linie **je Markt** in `attr` — außer beim Handicap,
 * wo sie ausschließlich im Optionstext steht ("Minnesota Lynx -14,5").
 */
function courtOutcomes(
  f: Fixture,
  home: string,
  away: string,
  bookId: string,
  sport: Sport,
): RawOutcome[] {
  const out: RawOutcome[] = []

  for (const g of f.games ?? []) {
    const raw = g.name?.value ?? ''
    const name = raw.toLowerCase()

    // Kombinationswetten sind Schnittmengen zweier Ereignisse, keine
    // Zerlegung eines einzelnen — "Siegwette und Gesamtscore" hat vier
    // Ausgänge, nicht zwei.
    //
    // Geprüft wird **ohne Klammerinhalte**: der Fußball-Abbilder kann `\bund\b`
    // blank auf den Namen anwenden, hier ginge das schief. "Handicap (inkl.
    // Verlängerung und Penaltyschießen)" und "Gesamt (inkl. Verlängerung und
    // Penalties)" sind echte Einzelmärkte, die das Wort nur im Zusatz führen —
    // eine blanke Prüfung hätte ausgerechnet die Hauptmärkte des Eishockeys
    // verworfen.
    if (/\bund\b/.test(name.replace(/\([^)]*\)/g, ' '))) continue
    const results = g.results ?? []
    const period = courtPeriod(raw)
    const attrLine = lineFrom(g.attr ?? '')

    const push = (market: CanonicalMarket, side: Side | null, odds: number | null) => {
      if (side && odds !== null && odds > 1) out.push({ market, side, odds })
    }

    // "Wie viele Punkte werden im Spiel erzielt?" ist trotz des Namens keine
    // Über/Unter-Wette, sondern eine Spannenwette ("131 bis 140"). Sie muss vor
    // der Punktzahl-Prüfung raus, sonst wird ihre erste Spanne zur Linie.
    if (/wie viele (punkte|tore).*(im spiel|erzielt\?$)/.test(name) && results.length > 2) continue

    // 3-Weg — nur die reguläre Spielzeit kann unentschieden enden.
    //
    // Das `!handicap` ist der Kern: bwin führt an derselben Eishockeypartie
    // "3-Weg (reguläre Spielzeit)" **und** "3-Weg Handicap (reguläre
    // Spielzeit) -2/+2". Ohne den Ausschluss verschluckt dieses Muster das
    // Handicap, wirft dessen Linie weg und legt es als schlichte Siegwette ab
    // — 14,50 / 14,50 / 1,06 landet dann auf demselben Schlüssel wie
    // 5,75 / 5,25 / 1,40. Das ist keine Ungenauigkeit, sondern eine andere
    // Wette. Der Handicap-Zweig weiter unten erkennt das Unentschieden selbst
    // und legt es korrekt als `EH` mit Linie ab.
    if (/^(drei wege|3-weg)/.test(name) && !/handicap|spread/.test(name)) {
      // Der Abschnitt wird abgeleitet, nicht festgeschrieben. Hier stand hart
      // `RT` — und bwin führt an derselben Partie "Drei Wege (Nur reguläre
      // Spielzeit)" **und** "Drei Wege - (1. Halbzeit)". Beide landeten auf
      // `1X2|RT`, also die Halbzeit auf dem Ganzspiel.
      //
      // Nur bei der ganzen Partie heißt drei Seiten „reguläre Spielzeit": ein
      // Unentschieden kann es dort nur geben, solange nicht verlängert wurde.
      // In einer Halbzeit oder einem Viertel ist das Remis der Normalfall.
      const p = courtPeriod(raw)
      const market: CanonicalMarket = {
        type: '1X2',
        period: p === 'FT' && OVERTIME_SPORTS.has(sport) ? 'RT' : p,
        line: null,
        subject: null,
      }
      for (const r of results) {
        const label = r.name?.value ?? ''
        const side = /^(x|unentschieden|remis)$/i.test(label.trim()) ? 'DRAW' : teamSide(label, home, away)
        push(market, side, num(r.odds))
      }
      continue
    }

    // Siegwette, 2-Weg. Ohne Unentschieden **muss** sie die Verlängerung
    // einschließen — sonst bliebe ein Ausgang unbezahlt.
    // "Zwei Weg" ausgeschrieben ist bwins Schreibweise im Eishockey — die
    // 2-Weg-Siegwette einschließlich Verlängerung und Penaltyschießen. Ohne
    // sie fiel der Hauptmarkt dieser Sportart wortlos durch.
    if (/siegwette|^2-weg|^zwei weg|^sieger$/.test(name) && !/spread|handicap/.test(name)) {
      const market: CanonicalMarket = { type: '2WAY', period, line: null, subject: null }
      for (const r of results) push(market, teamSide(r.name?.value ?? '', home, away), num(r.odds))
      continue
    }

    // Handicap. Die Prüfung ist bewusst lose ("enthält"), weil bwin den
    // Abschnitt mal voran- und mal nachstellt: "Spread", "1. Halbzeit
    // Handicap", "1. Viertel Spread", "Handicap (inkl. Verlängerung …)". Eine
    // verankerte Prüfung ließ das Halbzeit-Handicap durchfallen — 14 Märkte
    // allein im ersten Messlauf.
    if (/spread|handicap/.test(name)) {
      // Drei Seiten mit Unentschieden heißt europäisches Handicap. Das kann es
      // nur in der regulären Spielzeit geben, und es darf keinesfalls im
      // selben Topf landen wie das zweiseitige: bei letzterem gibt es kein
      // Remis, die Quoten sind deshalb systematisch niedriger.
      const draw = results.find((r) => /^(x|unentschieden|remis)$/i.test((r.name?.value ?? '').trim()))
      let line: number | null = null
      const parsed = results.map((r) => {
        const label = r.name?.value ?? ''
        if (r === draw) return { side: 'DRAW' as Side, odds: num(r.odds) }
        const p = splitHandicapLabel(label)
        const side = teamSide(p.who, home, away)
        if (side === 'HOME') line = p.line
        else if (side === 'AWAY' && p.line !== null && line === null) line = -p.line
        return { side, odds: num(r.odds) }
      })
      if (line === null) continue
      const market: CanonicalMarket = draw
        ? { type: 'EH', period: 'RT', line, subject: null }
        : { type: 'AH', period, line, subject: null }
      for (const p of parsed) push(market, p.side, p.odds)
      continue
    }

    if (/ungerade|gerade/.test(name)) {
      const market: CanonicalMarket = { type: 'OE', period, line: null, subject: null }
      for (const r of results) {
        const label = (r.name?.value ?? '').trim().toLowerCase()
        push(market, label.startsWith('ungerade') ? 'ODD' : label.startsWith('gerade') ? 'EVEN' : null, num(r.odds))
      }
      continue
    }

    // Gesamtzahl der Partie: "Gesamtzahl", "Gesamt der 1. Halbzeit",
    // "Gesamt (inkl. Verlängerung und Penalties)".
    if (/^gesamt(zahl|summe)?\b/.test(name)) {
      if (attrLine === null) continue
      const market: CanonicalMarket = { type: 'OU', period, line: attrLine, subject: null }
      for (const r of results) push(market, overUnderSide(r.name?.value ?? ''), num(r.odds))
      continue
    }

    // Team-Total: "Wie viele Punkte erzielt Minnesota Lynx?", "… wird Toronto
    // Tempo erzielen?", "… erzielt Connecticut Sun in der 2. Hälfte?".
    // Der Mannschaftsname steckt mitten im Satz; der Wortmengenvergleich stört
    // sich an den Frageworten nicht, weil er durch die kleinere Menge teilt.
    // Die englische Fassung ist kein Sonderfall, sondern kommt vermischt in
    // derselben Antwort vor ("How many points will … score in the 1st half?")
    // — bwin übersetzt einzelne Märkte nicht.
    if (/^wie viele (punkte|tore)|^how many (points|goals)/.test(name)) {
      if (attrLine === null) continue
      const subject = teamSide(raw, home, away)
      if (subject !== 'HOME' && subject !== 'AWAY') {
        noteUnmapped(bookId, `unklares Team :: ${raw}`)
        continue
      }
      const market: CanonicalMarket = { type: 'TEAM_OU', period, line: attrLine, subject }
      for (const r of results) push(market, overUnderSide(r.name?.value ?? ''), num(r.odds))
      continue
    }

    // Bekannt und bewusst draußen: Kombinationen, genaue Ergebnisse,
    // Spielerwetten und Spannenwetten haben kein zweiseitiges Gegenstück.
    const known =
      /halbzeit ?[/|]? ?endstand|genaues ergebnis|doppelte chance|einsatz zurück|torschütze|spieler|^rennen zu|erreicht als erstes|beide teams|gewinnt (beide|mind)|siegt mit|differenz|margin|^wetten ohne|highest|niedrigste|verlängerung\?$|penaltyschießen\?$|^wird es|mit den meisten (punkten|toren)|^welches (viertel|drittel)/.test(
        name,
      )
    if (!known) noteUnmapped(bookId, `TEAM ${raw}`)
  }

  return out
}

/** "Mehr als 182,5" / "Weniger als 182,5" → OVER / UNDER */
function overUnderSide(raw: string): Side | null {
  const n = raw.trim().toLowerCase()
  if (n.startsWith('mehr als') || n.startsWith('über') || n.startsWith('over')) return 'OVER'
  if (n.startsWith('weniger als') || n.startsWith('unter') || n.startsWith('under')) return 'UNDER'
  return null
}

/* -------------------------------------------------------------- Volleyball */

/**
 * Volleyball läuft über `optionMarkets` — mit **strukturierten** Parametern.
 *
 * Das ist der bequemste Fall im ganzen Adapter: statt aus "Gesamtzahl der
 * Sätze" auf die Einheit zu schließen, steht sie als `Happening=Set` da, die
 * Linie als `DecimalValue=3.5` und die Art als `MarketType=Over/Under`.
 *
 * Die Einheit ist hier keine Kosmetik: eine Partie führt Gesamtsätze 3,5 neben
 * Gesamtpunkten 180,5. Ohne `unit` fielen beide auf denselben Schlüssel.
 */
function volleyMarket(m: OptionMarket): CanonicalMarket | null {
  const p = new Map<string, string>()
  for (const x of m.parameters ?? []) if (x.key) p.set(x.key, x.value ?? '')

  const type = p.get('MarketType')
  if (!type) return null
  // Sätze oder Punkte — beide Linien existieren nebeneinander.
  const unit: Unit | undefined =
    p.get('Happening') === 'Set' ? 'SETS' : p.get('Happening') === 'Point' ? 'POINTS' : undefined
  const period = p.get('Period') === 'FullTime' ? 'FT' : null
  // Satzbezogene Abschnitte hat bwin hier noch nicht geliefert; alles außer
  // der ganzen Partie bleibt deshalb draußen statt geraten zu werden.
  if (!period) return null

  if (type === '2way') return { type: '2WAY', period, line: null, subject: null }
  if (type === 'Over/Under') {
    const line = num(p.get('DecimalValue'))
    return line === null ? null : { type: 'OU', period, line, subject: null, unit }
  }
  if (type === '2wayHandicap') {
    const line = num(p.get('DecimalHandicap'))
    return line === null ? null : { type: 'AH', period, line, subject: null, unit }
  }
  return null
}

/**
 * Volleyball-Ausgänge.
 *
 * Beim Handicap wird die Linie **aus dem Optionstext** genommen ("Slowenien
 * (1,5)"), nicht aus `DecimalHandicap`: der Parameter nennt den Betrag, sagt
 * aber nicht, auf welche Seite er sich bezieht. Das Modell führt die Linie aus
 * Heimsicht, und die steht nur im Text.
 */
function volleyOutcomes(f: Fixture, home: string, away: string, bookId: string): RawOutcome[] {
  const out: RawOutcome[] = []

  for (const m of f.optionMarkets ?? []) {
    const base = volleyMarket(m)
    if (!base) {
      const name = m.name?.value ?? ''
      const known =
        /gewinnt einen satz|genaue anzahl|und das match|gewinnt den ersten|handicap punkte|correct score|genaues ergebnis/i.test(
          name,
        )
      if (!known) noteUnmapped(bookId, `VOLLEY ${name}`)
      continue
    }

    if (base.type === 'AH') {
      let line: number | null = null
      const parsed = (m.options ?? []).map((o) => {
        const raw = (o.name?.value ?? '').replace(/[()]/g, ' ')
        const p = splitHandicapLabel(raw)
        const side = teamSide(p.who, home, away)
        if (side === 'HOME') line = p.line
        else if (side === 'AWAY' && p.line !== null && line === null) line = -p.line
        return { side, odds: num(o.price?.odds) }
      })
      if (line === null) continue
      const market: CanonicalMarket = { ...base, line }
      for (const p of parsed)
        if (p.side && p.odds !== null && p.odds > 1) out.push({ market, side: p.side, odds: p.odds })
      continue
    }

    for (const o of m.options ?? []) {
      const odds = num(o.price?.odds)
      if (odds === null || odds <= 1) continue
      const label = o.name?.value ?? ''
      const side = base.type === '2WAY' ? teamSide(label, home, away) : overUnderSide(label)
      if (side) out.push({ market: base, side, odds })
    }
  }

  return out
}

/**
 * Ermittelt Heim- und Auswärtsteam.
 *
 * Achtung: `fixture-view` mit `offerMapping=All` liefert in `participants`
 * den kompletten Kader beider Mannschaften — dutzende Spielernamen, nicht
 * die zwei Teams. Nur wenn dort genau zwei Einträge stehen, sind es die
 * Teams; sonst ist der Fixture-Name ("Heim - Auswärts") die verlässliche
 * Quelle. Ein bekanntes Team-Paar aus dem Sweep hat immer Vorrang.
 */
function teamsOf(f: Fixture, known?: { home: string; away: string }): { home: string; away: string } | null {
  if (known) return known

  // Die US-Ligen werden andersherum benannt: "Chicago Bears bei Carolina
  // Panthers" heißt, dass Chicago **auswärts** spielt. `participants` folgt
  // dieser Reihenfolge, steht also ebenfalls falsch herum. Gemessen an drei
  // NFL-Partien: participants[0] ist durchgehend das zuerst genannte Team.
  //
  // Ohne diese Prüfung führte der Adapter jede NFL-Partie gedreht. Die
  // Ausrichtung in `match.ts` fängt das zwar ab, solange ein anderes Buch
  // widerspricht — aber sie fängt es über den Anker ab, und ist bwin der
  // Anker, übernimmt der ganze Fund die falsche Seite. Die Quoten passen dann
  // zwar zueinander, in der Liste steht aber das Auswärtsteam als Heim.
  const away0 = / bei | at | @ /.test(f.name?.value ?? '')

  const p = f.participants
  if (p?.length === 2 && p[0]?.name?.value && p[1]?.name?.value) {
    const a = p[0].name.value
    const b = p[1].name.value
    return away0 ? { home: b, away: a } : { home: a, away: b }
  }

  const raw = f.name?.value ?? ''
  const parts = away0 ? raw.split(/ bei | at | @ /) : raw.split(' - ')
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    const a = parts[0].trim()
    const b = parts[1].trim()
    return away0 ? { home: b, away: a } : { home: a, away: b }
  }
  return null
}

function toRawEvent(
  f: Fixture,
  brand: Brand,
  known?: { home: string; away: string },
  sport: Sport = 'FOOTBALL',
): RawEvent | null {
  const teams = teamsOf(f, known)
  if (!teams) return null
  const { home, away } = teams

  const outcomes: RawOutcome[] = []
  if (sport === 'TENNIS') {
    outcomes.push(...tennisOutcomes(f, home, away, brand.id))
  } else if (sport === 'VOLLEYBALL') {
    outcomes.push(...volleyOutcomes(f, home, away, brand.id))
  } else if (sport !== 'FOOTBALL') {
    // Basketball, Eishockey, American Football, Handball und Darts liefern
    // ihre Märkte wie Tennis über `games`; `optionMarkets` ist dort leer.
    outcomes.push(...courtOutcomes(f, home, away, brand.id, sport))
  } else {
    for (const m of f.optionMarkets ?? []) {
      const market = toMarket(m, home, away, brand.id)
      if (!market) continue
      for (const opt of m.options ?? []) {
        const odds = num(opt.price?.odds)
        if (odds === null || odds <= 1) continue
        const side = toSide(opt, market, home, away)
        if (side) outcomes.push({ market, side, odds })
      }
    }
  }
  if (!outcomes.length) return null

  return {
    bookmakerId: brand.id,
    bookEventId: f.id,
    sportradarId: f.addons?.betRadar ?? null,
    sport: SPORT_LABEL[sport],
    league: [f.region?.name?.value, f.competition?.name?.value].filter(Boolean).join(' — '),
    home,
    away,
    startTime: new Date(f.startDate).toISOString(),
    isLive: f.stage === 'Live',
    // Der Deeplink braucht die zusammengesetzte ID inklusive Präfix
    // ("2:7835172"). Ohne das Präfix landet man auf der Startseite — und bei
    // einer Arbitrage, die Sekunden lebt, ist Suchen von Hand keine Option.
    url: `https://${brand.webHost}/de/sports/events/${f.id}`,
    outcomes,
    fetchedAt: new Date().toISOString(),
  }
}

function makeAdapter(brand: Brand): BookmakerAdapter {
  const api = `https://${brand.host}/cds-api/bettingoffer`
  const q = `x-bwin-accessid=${ACCESS_ID}&lang=de&country=DE&userCountry=DE`

  return {
    id: brand.id,
    name: brand.name,
    transport: 'impit',

    async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
      const cutoff = Date.now() + ctx.windowMs
      const out: RawEvent[] = []

      let skip = 0
      let total = Infinity

      // **Ein** Durchlauf über das gesamte Angebot statt einer Abfrage je
      // Sportart. Der Grund ist nicht Bequemlichkeit, sondern Vollständigkeit:
      // die Sportkennungen sind nur dort zu messen, wo gerade Partien laufen.
      // Handball hatte Ende Juli **keine einzige** — die Kennung wäre also
      // geraten gewesen und hätte sich erst im September als richtig oder
      // falsch gezeigt.
      //
      // bwin benennt seine Sportarten auf Deutsch exakt so, wie das Modell sie
      // führt ("Fußball", "Eishockey", "American Football"), deshalb genügt
      // `sportFromLabel`. Kommt Handball zurück, wird es ohne Codeänderung
      // mitgenommen; kommt Schach, fällt es durch.
      //
      // Billiger ist es obendrein: acht Einzelabfragen kosteten vierzehn
      // Seiten, der Gesamtdurchlauf neun (rund 860 Partien bei `take=100`).
      while (skip < total && out.length < ctx.maxEvents) {
        const page = await fetchJson<{ fixtures?: Fixture[]; totalCount?: number }>(
          `${api}/fixtures?${q}&fixtureTypes=Standard&state=Latest&offerMapping=Filtered` +
            `&offerCategories=Gridable&fixtureCategories=Gridable,NonGridable,Other` +
            `&skip=${skip}&take=${PAGE_SIZE}&sortBy=Tags`,
          OPTS,
        )
        const fixtures = page.fixtures ?? []
        total = page.totalCount ?? fixtures.length
        if (!fixtures.length) break

        for (const f of fixtures) {
          if (new Date(f.startDate).getTime() > cutoff) continue
          const sport = sportFromLabel(f.sport?.name?.value ?? '')
          if (!sport) continue
          const ev = toRawEvent(f, brand, undefined, sport)
          if (ev) out.push(ev)
        }
        skip += PAGE_SIZE
      }
      return out.slice(0, ctx.maxEvents)
    },

    async fetchDepth(events: RawEvent[]): Promise<RawEvent[]> {
      const results = await pooled(events, 4, async (ev) => {
        const view = await fetchJson<{ fixture?: Fixture }>(
          `${api}/fixture-view?${q}&offerMapping=All&scoreboardMode=Full&fixtureIds=${ev.bookEventId}` +
            `&state=Latest&useRegionalisedConfiguration=true&statisticsModes=None`,
          OPTS,
        )
        // Teamnamen aus dem Sweep mitgeben — im Detailabruf sind sie
        // unbrauchbar (siehe teamsOf).
        const sport: Sport = sportFromLabel(ev.sport) ?? 'FOOTBALL'
        const deep = view.fixture
          ? toRawEvent(view.fixture, brand, { home: ev.home, away: ev.away }, sport)
          : null
        return deep ? { ...deep, league: ev.league, url: ev.url } : ev
      })
      return results.map((r, i) => (r.status === 'fulfilled' ? r.value : events[i]))
    },
  }
}

export const bwin = makeAdapter({
  id: 'bwin',
  name: 'bwin',
  host: 'www.bwin.de',
  webHost: 'sports.bwin.de',
})

/**
 * Sportingbet und ODDSET laufen auf derselben Entain-Plattform. Beide
 * kosten je eine Zeile Konfiguration — kein neuer Adapter, kein neues
 * Markt-Mapping. Genau dafür ist die Plattform-Parametrisierung da.
 */
export const oddset = makeAdapter({
  id: 'oddset',
  name: 'ODDSET',
  host: 'www.oddset.de',
  webHost: 'sports.oddset.de',
})

export const sportingbet = makeAdapter({
  id: 'sportingbet',
  name: 'Sportingbet',
  // Wie bei bwin liegt die Daten-API auf `www`, die Oberfläche auf `sports`.
  // Über `sports.sportingbet.de` läuft die cds-api in einen 30-Sekunden-
  // Timeout — das hat den kompletten Refresh-Takt blockiert.
  host: 'www.sportingbet.de',
  // `sports.` war beim Test zeitweise gar nicht erreichbar; `www.` antwortet
  // zuverlässig und nimmt dieselbe Event-URL an.
  webHost: 'www.sportingbet.de',
})
