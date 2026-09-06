import { Impit } from 'impit'

/**
 * HTTP-Schicht für alle Adapter.
 *
 * Zwei Transporte, weil die Anbieter unterschiedlich streng sind:
 *  - `plain`  — normales fetch. Reicht z.B. für Tipico.
 *  - `impit`  — bildet Chromes TLS-Handshake (JA3/JA4) nach. Nötig überall
 *               dort, wo Cloudflare passiv den Fingerprint prüft und curl
 *               deshalb 403 bekommt, obwohl die Header stimmen (Betano).
 *
 * Ein echter Browser wird nirgends gestartet — das wäre um Größenordnungen
 * langsamer und würde bei ~24 Anbietern im Sekundentakt nicht skalieren.
 */

type Transport = 'plain' | 'impit'

const impit = new Impit({ browser: 'chrome' })

const DEFAULT_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
  // Tipico setzt auf seinen Datenendpunkten `cache-control: private, max-age=30`.
  // Ohne diese Header riskieren wir, dass irgendwo auf dem Weg eine bis zu
  // 30 Sekunden alte Antwort zurückkommt — bei Quoten, die Sekunden leben,
  // ist das der Unterschied zwischen platzierbar und verpasst.
  'cache-control': 'no-cache',
  pragma: 'no-cache',
}

/* --------------------------------------------------------- Host-Richtlinie */

/**
 * Was ein Host verträgt — Mindestabstand und wie viele Anfragen gleichzeitig.
 *
 * Vorher stand das verstreut in den Adaptern: jeder gab sein `minIntervalMs`
 * mit, und wie viele Anfragen tatsächlich gleichzeitig liefen, ergab sich aus
 * der Poolgröße am Aufrufort. Unter Last war das nicht mehr steuerbar — die
 * Tiefenphase mehrerer Adapter überlappt, und ein Host sieht die Summe.
 * Sichtbar wurde das als schwankende Laufzeit statt als Fehler: Sportwetten.de
 * 15,3 s statt 1,8 s, Tipico nur 48 statt 60 vertiefte Partien, WettArena in
 * einem Lauf mit 0 Events.
 *
 * Deshalb entscheidet jetzt der Host, nicht der Aufrufer. Die Poolgrößen in
 * den Adaptern bleiben, verlieren aber ihre Wirkung als Ratenregler: sie
 * bestimmen nur noch, wie viele Aufgaben im Wartezimmer stehen.
 *
 * `minIntervalMs` ist eine **Untergrenze**. Gibt ein Adapter einen größeren
 * Wert mit, gilt seiner; ein kleinerer wird angehoben.
 */
type HostPolicy = {
  /** Mindestabstand zwischen zwei Anfragen an diesen Host (ms) */
  minIntervalMs: number
  /** Wie viele Anfragen gleichzeitig unterwegs sein dürfen */
  maxConcurrent: number
}

const DEFAULT_POLICY: HostPolicy = { minIntervalMs: 250, maxConcurrent: 4 }

/**
 * Je Host die gemessene Belastungsgrenze.
 *
 * Die Werte stammen aus den Laufzeiten voller Durchläufe, nicht aus
 * Einzelmessungen: entscheidend ist, was der Host verträgt, während alle
 * anderen Adapter ebenfalls laufen.
 */
const HOST_POLICIES: Record<string, HostPolicy> = {
  // Sequentielle Seitenabrufe, ~6 Seiten à 5,8 MB. Mehr als eine Anfrage
  // gleichzeitig bringt nichts und provoziert nur die Abwehr.
  'eventservice.sportwetten.de': { minIntervalMs: 200, maxConcurrent: 1 },
  'www.sportwetten.de': { minIntervalMs: 300, maxConcurrent: 1 },

  'sports.tipico.de': { minIntervalMs: 100, maxConcurrent: 5 },

  // WettArena hängt an einem Sitzungs-Cookie von der Startseite. Fällt das
  // Aufwärmen aus, ist der ganze Sweep hin — deshalb wenig Gleichzeitigkeit.
  'www.wettarena.de': { minIntervalMs: 120, maxConcurrent: 2 },

  // Entain: drei Marken auf derselben cds-api-Software, getrennte Hosts.
  'www.bwin.de': { minIntervalMs: 120, maxConcurrent: 4 },
  'www.sportingbet.de': { minIntervalMs: 120, maxConcurrent: 4 },
  'www.oddset.de': { minIntervalMs: 120, maxConcurrent: 4 },

  /**
   * Betano braucht viele kleine Abrufe, und verträgt sie.
   *
   * Der Anbieter hat keinen Endpunkt über alle Ligen: `league/hot/upcoming`
   * liefert je Aufruf nur eine „hot"-Auswahl von rund zwanzig Partien,
   * unabhängig davon wie viele Liga-IDs man mitgibt. Nachgemessen: 182 IDs in
   * einem Aufruf ergeben 6 Partien, 40 je Aufruf ergeben 99, und erst
   * **einzeln** kommen alle 495 zusammen. Sammeln ist hier also keine Option.
   *
   * Verträglichkeit nachgemessen: 182 Einzelabrufe, null Fehler, null
   * Abweisungen, null Wiederholungen. Bei 80 ms kostete das 14,8 s, wovon
   * 90 s reine Drosselung über alle Anfragen waren — der Takt war die Bremse,
   * nicht der Anbieter. 35 ms halten den Sweep bei rund 6 s und damit im
   * Rahmen der übrigen Adapter, die parallel laufen.
   */
  'www.betano.de': { minIntervalMs: 35, maxConcurrent: 8 },
  'eu-offering-api.kambicdn.com': { minIntervalMs: 100, maxConcurrent: 6 },
  // Winamax hat schon im Vier-Sekunden-Takt mit 403 geantwortet.
  'www.winamax.de': { minIntervalMs: 250, maxConcurrent: 4 },
  'www.interwetten.de': { minIntervalMs: 400, maxConcurrent: 2 },
  'betway.de': { minIntervalMs: 400, maxConcurrent: 2 },
  'neobet.de': { minIntervalMs: 400, maxConcurrent: 2 },
  'www.888sport.de': { minIntervalMs: 400, maxConcurrent: 2 },
  'spectate-web.888sport.de': { minIntervalMs: 200, maxConcurrent: 4 },
  // OpenBet-Köpfe werden mit `pooled(…, 40, …)` abgerufen; ohne Deckel wäre
  // das der härteste Schub im ganzen Durchlauf.
  'sb-pp-defe.daznbet.de': { minIntervalMs: 30, maxConcurrent: 12 },
}

const policyFor = (host: string): HostPolicy => HOST_POLICIES[host] ?? DEFAULT_POLICY

/* -------------------------------------------------------------- Host-Staat */

/**
 * Wie stark ein Host nach einer Abweisung gedrosselt wird.
 *
 * Eine 429 oder 403 ist die einzige belastbare Aussage darüber, dass die Rate
 * zu hoch war. Vorher wurde darauf nur mit Warten und Wiederholen reagiert —
 * die nächste Anfrage lief wieder im alten Takt und wurde wieder abgewiesen.
 * Der Multiplikator hält den ruhigeren Takt über den Einzelfall hinaus, so
 * dass der Rest des Durchlaufs durchkommt statt sein Budget zu verheizen.
 */
const PENALTY_START = 2
const PENALTY_MAX = 8
const PENALTY_COOLDOWN_MS = 30_000

/**
 * Wie lange ein Host als „weist grundsätzlich ab" gilt.
 *
 * Vorher war das dauerhaft und wurde nur durch eine erfolgreiche Antwort
 * gelöscht — die es nicht mehr geben konnte, wenn jede Anfrage sofort scheitert.
 * Ein Sweep, der einmal in die Sperre lief, blieb damit für die restliche
 * Laufzeit des Prozesses bei 0 Events. Jetzt läuft die Markierung aus.
 */
const HARD_BLOCK_MS = 120_000

type HostState = {
  policy: HostPolicy
  /** Frühestmöglicher Zeitpunkt für die nächste Anfrage */
  nextAllowed: number
  /** Anfragen, die gerade unterwegs sind */
  active: number
  /** Wartende Aufrufer, FIFO */
  queue: (() => void)[]
  /** Multiplikator auf den Mindestabstand nach Abweisungen */
  penalty: number
  penaltyUntil: number
  /** Bis wann der Host als grundsätzlich abweisend gilt (0 = nicht gesperrt) */
  hardBlockedUntil: number
  stats: HostStats
}

export type HostStats = {
  /** Tatsächlich abgesetzte Anfragen, Wiederholungen mitgezählt */
  requests: number
  /** Wiederholte Versuche — das Maß dafür, was die Retry-Schleife verdeckt */
  retries: number
  /** Abweisungen durch die Abwehr davor (429/403) */
  blocked: number
  /** Anfragen, die auch nach allen Versuchen scheiterten */
  failures: number
  /** Summe der Wartezeit im Takt- und Nebenläufigkeitsdeckel (ms) */
  throttledMs: number
  /** Höchster erreichter Drosselungsfaktor */
  maxPenalty: number
}

const hosts = new Map<string, HostState>()

function stateFor(host: string): HostState {
  let st = hosts.get(host)
  if (!st) {
    st = {
      policy: policyFor(host),
      nextAllowed: 0,
      active: 0,
      queue: [],
      penalty: 1,
      penaltyUntil: 0,
      hardBlockedUntil: 0,
      stats: { requests: 0, retries: 0, blocked: 0, failures: 0, throttledMs: 0, maxPenalty: 1 },
    }
    hosts.set(host, st)
  }
  return st
}

/** Momentaufnahme der Host-Telemetrie — Grundlage der Diagnose. */
export function httpStats(): Record<string, HostStats & { penalty: number; blockedUntil: string | null }> {
  const out: Record<string, HostStats & { penalty: number; blockedUntil: string | null }> = {}
  const now = Date.now()
  for (const [host, st] of hosts) {
    if (!st.stats.requests) continue
    out[host] = {
      ...st.stats,
      penalty: st.penalty,
      blockedUntil: st.hardBlockedUntil > now ? new Date(st.hardBlockedUntil).toISOString() : null,
    }
  }
  return out
}

export function resetHttpStats(): void {
  for (const st of hosts.values())
    st.stats = { requests: 0, retries: 0, blocked: 0, failures: 0, throttledMs: 0, maxPenalty: st.penalty }
}

/**
 * Belegt den nächsten freien Zeitpunkt für `host` und liefert die Wartezeit.
 *
 * Entscheidend ist, dass Lesen und Schreiben ohne `await` dazwischen
 * passieren: JavaScript unterbricht diese Funktion nirgends, damit sieht jeder
 * weitere Aufrufer den bereits belegten Zeitpunkt und reiht sich dahinter ein.
 *
 * Vorher wurde erst gewartet und danach geschrieben. Alle gleichzeitigen
 * Aufrufer lasen so denselben Wert, schliefen bis zur selben Millisekunde und
 * feuerten zusammen los: der Abstand galt zwischen Schüben, nicht zwischen
 * Requests, und die tatsächliche Rate war um den Faktor der Poolgröße zu hoch.
 */
function reserveSlot(st: HostState, minIntervalMs: number): number {
  const now = Date.now()
  if (st.penalty > 1 && now > st.penaltyUntil) {
    // Ruhe eingekehrt — schrittweise zurück in den normalen Takt.
    st.penalty = Math.max(1, st.penalty / 2)
  }
  const interval = Math.max(minIntervalMs, st.policy.minIntervalMs) * st.penalty
  const slot = Math.max(now, st.nextAllowed)
  st.nextAllowed = slot + interval
  return slot - now
}

/** Wartet auf einen freien Nebenläufigkeitsplatz des Hosts. */
async function acquire(st: HostState): Promise<void> {
  while (st.active >= st.policy.maxConcurrent) {
    await new Promise<void>((r) => st.queue.push(r))
  }
  st.active++
}

function release(st: HostState): void {
  st.active--
  st.queue.shift()?.()
}

function penalize(st: HostState): void {
  st.penalty = Math.min(st.penalty <= 1 ? PENALTY_START : st.penalty * 2, PENALTY_MAX)
  st.penaltyUntil = Date.now() + PENALTY_COOLDOWN_MS
  st.stats.maxPenalty = Math.max(st.stats.maxPenalty, st.penalty)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type FetchOptions = {
  transport?: Transport
  headers?: Record<string, string>
  /**
   * Gewünschter Mindestabstand (ms). Wirkt nur nach oben — die Untergrenze
   * setzt `HOST_POLICIES`.
   */
  minIntervalMs?: number
  timeoutMs?: number
  retries?: number
  /**
   * 403 als vorübergehende Bot-Abwehr behandeln und wiederholen (Standard).
   *
   * Gemessen an ~4.800 Requests über zehn volle Durchläufe: die 403 der Edges
   * (CloudFront „Request blocked“, Cloudflare-Challenge) kommen im Schnitt in
   * 43 ms zurück, erfolgreiche Antworten brauchen 116 ms. Es ist also eine
   * Abweisung an der Kante, keine Aussage über die Anfrage — und beim nächsten
   * Versuch geht dieselbe URL durch. Wer einen Endpunkt hat, der 403 dauerhaft
   * meint, schaltet das ab und spart die Wartezeit.
   */
  retryOn403?: boolean
}

class HttpError extends Error {
  status: number
  url: string
  body: string

  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} für ${url}`)
    this.status = status
    this.url = url
    this.body = body
  }
}

/**
 * Holt eine URL mit Rate-Limit pro Host, Timeout und Retry mit
 * exponentiellem Backoff.
 *
 * Wiederholt werden 5xx, 429 und — sofern nicht abgeschaltet — 403; alles
 * andere aus dem 4xx-Bereich ist ein Fehler auf unserer Seite und wird durch
 * Warten nicht besser. 429 und 403 kommen von der Abwehr davor und brauchen
 * deutlich mehr Ruhe als ein hakender Server: eigener Backoff, ein größeres
 * Versuchsbudget, und zusätzlich der Drosselungsfaktor auf dem Host, damit
 * die *nächsten* Anfragen nicht in dieselbe Wand laufen.
 */
const BLOCKED_BACKOFF_MS = 1_200
const SERVER_BACKOFF_MS = 400
const BLOCKED_BACKOFF_CAP_MS = 3_000
const BLOCKED_RETRIES = 4

/**
 * Ab wie vielen Abweisungen je Host nicht mehr wiederholt wird.
 *
 * Die Wiederholung setzt darauf, dass die Sperre den Einzelfall betrifft. Wenn
 * ein Host in diesem Durchlauf schon reihenweise abweist, trifft diese Annahme
 * nicht mehr zu — dann kostet jede weitere Kette rund 13 Sekunden Backoff und
 * holt kein Event mehr. Gemessen an WettArena: erste Kette 19 s, danach
 * scheiterte ohnehin alles. Mit dieser Grenze zahlt nur die erste Kette.
 */
const BLOCK_GIVE_UP = 6

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const {
    transport = 'plain',
    minIntervalMs = 0,
    timeoutMs = 12_000,
    retries = 2,
    retryOn403 = true,
  } = opts
  const host = new URL(url).host
  const st = stateFor(host)

  // 429 ist eine ausdrückliche Aussage über die Rate und wird immer wiederholt;
  // 403 nur, solange der Host nicht als dauerhaft sperrend gilt.
  const retry403 = retryOn403 && st.hardBlockedUntil <= Date.now()
  const isBlock = (status: number) =>
    st.stats.blocked < BLOCK_GIVE_UP && (status === 429 || (status === 403 && retry403))
  const retryableStatus = (status: number) => status >= 500 || isBlock(status)

  let lastError: unknown
  let backoffMs = SERVER_BACKOFF_MS
  let budget = retries
  for (let attempt = 0; attempt <= budget; attempt++) {
    if (attempt > 0) st.stats.retries++

    const gateStart = Date.now()
    await acquire(st)
    try {
      const wait = reserveSlot(st, minIntervalMs)
      if (wait > 0) await sleep(wait)
      st.stats.throttledMs += Date.now() - gateStart
      st.stats.requests++

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const headers = { ...DEFAULT_HEADERS, ...opts.headers }
        const res =
          transport === 'impit'
            ? await impit.fetch(url, { headers, signal: ctrl.signal })
            : await fetch(url, { headers, signal: ctrl.signal })

        const body = await res.text()
        if (!res.ok) {
          const err = new HttpError(res.status, url, body.slice(0, 200))
          if (res.status === 429 || res.status === 403) {
            st.stats.blocked++
            penalize(st)
          }
          if (!retryableStatus(res.status)) throw err
          if (isBlock(res.status)) {
            backoffMs = BLOCKED_BACKOFF_MS
            budget = Math.max(budget, BLOCKED_RETRIES)
          }
          lastError = err
        } else {
          st.hardBlockedUntil = 0
          return body
        }
      } catch (e) {
        if (e instanceof HttpError && !retryableStatus(e.status)) throw e
        lastError = e
      } finally {
        clearTimeout(timer)
      }
    } finally {
      release(st)
    }

    if (attempt < budget)
      await sleep(Math.min(backoffMs * 2 ** attempt, BLOCKED_BACKOFF_CAP_MS) + Math.random() * 200)
  }
  st.stats.failures++
  if (retry403 && lastError instanceof HttpError && lastError.status === 403)
    st.hardBlockedUntil = Date.now() + HARD_BLOCK_MS
  throw lastError
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, opts)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Ungültiges JSON von ${url}: ${text.slice(0, 160)}`)
  }
}

/**
 * Führt Aufgaben mit begrenzter Parallelität aus.
 *
 * Die Rate gegen einen Host bestimmt der Pool **nicht** — dafür sind
 * `HOST_POLICIES` und `minIntervalMs` zuständig. Der Pool muss nur groß genug
 * sein, um die Antwortzeit zu überdecken.
 */
export async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i]) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(runners)
  return results
}
