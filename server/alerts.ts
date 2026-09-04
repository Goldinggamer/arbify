import { readFileSync, writeFileSync } from 'node:fs'
import type { Filters, Opportunity, PushConfig, Settings } from '../src/types.ts'
import { applyFilters } from '../src/lib/filter.ts'
import { arbPercentOf } from '../src/lib/arbitrage.ts'
import { BOOKMAKERS } from '../src/data/bookmakers.ts'
import { WARNING_BY_ID } from '../src/data/warnings.ts'
import { ALL_WARNING_IDS } from '../src/data/warnings.ts'
import type { BetWarningId } from '../src/types.ts'
import type { ScanOpportunity } from './scan.ts'
import { configuredTransport, type PushMessage, type PushTransport } from './notify.ts'
import { DEFAULT_WINDOW_HOURS, hoursToMs } from '../src/lib/window.ts'

/**
 * Meldungen aufs Telefon — die Entscheidung, **was** gemeldet wird.
 *
 * ## Warum der Filter hier landet
 *
 * Der Nutzer stellt seinen Filter im Browser ein: Buchmacher, Sportarten,
 * Märkte, Quotenspanne, ausgeblendete Warnungen. Der Server kannte davon
 * bisher nichts — er meldet aber, während niemand vor dem Bildschirm sitzt.
 *
 * Ein zweiter, serverseitiger Filter wäre die naheliegende Lösung und die
 * falsche: zwei Implementierungen driften auseinander, und dann meldet das
 * Telefon Funde, die auf dem Bildschirm gar nicht stehen — oder umgekehrt.
 * Beides macht die Meldung wertlos, weil man ihr nicht mehr trauen kann.
 *
 * Stattdessen schickt die Oberfläche ihren Filter an den Server, und hier
 * läuft **dasselbe `applyFilters`** aus `src/lib/filter.ts`. Eine
 * Implementierung, zwei Verbraucher. Möglich ist das, weil die Filterkette
 * reines TypeScript ohne Browser-Aufrufe ist — nachgeprüft.
 *
 * ## Warum die Entscheidung eine reine Funktion ist
 *
 * `decide()` verschickt nichts und liest keine Uhr. Entdopplung, Ruhezeit und
 * Mengenbegrenzung sind genau die Regeln, bei denen ein Fehler entweder
 * nervt (zu viel) oder unsichtbar bleibt (zu wenig) — beides fällt im Betrieb
 * kaum auf. Deshalb sind sie testbar getrennt vom Versand.
 */

/** Wie lange derselbe Fund nach einer Meldung stumm bleibt. */
const COOLDOWN_MS = Number(process.env.ARBIFY_PUSH_COOLDOWN_MS ?? 30 * 60_000)

/** Fenster und Obergrenze gegen Lawinen. */
const RATE_WINDOW_MS = Number(process.env.ARBIFY_PUSH_WINDOW_MS ?? 10 * 60_000)
const RATE_MAX = Number(process.env.ARBIFY_PUSH_MAX ?? 8)

/** Ab wann ein Fund als „dringend" gilt und lauter gemeldet wird. */
const HIGH_PERCENT = Number(process.env.ARBIFY_PUSH_HIGH ?? 5)

/** Ältere Einträge im Gedächtnis sind bedeutungslos und würden nur wachsen. */
const FORGET_MS = 6 * 60 * 60_000

const STATE_FILE = process.env.ARBIFY_ALERT_FILE ?? '.arbify-alerts.json'

/**
 * Dasselbe Zeitfenster wie im Scanner und in der Oberfläche.
 *
 * Ohne diesen Zuschnitt würde die Telefonmeldung Partien melden, die auf dem
 * Bildschirm gar nicht stehen — und genau das soll die gemeinsame Filterkette
 * verhindern.
 */
const WINDOW_MS = hoursToMs(Number(process.env.WINDOW_HOURS ?? DEFAULT_WINDOW_HOURS))

export type AlertConfig = {
  filters: Filters
  settings: Settings
  /**
   * Zugang zum Meldedienst, aus dem Reiter „Telefon".
   *
   * Liegt hier statt in einer Umgebungsvariablen, damit der Nutzer ihn
   * einmal einträgt und nicht bei jedem `npm run dev` erneut. Die Datei
   * steht in `.gitignore` — das ntfy-Thema ist ein Geheimnis.
   */
  push?: PushConfig
  /** Wann die Oberfläche das zuletzt geschickt hat. */
  updatedAt: string
}

export type AlertState = {
  /** Fund-Kennung → Zeitpunkt der letzten Meldung */
  sent: Record<string, number>
  /** Zeitpunkte der jüngsten Meldungen, für die Mengenbegrenzung */
  recent: number[]
}

export const emptyState = (): AlertState => ({ sent: {}, recent: [] })

export type Decision = {
  /** Was jetzt verschickt wird, beste Rendite zuerst. */
  send: Opportunity[]
  /** Was über der Schwelle lag, aber unterdrückt wurde. */
  suppressed: number
  /** Warum unterdrückt wurde — nur gesetzt, wenn nichts oder weniger rausging. */
  reason?: 'aus' | 'nachtruhe' | 'menge' | 'ruhezeit'
  next: AlertState
}

/**
 * Liegt `now` in der Nachtruhe?
 *
 * Über Mitternacht hinweg gedacht: 23 bis 8 heißt 23, 0, …, 7. Sind Beginn und
 * Ende gleich, ist die Ruhezeit leer und nicht etwa ganztägig — sonst würde
 * eine versehentlich gleiche Einstellung jede Meldung für immer verschlucken.
 */
export function inQuietHours(now: Date, from: number, to: number): boolean {
  const h = now.getHours()
  if (from === to) return false
  return from < to ? h >= from && h < to : h >= from || h < to
}

/**
 * Was soll jetzt verschickt werden?
 *
 * `all` sind die Funde des Scanners, ungefiltert. `now` kommt von außen, damit
 * der Test nicht an der Systemuhr hängt.
 */
export function decide(
  all: Opportunity[],
  config: AlertConfig,
  state: AlertState,
  now: number,
  windowMs: number = WINDOW_MS,
): Decision {
  const { filters, settings } = config

  // Abgeschaltet: Gedächtnis leeren. Sonst bliebe nach dem Wiedereinschalten
  // alles stumm, was währenddessen schon einmal über der Schwelle lag.
  if (!settings.alertPush || settings.alertMinPercent <= 0)
    return { send: [], suppressed: 0, reason: 'aus', next: emptyState() }

  // Derselbe Filter wie auf dem Bildschirm — inklusive Sortierung nach Rendite.
  const visible = applyFilters(all, filters, settings, 'percentage-desc', windowMs)
  const over = visible.filter((o) => arbPercentOf(o) >= settings.alertMinPercent)

  // Gedächtnis aufräumen, bevor es befragt wird.
  const sent: Record<string, number> = {}
  for (const [id, t] of Object.entries(state.sent)) if (now - t < FORGET_MS) sent[id] = t
  const recent = state.recent.filter((t) => now - t < RATE_WINDOW_MS)

  if (settings.alertQuiet && inQuietHours(new Date(now), settings.quietFrom, settings.quietTo))
    // Bewusst **ohne** `sent`-Eintrag: was um acht noch steht, wird um acht
    // gemeldet. Nachgeholt wird nichts, was inzwischen weg ist.
    return { send: [], suppressed: over.length, reason: 'nachtruhe', next: { sent, recent } }

  const fresh = over.filter((o) => !(o.id in sent) || now - sent[o.id] >= COOLDOWN_MS)
  const cooling = over.length - fresh.length

  const room = Math.max(0, RATE_MAX - recent.length)
  const send = fresh.slice(0, room)
  const overflow = fresh.length - send.length

  const nextSent = { ...sent }
  for (const o of send) nextSent[o.id] = now

  return {
    send,
    suppressed: cooling + overflow,
    reason: overflow > 0 ? 'menge' : cooling > 0 && !send.length ? 'ruhezeit' : undefined,
    next: { sent: nextSent, recent: [...recent, ...send.map(() => now)] },
  }
}

/* ------------------------------------------------------------ Formulierung */

const BOOK_NAME = new Map(BOOKMAKERS.map((b) => [b.id, b.name]))
const bookName = (id: string): string => BOOK_NAME.get(id) ?? id

const de = (n: number, digits = 2): string =>
  n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/**
 * Die Meldung, wie sie auf dem Sperrbildschirm steht.
 *
 * Sie muss ohne Nachschlagen entscheidbar sein: Rendite, Partie, Markt und
 * **beide Beine mit Quote und Buchmacher**. Wer erst die App öffnen muss, um
 * zu sehen, wo er setzen soll, hat die Quote schon verloren.
 */
export function formatMessage(o: Opportunity): PushMessage {
  const percent = arbPercentOf(o)
  const start = new Date(o.startTime).toLocaleString('de-DE', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

  const legs = o.outcomes.map(
    (oc) => `${oc.label} — ${de(oc.best.odds)} @ ${bookName(oc.best.bookmakerId)}`,
  )
  const warnings = o.warnings
    .map((w) => WARNING_BY_ID[w]?.label)
    .filter(Boolean)
    .join(' · ')

  const body = [
    `${o.home} — ${o.away}`,
    `${o.sport} · ${o.market}`,
    '',
    ...legs,
    '',
    `Anpfiff ${start}`,
    warnings ? `Achtung: ${warnings}` : '',
  ]
    .filter((l) => l !== undefined)
    .join('\n')
    .trim()

  // Ein Knopf je Bein, in der Reihenfolge der Outcomes. Doppelte Buchmacher
  // fliegen raus — bei einer Dreiwegewette mit zwei Beinen beim selben
  // Anbieter wäre der zweite Knopf derselbe Link.
  const seen = new Set<string>()
  const actions: { label: string; url: string }[] = []
  for (const oc of o.outcomes) {
    const id = oc.best.bookmakerId
    const url = o.links?.[id]
    if (!url || seen.has(id)) continue
    seen.add(id)
    actions.push({ label: bookName(id), url })
  }

  return {
    title: `${de(percent)} % · ${o.sport}`,
    body,
    priority: percent >= HIGH_PERCENT ? 'high' : 'default',
    clickUrl: actions[0]?.url,
    actions,
    tags: ['money_with_wings'],
  }
}

/* ----------------------------------------------------------------- Betrieb */

/** `ScanOpportunity` des Servers → `Opportunity`, wie der Filter ihn erwartet. */
const KNOWN = new Set<string>(ALL_WARNING_IDS)

export function toOpportunity(o: ScanOpportunity): Opportunity {
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
    outcomes: o.outcomes.map((oc) => ({ label: oc.label, best: oc.best, all: oc.all })),
    warnings: o.warnings.filter((w): w is BetWarningId => KNOWN.has(w)),
    links: o.links,
  }
}

type Persisted = { config: AlertConfig | null; state: AlertState }

let config: AlertConfig | null = null
let state: AlertState = emptyState()
let loaded = false

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = readFileSync(STATE_FILE, 'utf8')
    const p = JSON.parse(raw) as Persisted
    config = p.config ?? null
    state = p.state ?? emptyState()
  } catch {
    // Erste Ausführung oder beschädigte Datei — beides ist harmlos.
  }
}

function persist(): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ config, state } satisfies Persisted, null, 2))
  } catch (e) {
    console.error('Meldezustand nicht speicherbar:', e)
  }
}

export function getAlertConfig(): AlertConfig | null {
  load()
  return config
}

export function setAlertConfig(next: AlertConfig): void {
  load()
  config = next
  persist()
}

/**
 * Der aktuell gültige Meldeweg.
 *
 * Bewusst **nicht** gemerkt: die Zugangsdaten kommen jetzt aus der Oberfläche
 * und können sich jederzeit ändern. Ein einmal aufgelöster Transport würde
 * nach dem Ändern des Themas weiter an das alte schicken — und weil dort
 * niemand zuhört, sähe das aus wie „es kommt nichts an", ohne Fehlermeldung.
 * Das Auflösen kostet nichts, es liest nur Felder.
 */
function transportNow(): PushTransport | null {
  load()
  return configuredTransport(config?.push)
}

export function pushStatus(): { ready: boolean; via: string | null; hasConfig: boolean } {
  const t = transportNow()
  return {
    ready: t !== null,
    via: t?.describe() ?? null,
    hasConfig: config !== null,
  }
}

/** Verschickt eine Probemeldung — für den Knopf in der Oberfläche. */
export async function sendTest(): Promise<void> {
  const transport = transportNow()
  if (!transport)
    throw new Error(
      'Kein Meldeweg eingerichtet — im Reiter „Telefon" einen Dienst wählen und die Zugangsdaten eintragen.',
    )
  await transport.send({
    title: 'Arbify · Probe',
    body: 'Wenn du das liest, kommen die Funde an.',
    priority: 'default',
    tags: ['white_check_mark'],
  })
}

/**
 * Nach jedem Durchlauf aufgerufen. Schluckt eigene Fehler: eine Störung beim
 * Meldedienst darf den Scanner nicht anhalten.
 */
export async function maybeNotify(opportunities: ScanOpportunity[]): Promise<void> {
  load()
  if (!config) return
  const transport = transportNow()
  if (!transport) return

  const decision = decide(opportunities.map(toOpportunity), config, state, Date.now())
  state = decision.next

  if (!decision.send.length) {
    if (decision.suppressed) persist()
    return
  }

  for (const o of decision.send) {
    try {
      await transport.send(formatMessage(o))
      console.log(
        `[Meldung] ${arbPercentOf(o).toFixed(2)} % ${o.home} — ${o.away} (${o.market}) via ${transport.id}`,
      )
    } catch (e) {
      // Fehlgeschlagen heißt: nicht als gemeldet vermerken, damit der nächste
      // Durchlauf es erneut versucht.
      delete state.sent[o.id]
      console.error('Meldung fehlgeschlagen:', e instanceof Error ? e.message : e)
    }
  }
  if (decision.suppressed)
    console.log(`[Meldung] ${decision.suppressed} weitere unterdrückt (${decision.reason})`)
  persist()
}
