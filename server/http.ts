import { Impit } from 'impit'
import { taped } from './tape.ts'

/**
 * HTTP-Schicht für alle Adapter: Ratenbegrenzung je Host, Timeout, Retry.
 *
 *  - `plain` — normales fetch
 *  - `impit` — bildet Chromes TLS-Handshake nach, wo Cloudflare den
 *              Fingerprint prüft (Betano)
 */

type Transport = 'plain' | 'impit'

const impit = new Impit({ browser: 'chrome' })

const DEFAULT_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
  // Tipico setzt `max-age=30`; ohne no-cache droht eine 30 s alte Antwort.
  'cache-control': 'no-cache',
  pragma: 'no-cache',
}

/* --------------------------------------------------------- Host-Richtlinie */

/**
 * Was ein Host verträgt. Die Rate bestimmt der Host, nicht der Aufrufer:
 * mehrere Adapter auf einem Host teilen sich das Budget, und die Poolgrößen
 * der Adapter bestimmen nur noch die Länge der Warteschlange. Das
 * `minIntervalMs` eines Adapters wirkt nur nach oben.
 */
type HostPolicy = {
  /** Mindestabstand zwischen zwei Anfragen an diesen Host (ms) */
  minIntervalMs: number
  /** Wie viele Anfragen gleichzeitig unterwegs sein dürfen */
  maxConcurrent: number
}

const DEFAULT_POLICY: HostPolicy = { minIntervalMs: 250, maxConcurrent: 4 }

/** Gemessen an vollen Durchläufen, in denen alle Adapter gleichzeitig laufen. */
const HOST_POLICIES: Record<string, HostPolicy> = {
  // Wenige große Seiten (~5,8 MB); Parallelität provoziert nur die Abwehr.
  'eventservice.sportwetten.de': { minIntervalMs: 200, maxConcurrent: 1 },
  'www.sportwetten.de': { minIntervalMs: 300, maxConcurrent: 1 },

  'sports.tipico.de': { minIntervalMs: 100, maxConcurrent: 5 },

  // Hängt an einem Sitzungs-Cookie; fällt das Aufwärmen aus, ist der Sweep hin.
  'www.wettarena.de': { minIntervalMs: 120, maxConcurrent: 2 },

  // Entain: drei Marken auf derselben cds-api-Software, getrennte Hosts.
  'www.bwin.de': { minIntervalMs: 120, maxConcurrent: 4 },
  'www.sportingbet.de': { minIntervalMs: 120, maxConcurrent: 4 },
  'www.oddset.de': { minIntervalMs: 120, maxConcurrent: 4 },

  // Betano braucht einen Abruf je Liga (~180) und verträgt sie ohne Abweisung.
  'www.betano.de': { minIntervalMs: 35, maxConcurrent: 8 },
  'eu-offering-api.kambicdn.com': { minIntervalMs: 100, maxConcurrent: 6 },
  // Winamax hat schon im Vier-Sekunden-Takt mit 403 geantwortet.
  'www.winamax.de': { minIntervalMs: 250, maxConcurrent: 4 },
  'www.interwetten.de': { minIntervalMs: 400, maxConcurrent: 2 },
  'betway.de': { minIntervalMs: 400, maxConcurrent: 2 },
  'neobet.de': { minIntervalMs: 400, maxConcurrent: 2 },
  'www.888sport.de': { minIntervalMs: 400, maxConcurrent: 2 },
  'spectate-web.888sport.de': { minIntervalMs: 200, maxConcurrent: 4 },
  // OpenBet ruft mit `pooled(…, 40, …)` ab — der Deckel fängt den Schub ab.
  'sb-pp-defe.daznbet.de': { minIntervalMs: 30, maxConcurrent: 12 },
}

const policyFor = (host: string): HostPolicy => HOST_POLICIES[host] ?? DEFAULT_POLICY

/* -------------------------------------------------------------- Host-Staat */

/**
 * Nach einer 429/403 wird der Mindestabstand des Hosts vervielfacht, damit
 * auch die folgenden Anfragen ruhiger laufen; nach Ruhe klingt es ab.
 */
const PENALTY_START = 2
const PENALTY_MAX = 8
const PENALTY_COOLDOWN_MS = 30_000

/** Wie lange ein Host als „weist grundsätzlich ab“ gilt — die Markierung muss auslaufen, sonst bleibt er für immer gesperrt. */
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
 * Belegt den nächsten freien Zeitpunkt und liefert die Wartezeit. Lesen und
 * Schreiben ohne `await` dazwischen — sonst lesen gleichzeitige Aufrufer
 * denselben Wert und feuern zusammen los.
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

type FetchOptions = {
  transport?: Transport
  headers?: Record<string, string>
  /**
   * Gewünschter Mindestabstand (ms). Wirkt nur nach oben — die Untergrenze
   * setzt `HOST_POLICIES`.
   */
  minIntervalMs?: number
  timeoutMs?: number
  /**
   * 403 als vorübergehende Abweisung an der Kante (CloudFront, Cloudflare)
   * wiederholen — Standard. Abschalten, wo 403 dauerhaft gemeint ist.
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
 * Wiederholt werden 5xx, 429 und (abschaltbar) 403. Abweisungen der Abwehr
 * bekommen längeren Backoff und mehr Versuche als ein hakender Server.
 */
const BLOCKED_BACKOFF_MS = 1_200
const SERVER_BACKOFF_MS = 400
const BLOCKED_BACKOFF_CAP_MS = 3_000
const RETRIES = 2
const BLOCKED_RETRIES = 4

/** Ab so vielen Abweisungen je Host im Durchlauf wird nicht mehr wiederholt — jede Kette kostet sonst ~13 s ohne Ertrag. */
const BLOCK_GIVE_UP = 6

export function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  // Kekse wechseln je Sitzung und gehören nicht zur Identität der Anfrage.
  const { cookie: _cookie, ...headers } = opts.headers ?? {}
  return taped(`http ${url} ${JSON.stringify(headers)}`, () => fetchLive(url, opts))
}

async function fetchLive(url: string, opts: FetchOptions): Promise<string> {
  const {
    transport = 'plain',
    minIntervalMs = 0,
    timeoutMs = 12_000,
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
  let budget = RETRIES
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

/** Führt Aufgaben mit begrenzter Parallelität aus. Die Rate gegen einen Host bestimmt `HOST_POLICIES`, nicht der Pool. */
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
