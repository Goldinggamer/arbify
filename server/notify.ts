import type { PushConfig } from '../src/types.ts'

/**
 * Versand der Funde aufs Telefon.
 *
 * Der Scanner läuft auf dem Rechner, der Nutzer nicht. Eine Arbitrage lebt
 * Minuten — wer sie erst abends auf dem Bildschirm sieht, hat sie verpasst.
 * Ton und Systemmeldung im Browser lösen das nicht: beide brauchen den offenen
 * Tab.
 *
 * ## Warum kein Web Push
 *
 * iOS kann seit 16.4 echte Web-Benachrichtigungen — aber nur für Seiten, die
 * über **gültiges HTTPS** ausgeliefert und zum Home-Bildschirm hinzugefügt
 * wurden. Für einen Scanner, der auf `localhost` im eigenen Netz läuft, hieße
 * das: Domain, Zertifikat, Service-Worker, VAPID-Schlüssel. Viel Aufbau für
 * eine Meldung.
 *
 * Der Weg hier ist umgekehrt und deshalb einfach: **der Server ruft hinaus.**
 * Das Telefon muss den Rechner nie erreichen, es hängt an einem
 * Meldedienst, der die Verbindung offen hält. Kein Portfreigabe, kein
 * dynamisches DNS, kein Zertifikat.
 *
 * ## Die drei Wege
 *
 *   ntfy      quelloffen, kostenlos, kein Konto. Das "Thema" ist der einzige
 *             Schutz — wer es kennt, liest mit. Deshalb muss es eine lange
 *             Zufallszeichenkette sein, kein Wort. Später selbst hostbar.
 *   Pushover  5 $ einmalig, sehr zuverlässig, echtes Konto.
 *   Webhook   alles andere: eigener Dienst, Home Assistant, Shortcuts.
 *
 * ## Woher die Zugangsdaten kommen
 *
 * Zwei Wege, und der aus der Oberfläche hat Vorrang:
 *
 *   1. **Reiter „Telefon"** — im Browser eingetragen, vom Server in
 *      `.arbify-alerts.json` abgelegt. Der normale Weg: einmal eintippen,
 *      danach steht es über Neustarts hinweg.
 *   2. **Umgebungsvariablen** — für Läufe ohne Oberfläche, etwa als Dienst
 *      im Hintergrund.
 *
 * Der Vorrang liegt bei der Oberfläche, weil dort die letzte bewusste
 * Handlung stattfand. Damit das nicht heimlich passiert, meldet
 * `describe()` mit, aus welcher Quelle die Angaben stammen — sonst schickt
 * ein vergessenes `ARBIFY_NTFY_TOPIC` die Funde stillschweigend an ein
 * altes Thema.
 *
 * Das Thema selbst gehört **weder in die Dokumentation noch ins
 * Repository**: es ist bei ntfy der einzige Schutz des Kanals.
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

/**
 * Zugangsdaten aus Oberfläche und Umgebung zusammenführen.
 *
 * Feldweise, nicht als Ganzes: wer den ntfy-Server über eine Variable setzt
 * und das Thema in der Oberfläche einträgt, bekommt beides. Leere Felder aus
 * der Oberfläche zählen als „nicht gesetzt" und fallen auf die Umgebung
 * zurück.
 */
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

/**
 * ntfy.
 *
 * Veröffentlicht wird über die **JSON-Form**, nicht über Kopfzeilen. Der Grund
 * ist Text: HTTP-Kopfzeilen tragen kein UTF-8, und ein Titel wie
 * "4,8 % · Bayern München" wäre darin entweder zerstört oder müsste umständlich
 * kodiert werden. Im JSON-Rumpf ist das kein Thema.
 */
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
 * Der eingerichtete Weg, oder `null`.
 *
 * `ui.service` entscheidet, wenn die Oberfläche einen Dienst gewählt hat —
 * das ist die ausdrückliche Wahl des Nutzers und schlägt alles andere.
 * Sonst greift `ARBIFY_PUSH`, sonst der erste vollständig konfigurierte.
 *
 * Immer nur **einer**: doppelte Meldungen auf demselben Telefon sind
 * schlimmer als gar keine.
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
