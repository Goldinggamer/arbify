import { fetchJson } from '../http.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport, Unit } from '../types.ts'
import { SPORT_LABEL } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { inWindow } from './types.ts'
import { deepen } from './depth.ts'
import { noteUnmapped } from '../diagnostics.ts'
import { teamTokens, tokenSimilarity } from '../match.ts'

/**
 * Kambi — öffentliche Offering-API, Marke über ein Kürzel im Pfad (LeoVegas).
 *
 * Quoten und Linien kommen als Ganzzahl × 1000. Keine Sportradar-ID; dafür
 * `homeName`/`awayName` getrennt. Die Zuordnung ist eine Positivliste:
 * Ecken und Tore haben dasselbe Format und dürfen nicht verwechselt werden.
 */

const API = 'https://eu-offering-api.kambicdn.com/offering/v2018'
const QUERY = 'lang=de_DE&market=DE&client_id=2&channel_id=1&ncid=1'
const OPTS = { transport: 'impit' as const, minIntervalMs: 100 }

type Brand = {
  id: string
  name: string
  code: string
  webHost: string
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
  /** `englishLabel` ist verlässlicher: die deutsche Beschriftung schwankt selbst innerhalb einer Antwort. */
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

/** Fußball-Kriterien. Positivliste: was hier nicht steht, wird verworfen. */
export function toMarket(
  offer: BetOffer,
  outcome: KambiOutcome,
  home: string,
  away: string,
  bookId: string,
): CanonicalMarket | null {
  const label = offer.criterion?.label ?? ''
  // Gedanken- und Bindestrich vereinheitlichen, Kambi mischt beide.
  const l = label.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()
  const line = dec(outcome.line)

  /** Hängt an einem Kriterium eine Halbzeitangabe? `null`: unbekannter Zusatz. */
  const suffixPeriod = (rest: string): Period | null => {
    const s = rest.trim()
    if (!s) return 'FT'
    if (/^- 1\. (hälfte|halbzeit)$/.test(s)) return 'H1'
    if (/^- 2\. (hälfte|halbzeit)$/.test(s)) return 'H2'
    return null
  }

  // "Reguläre Spielzeit" ist das Endergebnis, "Halbzeit" die erste Hälfte.
  if (l === 'reguläre spielzeit') return { type: '1X2', period: 'FT', line: null, subject: null }
  if (l === 'halbzeit' || l === '1. hälfte') return { type: '1X2', period: 'H1', line: null, subject: null }
  if (l === '2. hälfte') return { type: '1X2', period: 'H2', line: null, subject: null }

  // "… in beiden Hälften" fällt über `suffixPeriod` heraus.
  if (l.startsWith('beide teams treffen')) {
    const period = suffixPeriod(l.slice('beide teams treffen'.length))
    return period ? { type: 'BTTS', period, line: null, subject: null } : null
  }

  // "Gesamttore" trägt Über/Unter und die Parität ("Gesamttore ungerade/gerade").
  // Die Parität zuerst — sonst fällt sie im Über/Unter-Zweig still durch.
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

  // "Gesamte Treffer von Cerro Porteño" — Team-Total.
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

  // Nur die Drei-Wege-Schreibweisen. "Handicap" ohne Zusatz ist bei Kambi die
  // zweiwegige asiatische Linie und gehört nicht ins europäische Handicap.
  const eh = /^(drei-wege-handicap|3-wege[- ]handicap)/.exec(l)
  if (eh) {
    const period = suffixPeriod(l.slice(eh[0].length))
    if (!period || line === null) return null
    return { type: 'EH', period, line, subject: null }
  }

  if (l === 'gerade/ungerade' || l === 'ungerade/gerade')
    return { type: 'OE', period: 'FT', line: null, subject: null }

  // Bekannt und bewusst draußen — still verwerfen. Kambi führt Ecken und
  // Schüsse je Team und Intervall; ungefiltert fluten sie `/api/diagnostics`.
  const known =
    /doppelte chance|unentschieden keine wette|korrektes ergebnis|asian|^handicap$|ecken|eckstöße|eckbälle|schüsse|paraden|opta|karten|nächste|nächstes tor|erstes tor|art des nächsten tors|interval|\d+:\d{2}-\d+:\d{2}|siegt|gewinnt mindestens|spieler|trifft|erzielt|vorlage|halbzeit\/|torschütze|tor in beiden|eigentor|elfmeter/.test(
      l,
    )
  if (!known) noteUnmapped(bookId, `${label} | ${offer.betOfferType?.name ?? ''}`)
  return null
}

/**
 * Tennis-Kriterien. Satz- und Spiele-Handicap sehen strukturell gleich aus
 * und unterscheiden sich nur in der Beschriftung — deshalb trägt der
 * Schlüssel die Einheit.
 */
function toTennisMarket(
  offer: BetOffer,
  home: string,
  away: string,
  bookId: string,
): CanonicalMarket | null {
  const label = offer.criterion?.label ?? ''
  const l = label.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()

  /** Handicap-Linien stehen gespiegelt an beiden Seiten; maßgeblich ist Heim (OT_ONE). */
  const homeLine = (): number | null => {
    const one = (offer.outcomes ?? []).find((o) => o.type === 'OT_ONE')
    return dec(one?.line)
  }
  /** Bei Über/Unter tragen beide Seiten denselben Wert. */
  const anyLine = (): number | null => dec((offer.outcomes ?? [])[0]?.line)

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

  // "Spiele insgesamt" und "Spiele insgesamt - Satz 1".
  const totalGames = /^spiele insgesamt(?: - satz ([1-5]))?$/.exec(l)
  if (totalGames) {
    const line = anyLine()
    if (line === null) return null
    const period = (totalGames[1] ? `S${totalGames[1]}` : 'FT') as CanonicalMarket['period']
    return { type: 'OU', period, line, subject: null, unit: 'GAMES' }
  }

  // "Gesamte Spiele gewonnen von Alex Hernandez" — Spieler-Total.
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

  // Bekannt und bewusst draußen: dreiseitige Märkte (OT_CROSS), andere
  // Gegenstände (Tiebreaks, Breaks, Aufschlag) und Live-Märkte auf einzelne
  // Spiele und Punkte, die sonst den halben Bericht füllen.
  const known =
    /^(satzwetten|korrektes ergebnis|meisten asse|die meisten spiele|tiebreaks insgesamt|gesamtes break punkte|total number of service breaks|asse insgesamt|doppelfehler)/.test(
      l,
    ) ||
    /gewinnt mindestens einen satz|gewinnt sein .*aufschlagspiel|erstaufschlag|holt den ersten|breakpunkt|as$|aufschlag/.test(
      l,
    ) ||
    /spiel \d+|punkt \d+|deuce|tie ?break|gesamtpunktzahl|game handicap - satz|satz \d+ - spiel/.test(l)
  if (!known) noteUnmapped(bookId, `TENNIS ${label} | ${offer.betOfferType?.name ?? ''}`)
  return null
}

/* ------------------------ Basketball, Eishockey, Volleyball, Darts u. a. */

/**
 * Übrige Sportarten aus dem **englischen** Kriterium: Grundbegriff plus
 * Zusätze für Abschnitt und Verlängerung ("Puck Line - Regular Time",
 * "Total Points by X - 2nd Half - Including Overtime"). Eishockey führt jede
 * Wette mit und ohne Verlängerung — die dürfen nie gegeneinander laufen.
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

  /** Abschnitt oder Verlängerungsregel eines Zusatzes; `null`: unbekannt. */
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

  // Jeder Zusatz muss verstanden sein: "Quarter 1 - First to 15 Points" ist
  // ein Punkterennen, kein Viertelsieger.
  let period: Period = 'FT'
  for (const s of suffixes) {
    const a = abschnitt(s)
    if (a === null) {
      noteUnmapped(bookId, `${sport} unbekannter Zusatz :: ${raw}`)
      return null
    }
    if (a !== 'ot') period = a
  }
  // Abschnitt im Grundbegriff selbst ("Quarter 1", "Set 2").
  const ausBasis = abschnitt(base)
  if (ausBasis && ausBasis !== 'ot') period = ausBasis

  // Einheit nur, wo die Sportart mehr als eine führt — siehe `Unit`.
  const unitOf = (kind: 'points' | 'sets' | 'legs' | 'goals'): Unit | undefined => {
    if (sport === 'VOLLEYBALL') return kind === 'sets' ? 'SETS' : 'POINTS'
    if (sport === 'DARTS') return kind === 'sets' ? 'SETS' : 'LEGS'
    return undefined
  }

  // Bekannt und bewusst draußen. "Draw No Bet" erstattet beim Remis und ist
  // keine echte Zweiwegwette.
  if (
    /^(draw no bet|correct score|double chance|winning margin|half time\/full time|race to|highest scoring|which team|method of|\d+\+ )/.test(
      base,
    ) ||
    /by the player|player performance|to win (both|either)|margin of victory/.test(raw)
  )
    return null

  // Siegwette: das Kreuz unter den Ausgängen entscheidet über drei- oder
  // zweiseitig, nicht die Sportart.
  if (/^(moneyline|match odds|to win the match|winner)$/.test(base))
    return { type: hasDraw ? '1X2' : '2WAY', period, line: null, subject: null }

  // "Quarter 3" / "Set 1" ohne Grundbegriff ist der Abschnittssieger.
  if (/^(quarter [1-4]|period [1-3]|set [1-5]|1st half|2nd half)$/.test(base))
    return { type: hasDraw ? '1X2' : '2WAY', period, line: null, subject: null }

  if (/^(point spread|puck line|handicap|set handicap|spread|game handicap|leg handicap)$/.test(base)) {
    // Die Linie der Heimauswahl, nicht `outcome.line`: sie steht gespiegelt an
    // jedem Ausgang, und je Ausgang gelesen landeten die Beine einer Wette
    // auf zwei Schlüsseln (gemessene Scheinrendite: 24,6 %).
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

    // Team-Total: der Mannschaftsname steht hinter "by". Passt er zu beiden
    // Seiten ähnlich gut, verwerfen statt raten.
    if (total[3]) {
      const who = total[3]
      const h = tokenSimilarity(teamTokens(who), teamTokens(home))
      const a = tokenSimilarity(teamTokens(who), teamTokens(away))
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
    // Im Tennis hängt die Linie am Angebot — einmal je Angebot bestimmen.
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


/** Kambis Pfadname je Sportart (`group.json`). */
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
      sportradarId: null,
      sport: SPORT_LABEL[sport.sport],
      league: path.slice(1).join(' — ') || e.group || 'Unbekannt',
      home,
      away,
      startTime: new Date(e.start).toISOString(),
      isLive: e.state === 'STARTED',
      // Der Kambi-Client routet über den Hash.
      url: `https://${brand.webHost}/de-de/sportwetten#event/${e.id}`,
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

      // Je Sportart ein Abruf; ein Ausfall kostet nur diese Sportart.
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
          if (!e?.start || !inWindow(new Date(e.start).getTime(), cutoff)) continue
          const ev = build(e, item.betOffers ?? [], p.value.sport)
          if (ev) out.push(ev)
        }
      }
      return out.slice(0, ctx.maxEvents)
    },

    async fetchDepth(events: RawEvent[]): Promise<RawEvent[]> {
      return deepen(events, 4, async (ev, sport) => {
        const d = await fetchJson<{ betOffers?: BetOffer[]; events?: KambiEvent[] }>(
          `${base}/betoffer/event/${ev.bookEventId}.json?${QUERY}`,
          OPTS,
        )
        return toOutcomes(d.betOffers ?? [], ev.home, ev.away, brand.id, sport)
      })
    },
  }
}

/** Kennung `leode`, nicht `leo` — das ist ein anderes Buch mit anderen Quoten. */
export const leovegas = makeAdapter({
  id: 'leovegas',
  name: 'LeoVegas',
  code: 'leode',
  webHost: 'www.leovegas.de',
})
