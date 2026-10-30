import type { BetWarningId, Filters, Opportunity, PushConfig, Settings } from '../types'
import { ALL_WARNING_IDS } from '../data/warnings.ts'
import { DEFAULT_WINDOW_HOURS } from './window.ts'

/**
 * Anbindung ans Scanner-Backend.
 *
 * Läuft das Backend nicht, fällt die App auf den Demo-Generator zurück,
 * statt eine leere Liste zu zeigen — die UI bleibt so immer bedienbar.
 */

export type ScanStatus = {
  online: boolean
  lastScan: string | null
  /** Zeitpunkt der letzten Quotenaktualisierung — das ist das Alter der Daten */
  lastRefresh: string | null
  /** Wie viele Events im schnellen Takt beobachtet werden */
  hotCount: number
  eventCount: number
  matchedCount: number
  srMatchRate: number
  /** Quellen, deren Heim/Auswärts-Ausrichtung korrigiert werden musste */
  flippedSources: number
  /** Quellen, die wegen unklarer Zuordnung verworfen wurden */
  droppedSources: number
  books: { bookmakerId: string; durationMs: number; error?: string }[]
  /** Zeitfenster des Scanners in Stunden — vom Server, damit die Oberfläche gleich zuschneidet. */
  windowHours: number
  /** Knappste Vergleiche, auch wenn sie keine Arbitrage sind */
  margins: {
    event: string
    sport: string
    league: string
    market: string
    impliedPercent: number
    legs: { label: string; odds: number; bookmakerId: string }[]
  }[]
}

type ApiOutcome = {
  label: string
  best: { bookmakerId: string; odds: number }
  all: { bookmakerId: string; odds: number }[]
}

type ApiOpportunity = {
  id: string
  sport: string
  league: string
  home: string
  away: string
  startTime: string
  isLive: boolean
  market: string
  marketFamily: string
  outcomes: ApiOutcome[]
  warnings: string[]
  arbPercent: number
  links: Record<string, string>
}

type ApiSnapshot = {
  opportunities: ApiOpportunity[]
  margins: ScanStatus['margins']
  books: { bookmakerId: string; durationMs: number; error?: string }[]
  eventCount: number
  matchedCount: number
  srMatchRate: number
  flippedSources?: number
  droppedSources?: number
  hotCount?: number
  lastRefresh?: string
  windowHours?: number
  startedAt: string
}

const KNOWN_WARNINGS = new Set<string>(ALL_WARNING_IDS)

function toOpportunity(o: ApiOpportunity): Opportunity {
  return {
    id: o.id,
    sport: o.sport,
    league: o.league,
    home: o.home,
    away: o.away,
    startTime: o.startTime,
    isLive: o.isLive,
    market: o.market,
    marketFamily: o.marketFamily,
    outcomes: o.outcomes.map((oc) => ({
      label: oc.label,
      best: oc.best,
      all: oc.all,
    })),
    warnings: o.warnings.filter((w): w is BetWarningId => KNOWN_WARNINGS.has(w)),
    links: o.links,
  }
}

export async function fetchOpportunities(
  signal?: AbortSignal,
): Promise<{ opportunities: Opportunity[]; status: ScanStatus }> {
  const res = await fetch('/api/opportunities', { signal })
  if (!res.ok) throw new Error(`Backend antwortete mit ${res.status}`)
  const snap: ApiSnapshot = await res.json()

  return {
    opportunities: snap.opportunities.map(toOpportunity),
    status: {
      online: true,
      lastScan: snap.startedAt,
      lastRefresh: snap.lastRefresh ?? snap.startedAt,
      hotCount: snap.hotCount ?? 0,
      eventCount: snap.eventCount,
      matchedCount: snap.matchedCount,
      srMatchRate: snap.srMatchRate,
      flippedSources: snap.flippedSources ?? 0,
      droppedSources: snap.droppedSources ?? 0,
      books: snap.books,
      windowHours: snap.windowHours ?? DEFAULT_WINDOW_HOURS,
      margins: snap.margins ?? [],
    },
  }
}

/* ------------------------------------------------- Meldungen aufs Telefon */

export type PushStatus = {
  /** Ist auf dem Server ein Meldeweg eingerichtet? */
  ready: boolean
  /** Welcher — ohne das Geheimnis, nur zur Anzeige. */
  via: string | null
  /** Hat der Server schon einen Filter von der Oberfläche bekommen? */
  hasConfig: boolean
}

/** Spiegelt den kompletten Filter zum Server; dort läuft dasselbe `applyFilters`. */
export async function putAlertConfig(
  filters: Filters,
  settings: Settings,
  push: PushConfig,
  signal?: AbortSignal,
): Promise<PushStatus | null> {
  try {
    const res = await fetch('/api/alerts/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filters, settings, push }),
      signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as { push?: PushStatus }
    return body.push ?? null
  } catch {
    // Backend nicht erreichbar — die Oberfläche bleibt bedienbar.
    return null
  }
}

/**
 * Holt den auf dem Server abgelegten Zugang — sonst überschriebe die erste
 * Spiegelung eines frischen Browsers ihn mit einem leeren.
 */
export async function fetchAlertConfig(): Promise<{
  push: PushConfig | null
  status: PushStatus | null
}> {
  try {
    const res = await fetch('/api/alerts/config')
    if (!res.ok) return { push: null, status: null }
    const body = (await res.json()) as {
      config?: { push?: PushConfig } | null
      push?: PushStatus
    }
    return { push: body.config?.push ?? null, status: body.push ?? null }
  } catch {
    return { push: null, status: null }
  }
}

/** Schickt eine Probemeldung über den eingerichteten Weg. */
export async function testPush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/alerts/test', { method: 'POST' })
    if (res.ok) return { ok: true }
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return { ok: false, error: body.error ?? `Server antwortete mit ${res.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Backend nicht erreichbar' }
  }
}

/** Lädt die Quoten sofort nach und wartet darauf; `full` erzwingt einen kompletten Durchlauf. */
export async function triggerScan(full = false, signal?: AbortSignal): Promise<void> {
  await fetch(full ? '/api/scan?full=1' : '/api/scan', { signal })
}
