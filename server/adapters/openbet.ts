import { LiveDocClient } from '../livedoc.ts'
import { pooled } from '../http.ts'
import { deepen } from './depth.ts'
import { noteUnmapped } from '../diagnostics.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'

/**
 * OpenBet (DAZN Bet) — Quoten nur über LiveDoc (`server/livedoc.ts`) auf
 * dem Wett-Host `sb-pp-defe.daznbet.de`:
 *
 *   /eventmaplivedocl1  `eventmap/{typ}{sportId}` → Kupon (Kennungen, Anstoß)
 *   /eventlivedocl1     `events/{id}`, `eventmarketsmap/{id}`, `competitions/{id}`
 *   /marketlivedocl1    `markets/{marktId}` → ein Markt samt Quoten
 *
 * Der Sweep holt je Partie nur die Siegwette; erst die Tiefe lädt die übrigen
 * Märkte mit Gegenstück im Modell.
 */

const HOST = 'sb-pp-defe.daznbet.de'
const LANG = 'de'
/** Tiefenlinks auf den Wett-Host — `www.daznbet.de` kennt die Wettrouten nicht. */
const WEB = `https://${HOST}`

/** Kupon-Kennung je Sportart. Tennis ist `TNS`; `TEN` liefert still eine leere Antwort. */
const SPORTS: { coupon: string; sport: Sport }[] = [
  { coupon: 'upcomingFBL', sport: 'FOOTBALL' },
  { coupon: 'upcomingTNS', sport: 'TENNIS' },
]

const eventmapDoc = new LiveDocClient({ host: HOST, service: '/eventmaplivedocl1/livedoc' })
const eventDoc = new LiveDocClient({ host: HOST, service: '/eventlivedocl1/livedoc' })
const marketDoc = new LiveDocClient({ host: HOST, service: '/marketlivedocl1/livedoc' })

type ObSelection = {
  id?: string
  name?: string
  side?: string
  line?: number
  selTemplate?: string
  status?: string
  price?: { dec?: string }
}

type ObMarket = {
  id?: string
  name?: string
  status?: string
  tradeStatus?: string
  taxonomy?: { type?: string; period?: string; scoreType?: string }
  selections?: ObSelection[][]
}

type ObParticipant = { name?: string; participantTeamData?: { participantSide?: number } }

type ObEvent = {
  id?: string
  sportId?: string
  competitionId?: string
  name?: string
  defaultName?: string
  status?: string
  tradeStatus?: string
  participants?: ObParticipant[][]
  miniCoupons?: Record<string, string[]>
  anticipated?: { startTime?: string | null }
  actual?: { startTime?: string | null }
}

/** Ein Eintrag aus `eventmarketsmap` — Typangabe ohne Quoten. */
type ObMarketRef = { id?: string; type?: string; period?: string; scoreType?: string; name?: string }

function periodOf(period: string | undefined): Period | null {
  // Tennis kodiert den Satz als `1SET`…`5SET`.
  const set = /^([1-5])SET$/.exec(period ?? '')
  if (set) return `S${set[1]}` as Period

  switch (period) {
    case 'FLGM':
      return 'FT'
    case '1HLF':
      return 'H1'
    case '2HLF':
      return 'H2'
    // `FLGMPEN` schließt Verlängerung und Elfmeterschießen ein — ein anderer
    // Gegenstand als die reguläre Spielzeit, und bei anderen Büchern ohne
    // Gegenstück. Bewusst verworfen.
    default:
      return null
  }
}

/**
 * Markttyp → Modell. Positivliste mit exaktem Vergleich: Kombiwetten heißen
 * `TOTALS-OU&&WHOSCORES2-G-12` und gingen per Präfix als Über/Unter durch.
 */
function toMarket(ref: { type?: string; period?: string }, line: number | null): CanonicalMarket | null {
  const period = periodOf(ref.period)
  if (!period) return null

  switch (ref.type) {
    case 'WINNER2D':
      return { type: '1X2', period, line: null, subject: null }
    case 'TOTALS-OU':
      return line === null ? null : { type: 'OU', period, line, subject: null }
    case 'TOTALS-OU-1':
      return line === null ? null : { type: 'TEAM_OU', period, line, subject: 'HOME' }
    case 'TOTALS-OU-2':
      return line === null ? null : { type: 'TEAM_OU', period, line, subject: 'AWAY' }
    case 'HANDICAP2D':
      return line === null ? null : { type: 'EH', period, line, subject: null }
    case 'WHOSCORES2-G-12':
      return { type: 'BTTS', period, line: null, subject: null }
    case 'PARITY-OE':
      return { type: 'OE', period, line: null, subject: null }
    default:
      return null
  }
}

/** Tennis: `WINNER2` ist zweiseitig; `TOTALS-OU` zählt hier Sätze. */
function toTennisMarket(ref: { type?: string; period?: string }, line: number | null): CanonicalMarket | null {
  const period = periodOf(ref.period)
  if (!period) return null

  switch (ref.type) {
    // Matchsieger bei `FLGM`, Satzsieger bei `1SET`/`2SET` — derselbe Typ,
    // die Periode macht den Unterschied.
    case 'WINNER2':
      return { type: '2WAY', period, line: null, subject: null }
    case 'TOTALS-OU':
      return line === null ? null : { type: 'OU', period, line, subject: null, unit: 'SETS' }
    case 'HANDICAP2':
      return line === null ? null : { type: 'AH', period, line, subject: null, unit: 'SETS' }
    default:
      return null
  }
}

/** Tennis-Typen, die eine Tiefenabfrage wert sind. */
const WANTED_TENNIS_TYPES = new Set(['WINNER2', 'TOTALS-OU', 'HANDICAP2'])

/** Typen, die eine Tiefenabfrage überhaupt wert sind. */
const WANTED_TYPES = new Set([
  'WINNER2D',
  'TOTALS-OU',
  'TOTALS-OU-1',
  'TOTALS-OU-2',
  'HANDICAP2D',
  'WHOSCORES2-G-12',
  'PARITY-OE',
])

function toSide(sel: ObSelection): Side | null {
  // `selTemplate` ist verlässlicher als `side`: bei Ja/Nein-Märkten steht in
  // `side` durchgängig "UNKNOWN", während `selTemplate` YES bzw. NO trägt.
  switch (sel.selTemplate ?? sel.side) {
    case 'HOME':
      return 'HOME'
    case 'DRAW':
      return 'DRAW'
    case 'AWAY':
      return 'AWAY'
    case 'OVER':
      return 'OVER'
    case 'UNDER':
      return 'UNDER'
    case 'YES':
      return 'YES'
    case 'NO':
      return 'NO'
    case 'ODD':
      return 'ODD'
    case 'EVEN':
      return 'EVEN'
    default:
      return null
  }
}

/**
 * Die Linie steht an den Auswahlmöglichkeiten. Beim Handicap gegenläufig —
 * maßgeblich ist die Heim-Auswahl.
 */
function lineOf(selections: ObSelection[]): number | null {
  const home = selections.find((s) => (s.selTemplate ?? s.side) === 'HOME')
  const source = home ?? selections[0]
  const line = source?.line
  return typeof line === 'number' ? line : null
}

function toOutcomes(market: ObMarket, bookId: string, sport: Sport = 'FOOTBALL'): RawOutcome[] {
  if (market.status && market.status !== 'OFFERED') return []
  if (market.tradeStatus && market.tradeStatus !== 'TRADABLE') return []

  const selections = market.selections?.[0] ?? []
  if (!selections.length) return []

  const type = market.taxonomy?.type
  const ref = { type, period: market.taxonomy?.period }
  const canonical =
    sport === 'TENNIS' ? toTennisMarket(ref, lineOf(selections)) : toMarket(ref, lineOf(selections))
  if (!canonical) {
    // Kombiwetten (`&&`) und die vielen Sonderformen sind bekannt und ohne
    // Gegenstück — nur echte Unbekannte melden.
    const wanted = sport === 'TENNIS' ? WANTED_TENNIS_TYPES : WANTED_TYPES
    if (type && !type.includes('&&') && wanted.has(type)) {
      noteUnmapped(bookId, `${type} | ${market.taxonomy?.period} | ${market.name ?? ''}`)
    }
    return []
  }

  const out: RawOutcome[] = []
  for (const sel of selections) {
    if (sel.status && sel.status !== 'OFFERED') continue
    const side = toSide(sel)
    const odds = Number(sel.price?.dec)
    if (!side || !Number.isFinite(odds) || odds <= 1) continue
    out.push({ market: canonical, side, odds })
  }
  return out
}

/** Teamnamen: `defaultName` trägt die vollen, `participants` die gekürzten. */
function teamsOf(ev: ObEvent): { home: string; away: string } | null {
  const full = ev.defaultName ?? ev.name ?? ''
  const split = full.split(/\s+v\s+/)
  if (split.length === 2 && split[0].trim() && split[1].trim()) {
    return { home: split[0].trim(), away: split[1].trim() }
  }
  const parts = ev.participants?.[0] ?? []
  const home = parts.find((p) => p.participantTeamData?.participantSide === 1)?.name
  const away = parts.find((p) => p.participantTeamData?.participantSide === 2)?.name
  return home && away ? { home, away } : null
}

/**
 * Adresskürzel aus dem Partienamen. Akzente bleiben stehen (`são-paulo`); mit falschem Kürzel findet die Seite die Partie nicht.
 */
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')

/** `Pachuca v Querétaro` + `BG-5105120` → `…/pachuca-v-querétaro-bg-5105120` */
const eventUrl = (ev: ObEvent, sportSlug = 'fußball'): string => {
  const id = (ev.id ?? '').toLowerCase()
  const name = slug(ev.name || ev.defaultName || '')
  const path = `/${sportSlug}/event/${name ? `${name}-` : ''}${id}`
  return WEB + path.split('/').map(encodeURIComponent).join('/')
}

/** Liganamen werden über den Lauf hinweg behalten — sie ändern sich nicht. */
const leagueCache = new Map<string, string>()

const leagueName = (competitionId: string | undefined): string =>
  (competitionId && leagueCache.get(competitionId)) || 'Unbekannt'

/** Lädt unbekannte Liganamen nebenläufig und vorab — seriell in der Schleife kostete das bei Tennis bis zu 28 s. */
async function warmLeagues(ids: (string | undefined)[]): Promise<void> {
  const missing = [...new Set(ids.filter((id): id is string => id !== undefined && id !== '' && !leagueCache.has(id)))]
  if (!missing.length) return
  await pooled(missing, 20, async (id) => {
    try {
      const doc = await eventDoc.document<{ name?: string; defaultName?: string }>(
        `competitions/${id}`,
        { 'X-Lang': LANG, sendEmpty: true },
      )
      leagueCache.set(id, doc.defaultName || doc.name || 'Unbekannt')
    } catch {
      // Ein fehlender Liganame kostet nur die Beschriftung, nicht die Quote.
      leagueCache.set(id, 'Unbekannt')
    }
  })
}

export const daznbet: BookmakerAdapter = {
  id: 'daznbet',
  name: 'DAZN Bet',
  transport: 'websocket',

  async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
    const cutoff = Date.now() + ctx.windowMs
    const now = new Date().toISOString()
    const events: RawEvent[] = []

    for (const spec of SPORTS) {
    const coupon = await eventmapDoc.document<{ events?: Record<string, { id?: string; timestamp?: string }> }>(
      `eventmap/${spec.coupon}`,
      {
        'X-Lang': LANG,
        // Der Server deckelt bei 500, unabhängig vom angefragten Wert.
        'X-Size': 500,
        'X-Sort': 'date',
        'X-Order': 'asc',
        'X-IncludeComp': false,
        sendEmpty: true,
      },
    )

    const ids = Object.values(coupon.events ?? {})
      .filter((e) => {
        const t = new Date(e.timestamp ?? '').getTime()
        return Number.isFinite(t) && t <= cutoff
      })
      .map((e) => e.id)
      .filter((id): id is string => Boolean(id))
      .slice(0, ctx.maxEvents)

    const heads = await pooled(ids, 40, (id) =>
      eventDoc.document<ObEvent>(`events/${id}`, { 'X-Lang': LANG, sendEmpty: true }),
    )

    const usable = heads
      .map((r) => (r.status === 'fulfilled' ? r.value : null))
      .filter((e): e is ObEvent => Boolean(e && e.id && e.status === 'OFFERED'))

    // Liganamen einmal gesammelt holen, nicht je Event einzeln — siehe `warmLeagues`.
    await warmLeagues(usable.map((e) => e.competitionId))

    // Siegwette je Partie — mehr braucht die Übersicht nicht, und ohne sie
    // hätte ein Event gar keine Quoten.
    const mains = await pooled(usable, 40, async (ev) => {
      const mainId = ev.miniCoupons?.MAIN?.[0]
      if (!mainId) return null
      return marketDoc.document<ObMarket>(`markets/${mainId}`, { 'X-Lang': LANG, sendEmpty: true })
    })

    for (const [i, ev] of usable.entries()) {
      const teams = teamsOf(ev)
      const start = new Date(ev.anticipated?.startTime ?? '').getTime()
      if (!teams || !Number.isFinite(start)) continue

      const main = mains[i]
      const outcomes =
        main.status === 'fulfilled' && main.value ? toOutcomes(main.value, 'daznbet', spec.sport) : []
      if (!outcomes.length) continue

      events.push({
        bookmakerId: 'daznbet',
        bookEventId: ev.id!,
        // Die Fremdkennung ist eine **Betgenius**-ID (`feedId: "BETGENIUS"`),
        // keine Sportradar-ID — für einen ID-Join mit den anderen Büchern
        // also nutzlos. Zuordnung läuft über Teamnamen plus Anstoßzeit.
        sportradarId: null,
        sport: SPORT_LABEL[spec.sport],
        league: leagueName(ev.competitionId),
        home: teams.home,
        away: teams.away,
        startTime: new Date(start).toISOString(),
        // `eventmap/upcoming…` liefert ausschließlich Vorspiel; `actual.startTime`
        // bleibt bis zum Anpfiff leer.
        isLive: Boolean(ev.actual?.startTime),
        url: eventUrl(ev, spec.sport === 'TENNIS' ? 'tennis' : 'fußball'),
        outcomes,
        fetchedAt: now,
      })
    }
    }

    return events
  },

  async fetchDepth(events: RawEvent[]): Promise<RawEvent[]> {
    return deepen(events, 8, async (ev, sport) => {
      const map = await eventDoc.document<Record<string, ObMarketRef>>(`eventmarketsmap/${ev.bookEventId}`, {
        'X-Lang': LANG,
        sendEmpty: true,
      })

      const types = sport === 'TENNIS' ? WANTED_TENNIS_TYPES : WANTED_TYPES
      const wanted = Object.values(map ?? {}).filter((m) => m.id && m.type && types.has(m.type))
      if (!wanted.length) return null

      const loaded = await pooled(wanted, 12, (m) =>
        marketDoc.document<ObMarket>(`markets/${m.id}`, { 'X-Lang': LANG, sendEmpty: true }),
      )

      const outcomes: RawOutcome[] = []
      for (const r of loaded) {
        if (r.status !== 'fulfilled' || !r.value) continue
        outcomes.push(...toOutcomes(r.value, 'daznbet', sport))
      }
      return outcomes
    })
  },
}
