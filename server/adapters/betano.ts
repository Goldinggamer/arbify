import { fetchJson, fetchText, pooled } from '../http.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { sportFromLabel } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'
import { readStateAfter } from './html-state.ts'
import { nameMatch } from '../players.ts'

/**
 * Betano (Kaizen Gaming).
 *
 * Sitzt hinter Cloudflare, das den TLS-Fingerprint prüft: mit korrekten
 * Headern, aber curls ClientHello gibt es 403. Deshalb durchgehend `impit`.
 *
 * Betano hat keinen Endpunkt, der Events über alle Ligen hinweg liefert —
 * der Sweep geht deshalb Liga für Liga. Die Liga-IDs stehen als Links im
 * Markup der Fußball-Übersicht (182 Stück), und **jede** wird jeden Durchlauf
 * abgefragt: gemessen 495 Partien, 493 davon mit Sportradar-ID. Warum nicht
 * gesammelt und warum keine Rotation mehr, steht bei `fetchEvents`.
 *
 * Tiefe: die Event-Seite liefert ihre Marktdaten serverseitig ins HTML
 * gerendert mit (rund 13 Märkte) — es gibt dafür keinen JSON-Endpunkt.
 */

const HOST = 'https://www.betano.de'
const REQ = 'req=s,stnf,c,mb'
/**
 * Kein eigener Mindestabstand mehr.
 *
 * `minIntervalMs` ist beim Aufrufer eine **Untergrenze** — ein größerer Wert
 * hier hätte die Host-Richtlinie überstimmt. Mit den alten 80 ms kostete der
 * Sweep über alle Ligen 14,8 s, davon 90 s reine Drosselung über alle
 * Anfragen. Der Takt gehört nach `server/http.ts`, wo er neben den anderen
 * Anbietern steht und im Zusammenspiel gemessen wurde.
 */
const OPTS = { transport: 'impit' as const }

const LEAGUE_TTL_MS = 30 * 60 * 1000

/**
 * Sportarten samt Übersichtsseite und Event-Endpunkt.
 *
 * Für Tennis führt der Fußball-Weg ins Leere: `league/hot/upcoming` antwortet
 * dort mit `{"events":[]}` — kein Fehler, nur leer, und deshalb sah es lange
 * aus wie "Betano hat kein Tennis". Der richtige Pfad steht in der Antwort von
 * `/api/sports/TENN/hot/trending/leagues` als `url` an jeder Liga:
 * `/api/sports/TENN/hot/trending/leagues/{id}/events`. Der greift für **alle**
 * Liga-IDs aus dem Markup, nicht nur für die vier "trending" — nachgemessen 78
 * Partien über 32 Ligen, alle mit Sportradar-ID.
 */
const SPORTS: {
  sport: Sport
  label: string
  /** Übersichtsseite, aus deren Markup die Liga-IDs stammen. */
  page: string
  /** Muster im Markup, das die Liga-IDs trägt. */
  linkPattern: RegExp
  events: (leagueId: string) => string
}[] = [
  {
    sport: 'FOOTBALL',
    label: 'Fußball',
    page: '/sport/fussball/',
    linkPattern: /\/sport\/fussball\/[a-z0-9-]+\/[a-z0-9-]+\/(\d+)\//g,
    events: (id) => `/api/league/hot/upcoming?leagueId=${id}&timeZoneId=Europe/Berlin&${REQ}`,
  },
  {
    sport: 'TENNIS',
    label: 'Tennis',
    page: '/sport/tennis/',
    linkPattern: /\/sport\/tennis\/[a-z0-9-]+\/[a-z0-9-]+\/(\d+)\//g,
    events: (id) => `/api/sports/TENN/hot/trending/leagues/${id}/events?timeZoneId=Europe/Berlin&${REQ}`,
  },
]

type Selection = { id: string; name: string; fullName?: string; price: number; handicap?: number }
type Market = {
  id: string
  name: string
  type: string
  handicap?: number
  selections: Selection[]
  /** Bei „SuperQuoten"-Märkten gesetzt — dann ohne Marge gerechnet. */
  hasZeroRake?: boolean
  /** Trägt bei beworbenen Märkten den Hinweistext auf die SuperQuoten. */
  marketNotes?: string
}

/**
 * Ist das ein beworbener Markt (Quotenboost)?
 *
 * Gemessen an beiden Ausprägungen, die Betano führt: `MR12` („Endergebnis
 * SuperQuoten", Fußball) trägt **nur** den Hinweistext, `HTHP` („Sieger",
 * Tennis) zusätzlich `hasZeroRake`. Ein einzelnes Merkmal genügt also nicht.
 */
const istBoost = (m: Market): boolean =>
  m.hasZeroRake === true || /superquote/i.test(m.marketNotes ?? '')
type Teams = { home: string; away: string }

type BetanoEvent = {
  id: string
  name: string
  shortName?: string
  startTime: number
  url?: string
  betRadarId?: number
  leagueName?: string
  leagueDescription?: string
  regionName?: string
  live?: boolean
  markets?: Market[]
}

const num = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const lineFromText = (text: string): number | null => {
  const m = text.match(/(-?\d+[.,]?\d*)/)
  return m ? num(m[1]) : null
}

function periodOf(name: string, type: string): Period {
  const s = `${name} ${type}`.toLowerCase()
  if (s.includes('1. halbzeit') || s.includes('erste halbzeit')) return 'H1'
  if (s.includes('2. halbzeit') || s.includes('zweite halbzeit')) return 'H2'
  return 'FT'
}

/**
 * Ein Markt ohne Linie — die trägt bei Betano jede **Auswahl** selbst.
 *
 * Das ist die Eigenheit, an der die Tiefenstufe vorher scheiterte: Betano
 * bündelt sämtliche Torgrenzen in *einem* Marktobjekt. `HCTG` heißt
 * "Über/Unter Tore Gesamt", trägt `handicap: 0.5` — und darunter hängen
 * vierzehn Auswahlmöglichkeiten von "Über 0,5" bis "Unter 6,5", jede mit
 * ihrer eigenen `handicap`-Angabe. Wer die Linie am Markt abliest, schreibt
 * "Über 6,5" als "Über 0,5" in den Bestand. Deshalb liefert die Zuordnung
 * hier nur noch die Familie; die Linie kommt je Auswahl dazu.
 */
type MarketFamily = { type: CanonicalMarket['type']; period: Period; subject: CanonicalMarket['subject'] }

/** Markttypen, die eine Linie brauchen — ohne sie ist der Markt unbrauchbar. */
const NEEDS_LINE = new Set<CanonicalMarket['type']>(['OU', 'TEAM_OU', 'EH', 'AH'])

function toFamily(m: Market): MarketFamily | null {
  const name = (m.name ?? '').toLowerCase()
  const type = (m.type ?? '').toUpperCase()
  const period = periodOf(m.name ?? '', m.type ?? '')

  // Endergebnis / Halbzeitergebnis
  // `MR12` ist die beworbene Fassung desselben Markts: "Endergebnis
  // SuperQuoten" mit denselben drei Seiten und durchgehend höheren Quoten
  // (1,53 / 4,80 / 6,10 gegen 1,52 / 4,60 / 5,80). Sie fehlte hier ganz —
  // damit rechnete der Scanner bei jeder beworbenen Partie mit der
  // schlechteren Quote.
  if (type === 'MRES' || type === 'MR12' || name.startsWith('endergebnis'))
    return { type: '1X2', period: 'FT', subject: null }
  if (type === 'H1RS' || name.includes('1. halbzeit - ergebnis'))
    return { type: '1X2', period: 'H1', subject: null }

  if (type === 'BTSC' || type === 'GGNG' || name.includes('beide teams treffen'))
    return { type: 'BTTS', period, subject: null }

  if (type === 'OEGL' || name.includes('ungerade/gerade') || name.includes('gerade/ungerade'))
    return { type: 'OE', period, subject: null }

  // Team-Totals müssen VOR dem generischen OU-Zweig geprüft werden, sonst
  // würden "Tore Heimteam" und "Tore gesamt" auf denselben Schlüssel fallen
  // und völlig verschiedene Wetten gegeneinander gerechnet.
  if (type === 'OUHG') return { type: 'TEAM_OU', period, subject: 'HOME' }
  if (type === 'OUAG') return { type: 'TEAM_OU', period, subject: 'AWAY' }

  // Ausdrückliche Liste statt `type.startsWith('OU')`. Das Präfix war eine
  // offene Flanke: Betano benennt auch Ecken- und Kartenmärkte nach demselben
  // Muster, und ein `OUCR` wäre stillschweigend als Tor-Über/Unter durchgegangen.
  if (type === 'HCTG' || type === 'OVUN' || type === 'TOTG' || name.includes('gesamtzahl tore')) {
    const p: Period = type === 'OUH1' ? 'H1' : type === 'OUH2' ? 'H2' : period
    return { type: 'OU', period: p, subject: null }
  }
  if (type === 'OUH1') return { type: 'OU', period: 'H1', subject: null }
  if (type === 'OUH2') return { type: 'OU', period: 'H2', subject: null }

  if (type === 'EHND' || type === 'HAND') return { type: 'EH', period, subject: null }

  // Bewusst nicht unterstützt, daher ohne Warnung: Doppelte Chance
  // (überlappende Optionen), Halbzeit/Endstand, Genaues Ergebnis,
  // Remis-Geld-zurück, Torschütze — sie passen nicht ins Zerlegungs-Modell.
  //
  // `FHMR` steht ausdrücklich dabei. Der Typ hieß hier früher "1. Halbzeit"
  // und wurde als Halbzeit-Siegwette geführt — er heißt aber im Klartext
  // "Handicap Spielergebnis" und ist das Ganzspiel-Handicap. Als Halbzeit-1X2
  // verbucht wäre er eine Phantom-Arbitrage-Quelle ersten Ranges. Zugeordnet
  // wird er trotzdem nicht: in keiner abgerufenen Partie trug er
  // Auswahlmöglichkeiten, also ist weder das Vorzeichen der Linie noch die
  // Benennung der Seiten nachgemessen. Raten ist hier teurer als auslassen.
  // Neben den Kürzeln vergibt Betano für manche Märkte **numerische** Typen
  // ("1001086 :: Genaues Ergebnis"). Derselbe Markt, andere Kennung — deshalb
  // zusätzlich über den Klartextnamen abgleichen, sonst meldet die Diagnose
  // eine Lücke, die keine ist.
  const knownName =
    /genaues ergebnis|doppelte chance|halbzeit\/|halbzeit ?\/ ?endergebnis|geld zurück|torschütze|handicap spielergebnis|wird sich qualifizieren|qualifikationsmethode|gewinnmethode|wer gewinnt den pokal/.test(
      name,
    )
  if (!['DBLC', 'HTFT', 'CSFT', 'DNOB', 'PSCR', 'FHMR'].includes(type) && !knownName)
    noteUnmapped('betano', `${m.type} :: ${m.name}`)
  return null
}

/**
 * Tennis-Marktfamilien.
 *
 * Die Typkürzel überschneiden sich nicht mit dem Fußball, ein eigener Zweig ist
 * trotzdem nötig: `TGHC` und `TGOU` zählen in **Spielen**, nicht in Toren, und
 * ohne Einheit im Schlüssel fiele ein Spiele-Handicap über −2,5 auf dasselbe
 * Fach wie ein Tore-Handicap über −2,5.
 */
function toTennisFamily(m: Market): (MarketFamily & { unit?: 'GAMES' | 'SETS' }) | null {
  const type = (m.type ?? '').toUpperCase()
  const name = m.name ?? ''

  switch (type) {
    // "Sieger" — zweiseitig, die Seiten tragen die Spielernamen.
    //
    // `HTHP` ist die **beworbene** Fassung von `HTOH` — nachgemessen am
    // Markt selbst: `hasZeroRake: true` und der Hinweistext "Märkte mit
    // SuperQuoten werden bereits mit verbesserten Quoten angeboten". Beide
    // heißen "Sieger", beide tragen `handicap=0`, und die beworbene liegt
    // durchgehend höher (2,50/1,60 gegen 2,40/1,57), was die auffällig enge
    // Marge von 2,5 % gegenüber 5,4 % erklärt.
    //
    // Also dieselbe Wette und derselbe Schlüssel. Der Unterschied steckt
    // nicht im Gegenstand, sondern in den Bedingungen — beworbene Quoten sind
    // meist einsatzbegrenzt. Das trägt der Hinweis `promo-odds`.
    case 'HTOH':
    case 'HTHP':
      return { type: '2WAY', period: 'FT', subject: null }

    // "Satz-Sieger (Satz 1)" — die Satznummer steht nur im Namen.
    case 'STWN': {
      const n = /satz\s*([1-5])/i.exec(name)?.[1]
      return n ? { type: '2WAY', period: `S${n}` as Period, subject: null } : null
    }

    case 'TGHC':
      return { type: 'AH', period: 'FT', subject: null, unit: 'GAMES' }
    case 'TGOU':
    case 'FTGO':
      return { type: 'OU', period: 'FT', subject: null, unit: 'GAMES' }

    default:
      // Bekannt und bewusst draußen: `BTOF` ist die Satzwette (genaues
      // Ergebnis, vier Seiten), `P1WS`/`P2WS` sind "gewinnt einen Satz" und
      // haben einen anderen Gegenstand.
      if (!/^(BTOF|P[12]WS|CSFT|PSCR)$/.test(type) && !/satzwette|gewinnt einen satz|genaues ergebnis/i.test(name))
        noteUnmapped('betano', `TENNIS ${m.type} :: ${m.name}`)
      // `HTHP` wird bewusst gemeldet statt stumm verworfen: sobald die
      // Wertungsregel geklärt ist, gehört der Markt mit eigener Einheit und
      // eigenem Schlüssel zurück ins Modell.
      return null
  }
}

/** Normalisiert für Namensvergleiche: Kleinschreibung, Umlaute, Satzzeichen weg. */
const simplify = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '')

function toSide(sel: Selection, market: CanonicalMarket, teams?: Teams): Side | null {
  const n = (sel.name ?? '').trim().toLowerCase()

  // Tennis: die Siegwette und das Spiele-Handicap beschriften ihre Seiten mit
  // dem Spielernamen, teils mit angehängter Linie ("Cerundolo -2.5").
  if (market.type === '2WAY' || market.type === 'AH') {
    if (n === '1') return 'HOME'
    if (n === '2') return 'AWAY'
    if (!teams) return null
    const who = (sel.name ?? '').replace(/\s*[+-]\s*[\d.,]+\s*$/, '').trim()
    const h = nameMatch(who, teams.home)
    const a = nameMatch(who, teams.away)
    if (h > a) return 'HOME'
    if (a > h) return 'AWAY'
    return null
  }

  if (market.type === '1X2' || market.type === 'EH') {
    if (n === '1') return 'HOME'
    if (n === 'x') return 'DRAW'
    if (n === '2') return 'AWAY'
    // Das Endergebnis beschriftet seine Seiten mit "1"/"X"/"2", das
    // **Halbzeitergebnis** dagegen mit den Mannschaftsnamen ("Lyngby BK" /
    // "Unentschieden" / "Aarhus GF"). Ohne diesen Zweig fiel `H1RS` komplett
    // durch: die Familie war zugeordnet, aber keine einzige Seite.
    if (n === 'unentschieden' || n === 'remis') return 'DRAW'
    if (teams) {
      const s = simplify(sel.name ?? '')
      if (s && s === simplify(teams.home)) return 'HOME'
      if (s && s === simplify(teams.away)) return 'AWAY'
    }
    return null
  }
  if (market.type === 'OU' || market.type === 'TEAM_OU') {
    if (n.startsWith('über') || n.startsWith('over') || n.startsWith('mehr')) return 'OVER'
    if (n.startsWith('unter') || n.startsWith('under') || n.startsWith('weniger')) return 'UNDER'
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

/**
 * Linie einer einzelnen Auswahl.
 *
 * Reihenfolge ist wesentlich: die Angabe **an der Auswahl** hat Vorrang, denn
 * `market.handicap` trägt bei den gebündelten Märkten nur die erste Linie.
 * Erst wenn die Auswahl keine führt, gilt die des Marktes; die Beschriftung
 * ("Über 2,5") ist die letzte Rückfallebene.
 */
function lineOf(family: MarketFamily, sel: Selection, m: Market): number | null {
  if (!NEEDS_LINE.has(family.type)) return null
  if (typeof sel.handicap === 'number' && Number.isFinite(sel.handicap)) return sel.handicap
  if (typeof m.handicap === 'number' && Number.isFinite(m.handicap)) return m.handicap
  return lineFromText(sel.name ?? '')
}

export function toOutcomes(ev: BetanoEvent, teams?: Teams, sport: Sport = 'FOOTBALL'): RawOutcome[] {
  const out: RawOutcome[] = []
  for (const m of ev.markets ?? []) {
    const family = sport === 'TENNIS' ? toTennisFamily(m) : toFamily(m)
    if (!family) continue
    for (const sel of m.selections ?? []) {
      const odds = num(sel.price)
      if (odds === null || odds <= 1) continue
      const line = lineOf(family, sel, m)
      // Ein Markt, der eine Linie braucht und keine hat, ist nicht vergleichbar.
      if (line === null && NEEDS_LINE.has(family.type)) continue
      const market: CanonicalMarket = { ...family, line }
      const side = toSide(sel, market, teams ?? teamsOf(ev))
      if (side) out.push(istBoost(m) ? { market, side, odds, promo: true } : { market, side, odds })
    }
  }
  return out
}

/** "Randers FC - Silkeborg IF" → beide Mannschaften. */
function teamsOf(e: BetanoEvent): Teams | undefined {
  const [home, away] = (e.shortName ?? e.name ?? '').split(' - ')
  return home?.trim() && away?.trim() ? { home: home.trim(), away: away.trim() } : undefined
}

function toRawEvent(e: BetanoEvent, outcomes: RawOutcome[], label = 'Fußball'): RawEvent | null {
  const [home, away] = (e.shortName ?? e.name ?? '').split(' - ')
  if (!home || !away || !outcomes.length) return null
  return {
    bookmakerId: 'betano',
    bookEventId: e.id,
    sportradarId: e.betRadarId ?? null,
    sport: label,
    league: [e.regionName, e.leagueName ?? e.leagueDescription].filter(Boolean).join(' — '),
    home: home.trim(),
    away: away.trim(),
    startTime: new Date(e.startTime).toISOString(),
    isLive: !!e.live,
    url: e.url ? `${HOST}${e.url}` : HOST,
    outcomes,
    fetchedAt: new Date().toISOString(),
  }
}

/* --------------------------------------------------------------- Liga-Liste */

const leagueCache = new Map<string, { ids: string[]; at: number }>()

async function loadLeagueIds(spec: (typeof SPORTS)[number]): Promise<string[]> {
  const cached = leagueCache.get(spec.page)
  if (cached?.ids.length && Date.now() - cached.at < LEAGUE_TTL_MS) return cached.ids
  const html = await fetchText(`${HOST}${spec.page}`, { ...OPTS, minIntervalMs: 500 })
  const ids = [...new Set([...html.matchAll(spec.linkPattern)].map((m) => m[1]))]
  if (ids.length) leagueCache.set(spec.page, { ids, at: Date.now() })
  return leagueCache.get(spec.page)?.ids ?? []
}

/* ------------------------------------------------- Markttiefe aus dem HTML */

/** Sucht im Hydration-Payload das Event mit der gesuchten ID. */
function findEvent(node: unknown, id: string): BetanoEvent | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findEvent(v, id)
      if (r) return r
    }
    return null
  }
  const o = node as Record<string, unknown>
  if (o.id === id && Array.isArray(o.markets)) return o as unknown as BetanoEvent
  for (const v of Object.values(o)) {
    const r = findEvent(v, id)
    if (r) return r
  }
  return null
}

/**
 * Marker des Hydration-Payloads der Event-Seite.
 *
 * Vorher suchte diese Funktion die Zeichenkette `"markets"` und tastete sich
 * von dort mit `lastIndexOf('{"', anchor - 4000)` rückwärts zum Objektanfang.
 * Beide Kandidaten lagen systematisch daneben — `lastIndexOf` sucht ab dem
 * übergebenen Index nach **links**, landete also 4 kB *vor* dem Markt-Block
 * mitten in einem fremden Objekt (`{"url":…,"providerId":…}`, 79 Zeichen). Der
 * Schnitt parste zwar, enthielt aber keine Partie, `findEvent` gab null zurück,
 * und die Tiefenstufe lieferte für **jedes** Event eine leere Liste. Sichtbar
 * war das nur daran, dass Betano ausschließlich die Siegwette beisteuerte.
 *
 * Der Zustand hängt an einem eindeutigen Marker; den zu nehmen ist nicht nur
 * korrekt, sondern auch billiger als jede Rückwärtssuche.
 */
const STATE_MARKER = 'window["initial_state"]='

async function fetchEventMarkets(ev: RawEvent): Promise<RawOutcome[]> {
  const html = await fetchText(ev.url, OPTS)
  const state = readStateAfter(html, STATE_MARKER)
  if (!state) return []
  const found = findEvent(state, ev.bookEventId)
  if (!found) return []
  const sport: Sport = sportFromLabel(ev.sport) ?? 'FOOTBALL'
  return toOutcomes(found, { home: ev.home, away: ev.away }, sport)
}

/* -------------------------------------------------------------- Adapter */

export const betano: BookmakerAdapter = {
  id: 'betano',
  name: 'Betano',
  transport: 'impit',

  // Tennis trägt bei Betano ausschließlich die Siegwette, und die steht schon
  // im Sweep: `STWN` (Satz-Sieger) kam in jeder abgerufenen Partie mit null
  // Auswahlmöglichkeiten, `TGHC`/`TGOU` erscheinen auf den Event-Seiten nicht.
  // Die Tiefenabfrage gewinnt dort also nichts und nähme dem Fußball nur die
  // Hälfte des Budgets weg.
  depthSports: ['FOOTBALL'],

  async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {

    /**
     * Alle Ligen, jeden Durchlauf.
     *
     * Vorher lief hier eine Rotation: die zuletzt produktiven Ligen immer, vom
     * Rest je Durchlauf vierzig. Das hatte zwei Fehler, und beide kosteten
     * fast das ganze Angebot.
     *
     * Der erste ist der Kaltstart. `productive` lebt im Prozess, nicht auf der
     * Platte — nach jedem Neustart ist die Menge leer, und der erste Durchlauf
     * fragt genau vierzig von 182 Ligen ab. Gemessen kamen dabei **15**
     * Partien heraus, wo es 495 gibt. Bis sich das hochgearbeitet hat, dauert
     * es fünf Discovery-Zyklen, also rund fünf Minuten.
     *
     * Der zweite ist ein undichter Zeiger. `coldCursor` indexiert in `cold`,
     * und `cold` **schrumpft**, sobald Ligen produktiv werden. Nach dem ersten
     * Durchlauf zeigt der Zeiger auf 40, das Array ist aber um die gefundenen
     * Ligen kürzer — der Abschnitt dazwischen wurde übersprungen. Über viele
     * Läufe wickelt sich das irgendwann ab, deckt aber nie zuverlässig alles.
     *
     * Sammeln wäre der naheliegende Ausweg und funktioniert nicht: der
     * Endpunkt nimmt `leagueId=a,b,c` an, deckelt die **Antwort** aber bei rund
     * zwanzig Partien — 182 IDs in einem Aufruf ergaben 6 Partien, 40 je
     * Aufruf 99, einzeln alle 495. Einzelabrufe sind also der einzige
     * vollständige Weg, und mit der Host-Richtlinie aus `server/http.ts`
     * kosten sie rund 6 s. Die Adapter laufen parallel; das fällt nicht auf.
     */
    const cutoff = Date.now() + ctx.windowMs
    const out: RawEvent[] = []

    for (const spec of SPORTS) {
      const all = await loadLeagueIds(spec)
      if (!all.length) continue

      const pages = await pooled(all, 8, async (leagueId) => {
        const res = await fetchJson<{ data?: { events?: BetanoEvent[] } }>(HOST + spec.events(leagueId), OPTS)
        return res.data?.events ?? []
      })

      for (const p of pages) {
        if (p.status !== 'fulfilled') continue
        for (const e of p.value) {
          if (e.startTime > cutoff) continue
          const teams = (e.shortName ?? e.name ?? '').split(' - ')
          const ev = toRawEvent(
            e,
            toOutcomes(e, teams.length === 2 ? { home: teams[0].trim(), away: teams[1].trim() } : undefined, spec.sport),
            spec.label,
          )
          if (ev) out.push(ev)
        }
      }
    }
    return out.slice(0, ctx.maxEvents)
  },

  async fetchDepth(events: RawEvent[]): Promise<RawEvent[]> {
    const results = await pooled(events, 4, async (ev) => {
      const outcomes = await fetchEventMarkets(ev)
      // Die Event-Seite ist reichhaltiger als der Sweep, aber falls das
      // Parsen scheitert, bleibt der flache Stand besser als nichts.
      return outcomes.length > ev.outcomes.length
        ? { ...ev, outcomes, fetchedAt: new Date().toISOString() }
        : ev
    })
    return results.map((r, i) => (r.status === 'fulfilled' ? r.value : events[i]))
  },
}
