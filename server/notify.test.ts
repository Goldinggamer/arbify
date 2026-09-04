import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { configuredTransport } from './notify.ts'
import { EMPTY_PUSH_CONFIG } from '../src/types.ts'
import type { PushConfig } from '../src/types.ts'

/**
 * Welcher Weg gewinnt, wenn Oberfläche und Umgebung beide etwas sagen?
 *
 * Das ist die Sorte Regel, deren Fehler niemand bemerkt: die Meldungen gehen
 * an ein anderes Thema, dort hört niemand zu, und es sieht aus wie „es kommt
 * nichts an" — ohne Fehlermeldung, ohne Protokolleintrag.
 */

const ENV_KEYS = [
  'ARBIFY_PUSH',
  'ARBIFY_NTFY_TOPIC',
  'ARBIFY_NTFY_SERVER',
  'ARBIFY_NTFY_TOKEN',
  'ARBIFY_PUSHOVER_TOKEN',
  'ARBIFY_PUSHOVER_USER',
  'ARBIFY_WEBHOOK_URL',
]

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

const cfg = (over: Partial<PushConfig>): PushConfig => ({ ...EMPTY_PUSH_CONFIG, ...over })

test('ohne alles ist nichts eingerichtet', () => {
  assert.equal(configuredTransport(), null)
  assert.equal(configuredTransport(EMPTY_PUSH_CONFIG), null)
})

test('das Thema aus der Oberfläche genügt', () => {
  const t = configuredTransport(cfg({ service: 'ntfy', ntfyTopic: 'abcdef0123456789' }))
  assert.equal(t?.id, 'ntfy')
  assert.match(t!.describe(), /ntfy · https:\/\/ntfy\.sh/)
})

test('das Thema wird nie im Klartext beschrieben', () => {
  const topic = 'abcdef0123456789'
  const d = configuredTransport(cfg({ service: 'ntfy', ntfyTopic: topic }))!.describe()
  assert.ok(!d.includes(topic), 'sonst landet das Geheimnis im Startprotokoll')
  assert.match(d, /abcd…6789/)
})

test('die Oberfläche schlägt die Umgebungsvariable', () => {
  process.env.ARBIFY_NTFY_TOPIC = 'alt-aus-der-umgebung'
  const t = configuredTransport(cfg({ service: 'ntfy', ntfyTopic: 'neu-aus-der-oberflaeche' }))
  assert.match(t!.describe(), /\(Oberfläche\)/)
})

test('ohne Eintrag in der Oberfläche greift die Umgebung', () => {
  process.env.ARBIFY_NTFY_TOPIC = 'nur-aus-der-umgebung'
  const t = configuredTransport(cfg({ service: 'ntfy' }))
  assert.equal(t?.id, 'ntfy')
  assert.match(t!.describe(), /\(Umgebung\)/)
})

test('die Quelle wird jedes Mal genannt', () => {
  // Ohne diese Angabe schickt ein vergessenes ARBIFY_NTFY_TOPIC die Funde
  // still an ein altes Thema, und der Nutzer sucht den Fehler in der App.
  process.env.ARBIFY_NTFY_TOPIC = 'x'.repeat(20)
  assert.match(configuredTransport()!.describe(), /\((Oberfläche|Umgebung)\)/)
})

test('Felder mischen sich einzeln', () => {
  // Server aus der Umgebung, Thema aus der Oberfläche — beides muss ankommen.
  process.env.ARBIFY_NTFY_SERVER = 'https://ntfy.example.org'
  const t = configuredTransport(cfg({ service: 'ntfy', ntfyTopic: 'abcdef0123456789' }))
  assert.match(t!.describe(), /https:\/\/ntfy\.example\.org/)
})

test('„aus" stellt stumm, auch gegen gesetzte Umgebungsvariablen', () => {
  // Der Schalter in der Oberfläche muss verlässlich schweigen lassen —
  // sonst meldet der Scanner weiter, obwohl der Nutzer ihn abgestellt hat.
  process.env.ARBIFY_NTFY_TOPIC = 'egal'
  assert.equal(configuredTransport(cfg({ service: 'off' })), null)
})

test('der gewählte Dienst entscheidet, nicht die Reihenfolge', () => {
  const t = configuredTransport(
    cfg({
      service: 'webhook',
      ntfyTopic: 'auch-gesetzt',
      webhookUrl: 'https://hooks.example.org/abc',
    }),
  )
  assert.equal(t?.id, 'webhook')
  assert.match(t!.describe(), /hooks\.example\.org/)
})

test('ein gewählter Dienst ohne Zugangsdaten bleibt leer', () => {
  // Nicht etwa auf einen anderen ausweichen: der Nutzer hat ntfy gewählt und
  // erwartet ntfy. Ein stiller Wechsel wäre die schlechteste Überraschung.
  process.env.ARBIFY_WEBHOOK_URL = 'https://hooks.example.org/abc'
  assert.equal(configuredTransport(cfg({ service: 'ntfy' })), null)
})

test('eine unbrauchbare Webhook-Adresse fällt weich', () => {
  // In der Oberfläche wird getippt, und beim Tippen entsteht „http:/kaputt".
  // Das darf keine Ausnahme werfen, sonst reißt es den Scan-Durchlauf ab.
  assert.doesNotThrow(() => configuredTransport(cfg({ service: 'webhook', webhookUrl: 'kaputt' })))
  assert.equal(configuredTransport(cfg({ service: 'webhook', webhookUrl: 'kaputt' })), null)
})

test('Pushover braucht beide Angaben', () => {
  assert.equal(configuredTransport(cfg({ service: 'pushover', pushoverUser: 'u'.repeat(30) })), null)
  const t = configuredTransport(
    cfg({ service: 'pushover', pushoverUser: 'u'.repeat(30), pushoverToken: 't'.repeat(30) }),
  )
  assert.equal(t?.id, 'pushover')
})
