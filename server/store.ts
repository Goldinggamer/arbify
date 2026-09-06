import { ADAPTERS } from './adapters/index.ts'
import { httpStats, resetHttpStats, type HostStats } from './http.ts'
import type { AdapterResult, BookmakerAdapter } from './adapters/types.ts'
import { matchEvents } from './match.ts'
import { eventHeat, scanForArbitrage, type MarginRow, type ScanOpportunity } from './scan.ts'
import type { RawEvent, Sport } from './types.ts'
import { sportFromLabel } from './types.ts'

/**
 * Anzeigename → Modellkennung der Sportart.
 *
 * Fällt auf Fußball zurück, weil `depthSports` sonst eine unbekannte Sportart
 * stillschweigend von der Tiefenstufe ausschlösse — der Rückfall kostet
 * höchstens ein paar Detailabrufe, das Ausschließen kostet Märkte.
 */
const sportOf = (sport: string): Sport => sportFromLabel(sport) ?? 'FOOTBALL'

/**
 * Zwei Takte statt einem.
 *
 * Ein vollständiger Durchlauf über alle Anbieter dauert rund 13 Sekunden und
 * bewegt zweistellige Megabyte. Im Sekundentakt ist das weder machbar noch
 * nötig: von 500 Events stehen immer nur eine Handvoll kurz vor einer
 * Arbitrage. Also:
 *
 *   Discovery (≈60 s) — kompletter Sweep, Matching, Markttiefe. Findet neue
 *                       Events und hält das Universum aktuell.
 *   Refresh   (≈10 s) — lädt nur die "heißen" Vorspiel-Events nach: die,
 *                       deren beste Quoten nah an einer Arbitrage liegen.
 *                       Danach wird neu gerechnet.
 *
 * Wichtig für die Bedienung: läuft bereits ein Durchlauf, wartet ein
 * Aufrufer darauf — er bekommt **nie** den alten Stand zurückgereicht.
 */

export type ScanSnapshot = {
  opportunities: ScanOpportunity[]
  /** Knappste Markt-Vergleiche — Beleg, dass Matching und Mapping greifen */
  margins: MarginRow[]
  books: AdapterResult[]
  eventCount: number
  matchedCount: number
  /** Anteil der Events, die per Sportradar-ID gejoint wurden */
  srMatchRate: number
  /** Wie viele Events die Tiefenabfrage durchlaufen haben */
  deepenedCount: number
  /** Quellen, deren Heim/Auswärts-Ausrichtung gedreht werden musste */
  flippedSources: number
  /** Quellen, die wegen unklarer Zuordnung verworfen wurden */
  droppedSources: number
  /** Wie viele Events im schnellen Takt beobachtet werden */
  hotCount: number
  /**
   * Was die Retry-Schleife im letzten Durchlauf verdeckt hat, je Host.
   *
   * Ohne diese Zahlen erscheint eine Ratenbegrenzung als längere Laufzeit und
   * als schwankende Eventzahl — nie als Fehler. Genau dadurch schwankte die
   * Vergleichsbasis zwischen 189 und 424 Partien, ohne dass etwas „kaputt" war.
   */
  hostLoad: Record<string, HostStats & { penalty: number; blockedUntil: string | null }>
  /** Zeitpunkt des letzten vollständigen Durchlaufs */
  lastDiscovery: string
  /** Zeitpunkt der letzten Quotenaktualisierung — das ist das Alter der Daten */
  lastRefresh: string
  startedAt: string
  durationMs: number
}

const empty: ScanSnapshot = {
  opportunities: [],
  margins: [],
  books: [],
  eventCount: 0,
  matchedCount: 0,
  srMatchRate: 0,
  deepenedCount: 0,
  flippedSources: 0,
  droppedSources: 0,
  hotCount: 0,
  hostLoad: {},
  lastDiscovery: new Date(0).toISOString(),
  lastRefresh: new Date(0).toISOString(),
  startedAt: new Date(0).toISOString(),
  durationMs: 0,
}

export type ScanConfig = {
  windowMs: number
  maxEvents: number
  minPercent: number
  /** Obergrenze für die Markttiefe je Buchmacher im Discovery-Lauf */
  maxDepthEvents: number
  /** Wie viele Events im schnellen Takt nachgeladen werden */
  maxHotEvents: number
  /** Ab welcher impliziten Summe ein Event als "heiß" gilt */
  hotThreshold: number
}

let snapshot: ScanSnapshot = empty
/** Letzter bekannter Rohbestand — Grundlage für den schnellen Takt. */
let rawPool: RawEvent[] = []
let lastBooks: AdapterResult[] = []

let discoveryInFlight: Promise<ScanSnapshot> | null = null
let refreshInFlight: Promise<ScanSnapshot> | null = null

export const getSnapshot = (): ScanSnapshot => snapshot

/* ------------------------------------------------------------- Auswertung */

function evaluate(config: ScanConfig, startedAt: string, t0: number, kind: 'discovery' | 'refresh') {
  const { matched, stats } = matchEvents(rawPool)
  const multi = matched.filter((m) => m.sources.length > 1)
  const { opportunities, margins } = scanForArbitrage(matched, config.minPercent)
  const now = new Date().toISOString()

  snapshot = {
    opportunities,
    margins,
    books: lastBooks,
    eventCount: rawPool.length,
    matchedCount: multi.length,
    srMatchRate: multi.length ? multi.filter((m) => m.sportradarId != null).length / multi.length : 0,
    deepenedCount: snapshot.deepenedCount,
    flippedSources: stats.flipped,
    droppedSources: stats.dropped,
    hotCount: hotSelection(matched, config).length,
    hostLoad: httpStats(),
    lastDiscovery: kind === 'discovery' ? now : snapshot.lastDiscovery,
    lastRefresh: now,
    startedAt,
    durationMs: Date.now() - t0,
  }
  return snapshot
}

/**
 * Events, die den schnellen Takt bekommen.
 *
 * Laufende Spiele bleiben außen vor: sie führen ohnehin zu keiner
 * ausgewiesenen Arbitrage mehr, und der knappe Refresh-Etat gehört den
 * Vorspiel-Partien, die kurz vor einer Arbitrage stehen.
 */
function hotSelection(matched: ReturnType<typeof matchEvents>['matched'], config: ScanConfig) {
  return matched
    .filter((m) => m.sources.length > 1 && !m.isLive)
    .map((m) => ({ ev: m, heat: eventHeat(m) }))
    .filter((x) => x.heat <= config.hotThreshold)
    .sort((a, b) => a.heat - b.heat)
    .slice(0, config.maxHotEvents)
    .map((x) => x.ev)
}

/* ----------------------------------------------------------- Tiefenbudget */

/**
 * Verteilt das Tiefenbudget eines Buchmachers auf die Sportarten.
 *
 * Vorher wurde schlicht nach Anstoßzeit sortiert und global abgeschnitten.
 * Solange es nur Fußball gab, war das richtig: die Partie, die als nächstes
 * angepfiffen wird, ist die, die am ehesten spielbar ist. Mit einer zweiten
 * Sportart wird daraus ein Verdrängungswettbewerb — und zwar ein unfairer,
 * denn Tennis wird über den Tag verteilt angesetzt, Fußball geballt am Abend.
 * Gemessen bei bwin: die Tiefe fiel von 120 auf 55 vertiefte Partien, weil das
 * Budget vorne von Tennispartien aufgebraucht war. Das kostete Fußball-
 * Abdeckung, ohne dass irgendwo ein Fehler auftauchte.
 *
 * Die Aufteilung ist ein gleicher Grundanteil je Sportart, danach wandert der
 * Rest reihum an die Sportarten, die noch Kandidaten übrig haben. Damit
 * verschenkt eine kleine Sportart nichts: hat Tennis bei einem Buch nur 20
 * vergleichbare Partien, bekommt Fußball die übrigen 100 — und umgekehrt.
 *
 * Zurück kommt die Auswahl **reihum gemischt**, nicht nach Sportart geblockt.
 * Das ist kein Schönheitsfehler, sondern nötig: Winamax deckelt die Liste
 * intern noch einmal bei 60. Käme sie sortiert, bekäme dieser Adapter
 * ausschließlich die alphabetisch erste Sportart.
 */
export function allocateDepth<T extends { sport: string; startTime: string }>(
  targets: T[],
  budget: number,
): T[] {
  if (budget <= 0 || !targets.length) return []

  const bySport = new Map<string, T[]>()
  for (const t of targets) {
    const list = bySport.get(t.sport)
    if (list) list.push(t)
    else bySport.set(t.sport, [t])
  }
  // Innerhalb einer Sportart bleibt es beim Anstoß: was zuerst angepfiffen
  // wird, ist zuerst spielbar.
  for (const list of bySport.values())
    list.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())

  const sports = [...bySport.keys()].sort()
  const quota = new Map(sports.map((s) => [s, 0]))
  let left = budget

  const base = Math.floor(budget / sports.length)
  for (const s of sports) {
    const n = Math.min(base, bySport.get(s)!.length)
    quota.set(s, n)
    left -= n
  }
  // Rest reihum, bis er aufgebraucht ist oder keine Kandidaten mehr da sind.
  for (let moved = true; left > 0 && moved; ) {
    moved = false
    for (const s of sports) {
      if (left <= 0) break
      const have = quota.get(s)!
      if (have >= bySport.get(s)!.length) continue
      quota.set(s, have + 1)
      left--
      moved = true
    }
  }

  const out: T[] = []
  const cursor = new Map(sports.map((s) => [s, 0]))
  for (let added = true; added; ) {
    added = false
    for (const s of sports) {
      const i = cursor.get(s)!
      if (i >= quota.get(s)!) continue
      out.push(bySport.get(s)![i])
      cursor.set(s, i + 1)
      added = true
    }
  }
  return out
}

/* --------------------------------------------------------------- Discovery */

/**
 * Fehler, hinter denen eine abgerissene Dauerverbindung steckt.
 *
 * Drei Anbieter holen ihre Daten nicht über einzelne Abrufe, sondern über eine
 * offene Verbindung: VBET (Swarm), DAZN Bet (STOMP) und AdmiralBet (ASW). Die
 * überlebt nicht alles — schläft der Rechner ein, ist sie beim Aufwachen tot,
 * und dasselbe passiert bei jedem Netzwechsel. Gemessen an einem Vormittag
 * mit sechs Schlafphasen: jede einzelne kostete mindestens eines der drei
 * Bücher komplett, weil `sweep` bei einer Ausnahme `events: []` zurückgibt.
 *
 * Wiederholen hilft hier, anders als bei HTTP-Fehlern: die Transportklassen
 * bauen beim nächsten Aufruf von sich aus neu auf. Der zweite Versuch trifft
 * also eine frische Verbindung, nicht dieselbe kaputte.
 *
 * Bewusst breit — Abbruch, Zeitüberschreitung und abgelehnter Handschlag
 * gehören alle dazu. Ein zweiter Versuch kostet den Sweep eines Buches; ein
 * verlorenes Buch kostet jede Arbitrage, die über es gelaufen wäre.
 */
const ABBRUCH =
  /geschlossen|Verbindungsfehler|Verbindungsaufbau|Handshake|Handschlag|nicht offen|keine Antwort|überschritten/i

export const istVerbindungsabbruch = (e: unknown): boolean =>
  e instanceof Error && ABBRUCH.test(e.message)

/**
 * Führt einen Abruf aus und wiederholt ihn einmal, wenn die Dauerverbindung
 * abgerissen ist.
 *
 * Der zweite Versuch trifft eine **frische** Verbindung: die Transportklassen
 * räumen bei einem Abbruch auf und bauen beim nächsten Aufruf neu auf. Deshalb
 * lohnt Wiederholen hier, anders als bei einem inhaltlichen Fehler.
 *
 * Nur für `websocket`. Die HTTP-Adapter wiederholen bereits je Anfrage in
 * `fetchText` — dort wäre das eine Schleife um eine Schleife.
 */
export async function versuchen<T>(
  adapter: BookmakerAdapter,
  fn: () => Promise<T>,
  onRetry?: (grund: string) => void,
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (adapter.transport !== 'websocket' || !istVerbindungsabbruch(e)) throw e
    onRetry?.(e instanceof Error ? e.message : String(e))
    return await fn()
  }
}

async function sweep(adapter: BookmakerAdapter, config: ScanConfig): Promise<AdapterResult> {
  const start = Date.now()
  const ctx = { windowMs: config.windowMs, maxEvents: config.maxEvents }
  let retried: string | undefined
  try {
    const events = await versuchen(
      adapter,
      () => adapter.fetchEvents(ctx),
      (grund) => (retried = grund),
    )
    return { bookmakerId: adapter.id, events, durationMs: Date.now() - start, retried }
  } catch (e) {
    return {
      bookmakerId: adapter.id,
      events: [],
      durationMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
      retried,
    }
  }
}

async function doDiscovery(config: ScanConfig): Promise<ScanSnapshot> {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  // Die Telemetrie zählt je Durchlauf, nicht seit Prozessstart — sonst
  // verwässert ein einzelner schlechter Lauf über die Stunden zur Unsichtbarkeit.
  resetHttpStats()

  const books = await Promise.all(ADAPTERS.map((a) => sweep(a, config)))
  const shallow = books.flatMap((b) => b.events)

  // Nur Events, die bei mindestens zwei Buchmachern existieren, können
  // überhaupt eine Arbitrage ergeben — nur die lohnen die teure Markttiefe.
  const preMatched = matchEvents(shallow).matched
  const worthwhile = new Set(
    preMatched
      .filter((m) => m.sources.length > 1)
      .flatMap((m) => m.sources.map((s) => `${s.bookmakerId}:${s.bookEventId}`)),
  )

  const deepened = await Promise.all(
    ADAPTERS.map(async (adapter, i) => {
      const book = books[i]
      if (!adapter.fetchDepth || book.error) return book
      // Reihenfolge nach Anstoß, nicht nach Antwortreihenfolge des Anbieters.
      // Bei einem Wochenfenster überschreitet die Zahl vergleichbarer Partien
      // die Obergrenze regelmäßig; wer dann willkürlich abschneidet, verliert
      // ausgerechnet die Partien, die als nächstes spielbar wären. Das Budget
      // wird dabei je Sportart aufgeteilt — siehe `allocateDepth`.
      // `depthSports` schließt Sportarten aus, bei denen der Detailabruf
      // dieses Anbieters nichts hinzufügt — sonst verbrauchen sie Budget, das
      // einer anderen Sportart echte Märkte gebracht hätte.
      const enriches = adapter.depthSports
      const targets = allocateDepth(
        book.events.filter(
          (e) =>
            worthwhile.has(`${e.bookmakerId}:${e.bookEventId}`) &&
            (!enriches || enriches.includes(sportOf(e.sport))),
        ),
        config.maxDepthEvents,
      )
      if (!targets.length) return { ...book, deepenTargets: 0 }
      try {
        const enriched = await versuchen(adapter, () =>
          adapter.fetchDepth!(targets, {
            windowMs: config.windowMs,
            maxEvents: config.maxEvents,
          }),
        )
        const byId = new Map(enriched.map((e) => [e.bookEventId, e]))

        // Adapter geben bei einem Fehlschlag den Sweep-Stand zurück, damit ein
        // hakendes Event nicht das ganze Buch kostet. Für die Zählung ist das
        // aber kein Erfolg: vertieft ist nur, wo tatsächlich mehr Märkte
        // ankamen als vorher. Sonst meldet die Diagnose 60 von 60, während in
        // Wahrheit ein Drittel der Anfragen abgewiesen wurde.
        const before = new Map(targets.map((e) => [e.bookEventId, e.outcomes.length]))
        let gained = 0
        for (const e of enriched) if (e.outcomes.length > (before.get(e.bookEventId) ?? 0)) gained++

        return {
          ...book,
          events: book.events.map((e) => byId.get(e.bookEventId) ?? e),
          deepened: gained,
          deepenTargets: targets.length,
        }
      } catch (e) {
        return {
          ...book,
          deepened: 0,
          deepenTargets: targets.length,
          error: `Tiefe: ${e instanceof Error ? e.message : String(e)}`,
        }
      }
    }),
  )

  rawPool = deepened.flatMap((b) => b.events)
  lastBooks = deepened.map((b) => ({ ...b, eventCount: b.events.length, events: [] }))
  snapshot = { ...snapshot, deepenedCount: deepened.reduce((s, b) => s + (b.deepened ?? 0), 0) }
  return evaluate(config, startedAt, t0, 'discovery')
}

/* ----------------------------------------------------------------- Refresh */

async function doRefresh(config: ScanConfig): Promise<ScanSnapshot> {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  if (!rawPool.length) return snapshot

  const { matched } = matchEvents(rawPool)
  const hot = hotSelection(matched, config)
  if (!hot.length) return evaluate(config, startedAt, t0, 'refresh')

  // Nach dem Ausrichten sind gedrehte Quellen Kopien — deshalb über die
  // Buchmacher-ID plus Event-ID zurück auf den Rohbestand abbilden.
  const wanted = new Set(hot.flatMap((m) => m.sources.map((s) => `${s.bookmakerId}:${s.bookEventId}`)))

  const updates = await Promise.all(
    ADAPTERS.map(async (adapter) => {
      if (!adapter.fetchDepth) return [] as RawEvent[]
      const targets = rawPool.filter(
        (e) => e.bookmakerId === adapter.id && wanted.has(`${e.bookmakerId}:${e.bookEventId}`),
      )
      if (!targets.length) return [] as RawEvent[]
      try {
        return await adapter.fetchDepth(targets, {
          windowMs: config.windowMs,
          maxEvents: config.maxEvents,
        })
      } catch {
        // Ein Anbieter, der gerade zickt, darf den Takt nicht anhalten.
        return [] as RawEvent[]
      }
    }),
  )

  const fresh = new Map(updates.flat().map((e) => [`${e.bookmakerId}:${e.bookEventId}`, e]))
  if (fresh.size) {
    rawPool = rawPool.map((e) => fresh.get(`${e.bookmakerId}:${e.bookEventId}`) ?? e)
  }
  return evaluate(config, startedAt, t0, 'refresh')
}

/* ------------------------------------------------------------- Öffentlich */

/** Vollständiger Durchlauf. Läuft bereits einer, wird auf ihn gewartet. */
export function runDiscovery(config: ScanConfig): Promise<ScanSnapshot> {
  if (discoveryInFlight) return discoveryInFlight
  discoveryInFlight = doDiscovery(config).finally(() => {
    discoveryInFlight = null
  })
  return discoveryInFlight
}

/** Schneller Takt für die heißen Events. */
export function runRefresh(config: ScanConfig): Promise<ScanSnapshot> {
  if (discoveryInFlight) return discoveryInFlight
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = doRefresh(config).finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

/**
 * Was der Aktualisieren-Knopf auslöst.
 *
 * Anders als früher wird hier nie der alte Stand zurückgegeben: läuft gerade
 * ein Durchlauf, wird er abgewartet und **danach** ein frischer gestartet.
 * Sonst hätte der Knopf sichtbar nichts getan.
 */
export async function forceRefresh(config: ScanConfig): Promise<ScanSnapshot> {
  if (discoveryInFlight) await discoveryInFlight
  else if (refreshInFlight) await refreshInFlight
  return runRefresh(config)
}

export async function forceDiscovery(config: ScanConfig): Promise<ScanSnapshot> {
  if (discoveryInFlight) await discoveryInFlight
  if (refreshInFlight) await refreshInFlight
  return runDiscovery(config)
}
