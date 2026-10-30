import { fetchJson, pooled } from '../http.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport, Unit } from '../types.ts'
import { OVERTIME_SPORTS, SPORT_LABEL, sportFromLabel, sportOf } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'
import { halfOf, lineFromText, num, oddEvenSide, simplify, teamSide, yesNoSide } from './labels.ts'
import { nameMatch } from '../players.ts'

/**
 * Entains „cds-api“ — bwin, Sportingbet, ODDSET.
 *
 * Sweep mit `offerMapping=Filtered` (~13 Märkte je Partie), Tiefe einzeln
 * über `fixture-view` mit `offerMapping=All` (~87 Märkte, aber 16,8 MB je 100
 * Partien).
 */

/** Statische, öffentliche Client-ID, kein Zugangstoken. */
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
  /** Strukturierte Beschreibung — nur bei manchen Sportarten (Volleyball), dann verlässlicher als der Name. */
  parameters?: { key?: string; value?: string }[]
}

/**
 * Markt in der Darstellung für Tennis und Mannschaftssportarten außer
 * Fußball: `games` statt `optionMarkets` (dort leer), `results` statt
 * `options`, `odds` als blanke Zahl.
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
  sport?: { id?: number; name?: { value?: string } }
  participants?: { name: { value: string } }[]
  competition?: { name: { value: string } }
  region?: { name: { value: string } }
  addons?: { betRadar?: number }
  optionMarkets?: OptionMarket[]
  games?: Game[]
  totalMarketsCount?: number
}

const periodOf = (name: string): Period => halfOf(name) ?? 'FT'

export function toMarket(m: OptionMarket, home: string, away: string, bookId: string): CanonicalMarket | null {
  const raw = m.name?.value ?? ''
  const name = raw.toLowerCase()
  const period = periodOf(raw)
  const firstOption = m.options?.[0]?.name?.value ?? ''

  // Kombinationswetten ("Spielresultat und Gesamtanzahl Tore 2,5") sind
  // Schnittmengen zweier Ereignisse, keine Zerlegung.
  if (/\bund\b/.test(name)) return null

  // Restzeit-Märkte laufender Spiele meinen nur die verbleibende Spielzeit.
  if (/restzeit|restliche|rest der|ab jetzt|nächste[rs]?\s/.test(name)) return null

  if (
    name === 'spielresultat' ||
    name.startsWith('spielresultat -') ||
    name.startsWith('endergebnis') ||
    name.startsWith('ergebnis') ||
    name.includes('1x2')
  )
    return { type: '1X2', period, line: null, subject: null }

  // Exakt, nicht „enthält“: „Beide Teams treffen in beiden Hälften“ ist eine
  // andere Wette und ergab gegen die normale Form Scheinrenditen von 85 %.
  if (/^beide (teams|mannschaften) treffen( in der [12]\. hälfte)?$/.test(name))
    return { type: 'BTTS', period, line: null, subject: null }

  if (/^(gesamtanzahl tore )?(un)?gerade\/(un)?gerade( - [12]\. hälfte)?$/.test(name))
    return { type: 'OE', period, line: null, subject: null }

  // Asiatische Handicaps erstatten bei bestimmten Ergebnissen — nicht ins europäische.
  if (name.includes('handicap') && !name.includes('asian') && !name.includes('asiatisch')) {
    const line = lineFromText(m.attr ?? raw)
    return line === null ? null : { type: 'EH', period, line, subject: null }
  }

  if (name.includes('gesamtanzahl tore') || name.includes('gesamtzahl der tore')) {
    const line = lineFromText(m.attr ?? '') ?? lineFromText(firstOption)
    if (line === null) return null

    // "Velez Sarsfield - Gesamtanzahl Tore" ist ein Team-Total, ohne Präfix
    // das Gesamtergebnis. Verwechselt ergibt das Phantom-Arbs.
    const rawPrefix = raw.split(' - ')[0] ?? ''
    const prefix = simplify(rawPrefix)
    const subject = teamSide(rawPrefix, home, away)
    if (subject) return { type: 'TEAM_OU', period, line, subject }

    // Unbekanntes Präfix: verwerfen statt raten.
    const generic = ['gesamtanzahltore', 'gesamtzahldertore', '1halfte', '2halfte']
    if (prefix && !generic.includes(prefix)) {
      // "Gesamtanzahl Tore (0-4+)" ist eine bekannte Intervallwette, kein unklares Präfix.
      if (!/\(\d+-\d+\+?\)/.test(raw)) noteUnmapped(bookId, `unklares Präfix :: ${raw}`)
      return null
    }
    return { type: 'OU', period, line, subject: null }
  }

  // Bekannt und bewusst ausgeschlossen (überlappende, erstattete oder
  // vielseitige Märkte) — still verwerfen, sonst verdrängen sie echte Lücken
  // aus `/api/diagnostics`.
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
  if (market.type === 'OU' || market.type === 'TEAM_OU') return overUnderSide(raw)
  if (market.type === 'BTTS') return yesNoSide(n)
  if (market.type === 'OE') return oddEvenSide(n)
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
 * Ordnet eine Auswahl einem Spieler zu. Die Schreibweise wechselt in
 * derselben Antwort ("A. Hernandez" / "Alex Hernandez (MEX) −1,5").
 */
function playerSide(label: string, home: string, away: string): Side | null {
  const h = nameMatch(label, home)
  const a = nameMatch(label, away)
  if (h > a) return 'HOME'
  if (a > h) return 'AWAY'
  return null
}

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

    // Satz-Handicap: zwei Märkte je Partie (Heim +1,5 und −1,5). Die Linie
    // steht nur im Text und gilt aus Heimsicht.
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

    // "Sätze im Match (Best-of-3)": „2 Sätze“/„3 Sätze“ ist dort exakt
    // Über/Unter 2,5 Sätze. Im Best-of-5 gilt das nicht.
    if (name.startsWith('sätze im match') && name.includes('best-of-3')) {
      const market: CanonicalMarket = { type: 'OU', period: 'FT', line: 2.5, subject: null, unit: 'SETS' }
      for (const r of results) {
        const n = /^([23]) sätze$/.exec((r.name?.value ?? '').trim().toLowerCase())?.[1]
        if (!n) continue
        push(market, n === '3' ? 'OVER' : 'UNDER', num(r.odds))
      }
      continue
    }

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
 * Spielabschnitt aus der Beschriftung. bwin markiert die **reguläre**
 * Spielzeit ausdrücklich ("Drei Wege (Nur reguläre Spielzeit)"), die Variante
 * mit Verlängerung meist nicht — ohne Angabe gilt deshalb FT.
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
 * Märkte der Mannschaftssportarten außer Fußball. Die Linie steht je Markt
 * in `attr`, beim Handicap nur im Optionstext ("Minnesota Lynx -14,5").
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

    // Kombinationswetten raus — aber ohne Klammerinhalt prüfen: "Gesamt
    // (inkl. Verlängerung und Penalties)" ist ein echter Einzelmarkt.
    if (/\bund\b/.test(name.replace(/\([^)]*\)/g, ' '))) continue
    const results = g.results ?? []
    const period = courtPeriod(raw)
    const attrLine = lineFromText(g.attr ?? '')

    const push = (market: CanonicalMarket, side: Side | null, odds: number | null) => {
      if (side && odds !== null && odds > 1) out.push({ market, side, odds })
    }

    // "Wie viele Punkte werden im Spiel erzielt?" ist eine Spannenwette, kein Über/Unter.
    if (/wie viele (punkte|tore).*(im spiel|erzielt\?$)/.test(name) && results.length > 2) continue

    // 3-Weg. Ohne `!handicap` würde "3-Weg Handicap -2/+2" als Siegwette
    // ohne Linie abgelegt — eine andere Wette auf demselben Schlüssel.
    if (/^(drei wege|3-weg)/.test(name) && !/handicap|spread/.test(name)) {
      // Abschnitt ableiten, nicht festschreiben ("Drei Wege - (1. Halbzeit)").
      // Nur über die ganze Partie heißt drei Seiten „reguläre Spielzeit“.
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

    // Siegwette 2-Weg — schließt ohne Unentschieden die Verlängerung ein.
    // "Zwei Weg" ist bwins Schreibweise im Eishockey.
    if (/siegwette|^2-weg|^zwei weg|^sieger$/.test(name) && !/spread|handicap/.test(name)) {
      const market: CanonicalMarket = { type: '2WAY', period, line: null, subject: null }
      for (const r of results) push(market, teamSide(r.name?.value ?? '', home, away), num(r.odds))
      continue
    }

    // Handicap — bewusst „enthält“, weil der Abschnitt mal vor-, mal
    // nachgestellt ist ("1. Viertel Spread", "Handicap (inkl. …)").
    if (/spread|handicap/.test(name)) {
      // Mit Unentschieden ist es ein europäisches Handicap (nur reguläre
      // Spielzeit) und darf nicht zum zweiseitigen.
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
        push(market, oddEvenSide(label), num(r.odds))
      }
      continue
    }

    // "Gesamtzahl", "Gesamt der 1. Halbzeit", "Gesamt (inkl. Verlängerung …)"
    if (/^gesamt(zahl|summe)?\b/.test(name)) {
      if (attrLine === null) continue
      const market: CanonicalMarket = { type: 'OU', period, line: attrLine, subject: null }
      for (const r of results) push(market, overUnderSide(r.name?.value ?? ''), num(r.odds))
      continue
    }

    // Team-Total: "Wie viele Punkte erzielt Minnesota Lynx?" — auch englisch
    // vermischt in derselben Antwort.
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
 * Volleyball liefert strukturierte Parameter (`Happening=Set`,
 * `DecimalValue=3.5`, `MarketType=Over/Under`). Die Einheit ist nötig:
 * Gesamtsätze 3,5 und Gesamtpunkte 180,5 stehen nebeneinander.
 */
function volleyMarket(m: OptionMarket): CanonicalMarket | null {
  const p = new Map<string, string>()
  for (const x of m.parameters ?? []) if (x.key) p.set(x.key, x.value ?? '')

  const type = p.get('MarketType')
  if (!type) return null
  const unit: Unit | undefined =
    p.get('Happening') === 'Set' ? 'SETS' : p.get('Happening') === 'Point' ? 'POINTS' : undefined
  const period = p.get('Period') === 'FullTime' ? 'FT' : null
  // Satzabschnitte liefert bwin hier nicht; alles außer der ganzen Partie bleibt draußen.
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
 * Beim Handicap kommt die Linie aus dem Optionstext ("Slowenien (1,5)"):
 * `DecimalHandicap` nennt nur den Betrag, nicht die Seite.
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
 * Heim- und Auswärtsteam. `fixture-view` liefert in `participants` den
 * ganzen Kader, deshalb nur bei genau zwei Einträgen verwenden, sonst den
 * Namen ("Heim - Auswärts"). Ein bekanntes Paar aus dem Sweep geht vor.
 */
function teamsOf(f: Fixture, known?: { home: string; away: string }): { home: string; away: string } | null {
  if (known) return known

  // US-Schreibweise "Chicago Bears bei Carolina Panthers": das erste Team
  // spielt auswärts, auch in `participants`.
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
    // Die ID trägt ihr Präfix ("2:7835172"); ohne landet der Link auf der Startseite.
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

      // Ein Durchlauf über das ganze Angebot statt einer Abfrage je Sportart:
      // keine geratenen Sportkennungen, und billiger (9 statt 14 Seiten). Die
      // deutschen Sportnamen passen direkt auf `sportFromLabel`.
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
        // Teamnamen aus dem Sweep — im Detailabruf unbrauchbar (siehe teamsOf).
        const sport = sportOf(ev.sport)
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

export const oddset = makeAdapter({
  id: 'oddset',
  name: 'ODDSET',
  host: 'www.oddset.de',
  webHost: 'sports.oddset.de',
})

export const sportingbet = makeAdapter({
  id: 'sportingbet',
  name: 'Sportingbet',
  // Daten-API auf `www.`: über `sports.` läuft die cds-api in einen 30-s-Timeout.
  host: 'www.sportingbet.de',
  // `sports.` war zeitweise nicht erreichbar; `www.` nimmt dieselbe Event-URL an.
  webHost: 'www.sportingbet.de',
})
