import type { PushConfig } from '../src/types.ts'

/**
 * Versand der Funde aufs Telefon über ntfy, Pushover oder einen Webhook
 * (docs/meldungen.md). Der Server ruft hinaus; das Telefon muss den Rechner nie
 * erreichen.
 *
 * Zugangsdaten kommen aus dem Reiter „Telefon“ (`.arbify-alerts.json`) oder
 * aus Umgebungsvariablen; die Oberfläche hat Vorrang, `describe()` nennt die
 * aktive Quelle. Das ntfy-Thema ist der einzige Schutz des Kanals.
 */

/** Wie lange auf den Meldedienst gewartet wird, bevor abgebrochen wird. */
const TIMEOUT_MS = 8_000

export type PushMessage = {
  title: string
  body: string
  /** Höhere Renditen dürfen lauter sein — sie sind schneller weg. */
  priority: 'default' | 'high'
  /** Öffnet sich beim Antippen der Meldung. */
  clickUrl?: string
  /** Ein Knopf je Buchmacher, damit beide Beine ohne Suchen erreichbar sind. */
  actions?: { label: string; url: string }[]
  tags?: string[]
}

export type PushTransport = {
  id: 'ntfy' | 'pushover' | 'webhook'
  /** Für die Oberfläche und das Startprotokoll — **ohne** das Geheimnis. */
  describe(): string
  send(m: PushMessage): Promise<void>
}

const env = (k: string): string | undefined => {
  const v = process.env[k]
  return v && v.trim() ? v.trim() : undefined
}

/** Zugangsdaten feldweise zusammenführen; leere Felder der Oberfläche fallen auf die Umgebung zurück. */
type Source = 'Oberfläche' | 'Umgebung'

function pick(
  ui: string | undefined,
  envKey: string,
): { value: string | undefined; source: Source } {
  const u = ui?.trim()
  if (u) return { value: u, source: 'Oberfläche' }
  return { value: env(envKey), source: 'Umgebung' }
}

async function post(url: string, init: RequestInit): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${res.status} ${res.statusText} ${text.slice(0, 200)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/** ntfy über die JSON-Form — Kopfzeilen tragen kein UTF-8. */
function ntfyTransport(ui?: PushConfig): PushTransport | null {
  const t = pick(ui?.ntfyTopic, 'ARBIFY_NTFY_TOPIC')
  const topic = t.value
  if (!topic) return null
  const server = pick(ui?.ntfyServer, 'ARBIFY_NTFY_SERVER').value ?? 'https://ntfy.sh'
  const token = pick(ui?.ntfyToken, 'ARBIFY_NTFY_TOKEN').value

  return {
    id: 'ntfy',
    describe: () => `ntfy · ${server} · Thema ${mask(topic)} (${t.source})`,
    async send(m) {
      await post(server, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          topic,
          title: m.title,
          message: m.body,
          priority: m.priority === 'high' ? 4 : 3,
          tags: m.tags,
          click: m.clickUrl,
          actions: m.actions?.slice(0, 3).map((a) => ({
            action: 'view',
            label: a.label,
            url: a.url,
            clear: false,
          })),
        }),
      })
    },
  }
}

/** Pushover — Formular statt JSON, so verlangt es die API. */
function pushoverTransport(ui?: PushConfig): PushTransport | null {
  const t = pick(ui?.pushoverToken, 'ARBIFY_PUSHOVER_TOKEN')
  const u = pick(ui?.pushoverUser, 'ARBIFY_PUSHOVER_USER')
  const token = t.value
  const user = u.value
  if (!token || !user) return null

  return {
    id: 'pushover',
    describe: () => `Pushover · Nutzer ${mask(user)} (${u.source})`,
    async send(m) {
      const form = new URLSearchParams({
        token,
        user,
        title: m.title,
        message: m.body,
        priority: m.priority === 'high' ? '1' : '0',
      })
      // Pushover kennt nur **einen** Link je Meldung — genommen wird der des
      // ersten Beins, weil dort die knappere Quote steht.
      if (m.clickUrl) {
        form.set('url', m.clickUrl)
        form.set('url_title', m.actions?.[0]?.label ?? 'Zum Buchmacher')
      }
      await post('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      })
    },
  }
}

/** Freier Webhook — der Ausweg für alles, was hier nicht steht. */
function webhookTransport(ui?: PushConfig): PushTransport | null {
  const w = pick(ui?.webhookUrl, 'ARBIFY_WEBHOOK_URL')
  const url = w.value
  if (!url) return null
  // Eine unbrauchbare Adresse darf den Start nicht verhindern — der Nutzer
  // tippt sie in der Oberfläche, und Tippfehler sind dort die Regel.
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  return {
    id: 'webhook',
    describe: () => `Webhook · ${host} (${w.source})`,
    async send(m) {
      await post(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(m),
      })
    },
  }
}

/** "a1b2…9f0e" — genug zum Wiedererkennen, zu wenig zum Mitlesen. */
const mask = (s: string): string =>
  s.length <= 10 ? `${s.slice(0, 2)}…` : `${s.slice(0, 4)}…${s.slice(-4)}`

/**
 * Der eingerichtete Weg oder `null`: die Wahl in der Oberfläche, sonst
 * `ARBIFY_PUSH`, sonst der erste vollständige. Immer nur einer.
 */
export function configuredTransport(ui?: PushConfig): PushTransport | null {
  // Ausdrücklich abgeschaltet — auch dann, wenn Umgebungsvariablen gesetzt
  // sind. Der Schalter in der Oberfläche muss verlässlich stumm stellen.
  if (ui?.service === 'off') return null

  const byId = {
    ntfy: () => ntfyTransport(ui),
    pushover: () => pushoverTransport(ui),
    webhook: () => webhookTransport(ui),
  }

  if (ui?.service && ui.service in byId) return byId[ui.service]()

  const want = env('ARBIFY_PUSH')
  const all = [ntfyTransport(ui), pushoverTransport(ui), webhookTransport(ui)].filter(
    (t): t is PushTransport => t !== null,
  )
  if (want) return all.find((t) => t.id === want) ?? null
  return all[0] ?? null
}
