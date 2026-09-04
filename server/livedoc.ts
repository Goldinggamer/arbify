import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import WebSocket from 'ws'

/**
 * Dritte Transportschicht: OpenBets „LiveDoc".
 *
 * Warum eine eigene Schicht neben `RpcSocket`: LiveDoc ist kein JSON-RPC. Es
 * sind **drei** gestapelte Protokolle, und jedes davon bringt eine Eigenheit
 * mit, die der bestehende Sockel nicht kennt.
 *
 *   1. **SockJS** rahmt den WebSocket. Die Adresse trägt eine erfundene
 *      Server- und Sitzungskennung (`/{3 Ziffern}/{8 Zeichen}/websocket`),
 *      und jede Nachricht ist ein Buchstabe plus Nutzlast:
 *        `o` offen · `h` Herzschlag · `a[…]` Nachrichten · `c[…]` geschlossen
 *      Gesendet wird ein JSON-Array von Strings.
 *   2. **STOMP** darüber. Ein Dokument wird nicht angefragt, sondern
 *      *abonniert*: `SUBSCRIBE` auf eine Zieladresse wie `eventmap/upcomingFBL`,
 *      Parameter reisen als Kopfzeilen (`X-Lang`, `X-Size`, `X-Sort`, …).
 *   3. **JSON-Patch** als Nutzlast. Die erste Nachricht ist der volle Stand
 *      (`[{op:"add",path:"",value:{…}}]`), alle weiteren sind Deltas darauf.
 *      Große Dokumente kommen base64-kodiert und roh-deflate-gepackt, erkennbar
 *      am Kopf `is-compressed: true`.
 *
 * Diese Klasse holt **Momentaufnahmen**: abonnieren, ersten Stand abwarten,
 * wieder abbestellen. Für einen Arbitrage-Scanner ist das die richtige Form —
 * der Scheduler fragt ohnehin in festem Takt neu, und ein Dauerabo über
 * hunderte Partien wäre nur Buchhaltung ohne Gewinn. Die *Verbindung* bleibt
 * dabei offen; teuer ist der Handschlag, nicht das Abo.
 */

export type LiveDocOptions = {
  /** Host ohne Schema, z.B. `sb-pp-defe.daznbet.de`. */
  host: string
  /** Dienstpfad, z.B. `/eventmaplivedocl1/livedoc`. */
  service: string
  timeoutMs?: number
}

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const CHARS_DIGIT = '0123456789'
const CHARS_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'

const rnd = (n: number, chars: string): string =>
  Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('')

/** STOMP-Rahmen: `KOMMANDO\nkopf:wert\n\nrumpf\0` */
function frame(command: string, headers: Record<string, string | number | boolean>, body = ''): string {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}:${v}`)
    .join('\n')
  return `${command}\n${head}\n\n${body}\0`
}

type StompFrame = { command: string; headers: Record<string, string>; body: string }

function parseFrame(raw: string): StompFrame {
  const nul = raw.indexOf('\0')
  const text = nul === -1 ? raw : raw.slice(0, nul)
  const split = text.indexOf('\n\n')
  const head = split === -1 ? text : text.slice(0, split)
  const body = split === -1 ? '' : text.slice(split + 2)
  const lines = head.split('\n')
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1)
  }
  return { command: lines[0] ?? '', headers, body }
}

/**
 * Gepackte Rümpfe auspacken.
 *
 * Der Kopf sagt nur *dass* gepackt wurde, nicht womit. Gemessen ist es roher
 * Deflate ohne zlib-Rahmen; die beiden anderen Varianten bleiben als
 * Rückfallebene stehen, falls der Server das einmal ändert.
 */
function decodeBody(headers: Record<string, string>, body: string): string {
  if (headers['is-compressed'] !== 'true') return body
  const buf = Buffer.from(body, 'base64')
  for (const fn of [inflateRawSync, inflateSync, gunzipSync]) {
    try {
      return fn(buf).toString('utf8')
    } catch {
      // nächste Variante versuchen
    }
  }
  throw new Error('LiveDoc: gepackter Rumpf lässt sich nicht entpacken')
}

type PatchOp = { op: string; path: string; value?: unknown }

/**
 * Minimaler JSON-Patch, nur soweit für den ersten Stand nötig.
 *
 * In aller Regel ist die erste Nachricht eine einzige Anweisung
 * `{op:"add", path:"", value:{…}}` — also schlicht das ganze Dokument. Der
 * Rest ist Absicherung für den Fall, dass ein Server den Anfangsstand doch
 * einmal stückelt. Bewusst **kein** vollständiges RFC 6902: `move`, `copy`
 * und `test` kommen im Anfangsstand nicht vor, und eine halbgare
 * Implementierung davon wäre gefährlicher als gar keine.
 */
function applyPatch(doc: unknown, ops: PatchOp[]): unknown {
  let result = doc
  for (const op of ops) {
    if (op.path === '') {
      if (op.op === 'add' || op.op === 'replace') result = op.value
      continue
    }
    const parts = op.path
      .split('/')
      .slice(1)
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    let node: any = result
    for (const key of parts.slice(0, -1)) {
      if (node == null || typeof node !== 'object') break
      node = node[key]
    }
    const last = parts[parts.length - 1]
    if (node == null || typeof node !== 'object' || last === undefined) continue
    if (op.op === 'remove') delete node[last]
    else node[last] = op.value
  }
  return result
}

export class LiveDocClient {
  private opts: Required<LiveDocOptions>
  private socket: WebSocket | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<string, Pending>()
  private counter = 0

  constructor(opts: LiveDocOptions) {
    this.opts = { timeoutMs: 20_000, ...opts }
  }

  private url(): string {
    return `wss://${this.opts.host}${this.opts.service}/${rnd(3, CHARS_DIGIT)}/${rnd(8, CHARS_ALNUM)}/websocket`
  }

  /**
   * Eine SockJS-Nachricht ist ein JSON-Array von Strings.
   *
   * Der Socket wird ausdrücklich übergeben statt über `this.socket` geholt:
   * während eines Neuaufbaus zeigt das Feld sonst schon auf die neue
   * Verbindung, und der Handschlag der alten liefe ins Leere.
   */
  private send(socket: WebSocket, payload: string): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify([payload]))
  }

  private connect(): Promise<void> {
    // Nur auf `ready` prüfen, nicht auf den Socket-Zustand: während des
    // Aufbaus steht der noch auf CONNECTING. Fragte man hier den Zustand ab,
    // würde jeder gleichzeitige Aufruf eine **weitere** Verbindung öffnen und
    // die vorige überschreiben. `teardown` setzt `ready` zurück, ein Ausfall
    // führt also weiterhin zum Neuaufbau.
    if (this.ready) return this.ready

    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (reason: string) => {
        if (settled) return
        settled = true
        this.teardown(new Error(reason))
        reject(new Error(reason))
      }

      const timer = setTimeout(() => fail(`LiveDoc: Handschlag zu ${this.opts.host} überschritten`), this.opts.timeoutMs)

      let socket: WebSocket
      try {
        socket = new WebSocket(this.url(), { headers: { Origin: `https://${this.opts.host}` } })
      } catch (e) {
        clearTimeout(timer)
        return fail(e instanceof Error ? e.message : String(e))
      }
      this.socket = socket

      socket.on('open', () => {
        // Eine offene Verbindung darf `npm run scan:once` nicht am Beenden hindern.
        ;(socket as any)._socket?.unref?.()
      })

      socket.on('message', (data: unknown) => {
        const raw = String(data)
        switch (raw[0]) {
          case 'o':
            // SockJS ist offen — jetzt STOMP anmelden.
            this.send(socket, frame('CONNECT', { 'accept-version': '1.1,1.0', 'heart-beat': '0,0' }))
            return
          case 'h':
            return
          case 'c':
            return fail(`LiveDoc: Gegenstelle hat geschlossen (${raw.slice(1)})`)
          case 'a':
            break
          default:
            return
        }

        let frames: string[]
        try {
          frames = JSON.parse(raw.slice(1))
        } catch {
          return
        }
        for (const f of frames) {
          const parsed = parseFrame(f)
          if (parsed.command === 'CONNECTED') {
            clearTimeout(timer)
            settled = true
            resolve()
            continue
          }
          this.dispatch(parsed)
        }
      })

      socket.on('error', (e: Error) => fail(`LiveDoc: Verbindungsfehler — ${e.message}`))
      socket.on('close', () => {
        this.teardown(new Error('LiveDoc: Verbindung geschlossen'))
        if (!settled) fail('LiveDoc: Verbindung vor dem Handschlag geschlossen')
      })
    })

    return this.ready
  }

  private dispatch(f: StompFrame): void {
    if (f.command === 'ERROR') {
      // Ein STOMP-Fehler trägt keine Abo-Kennung — er beendet alles Offene.
      this.teardown(new Error(`LiveDoc: ${f.headers.message ?? 'Fehler'} ${f.body.slice(0, 120)}`.trim()))
      return
    }
    if (f.command !== 'MESSAGE') return

    const id = f.headers.subscription
    const entry = id ? this.pending.get(id) : undefined
    if (!entry || !id) return
    this.pending.delete(id)
    clearTimeout(entry.timer)

    try {
      const text = decodeBody(f.headers, f.body)
      const parsed = JSON.parse(text)
      entry.resolve(Array.isArray(parsed) ? applyPatch({}, parsed as PatchOp[]) : parsed)
    } catch (e) {
      entry.reject(e instanceof Error ? e : new Error(String(e)))
    }
  }

  private teardown(reason: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(reason)
    }
    this.pending.clear()
    this.ready = null
    if (this.socket) {
      try {
        this.socket.removeAllListeners()
        this.socket.close()
      } catch {
        // Beim Aufräumen ist ein Fehler ohne Folgen.
      }
      this.socket = null
    }
  }

  /**
   * Abonniert ein Dokument, gibt den ersten vollständigen Stand zurück und
   * bestellt wieder ab.
   */
  async document<T = unknown>(
    destination: string,
    headers: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('LiveDoc: Verbindung nicht offen')

    const id = `sub-${++this.counter}`
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => {
          this.unsubscribe(socket, id)
          resolve(v as T)
        },
        reject: (e) => {
          this.unsubscribe(socket, id)
          reject(e)
        },
        timer: setTimeout(() => {
          this.pending.delete(id)
          this.unsubscribe(socket, id)
          reject(new Error(`LiveDoc: keine Antwort auf ${destination}`))
        }, this.opts.timeoutMs),
      })
      try {
        this.send(socket, frame('SUBSCRIBE', { id, destination, ...headers }))
      } catch (e) {
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  private unsubscribe(socket: WebSocket, id: string): void {
    try {
      this.send(socket, frame('UNSUBSCRIBE', { id }))
    } catch {
      // Abbestellen ist Höflichkeit, kein Muss.
    }
  }

  close(): void {
    this.teardown(new Error('LiveDoc: vom Aufrufer geschlossen'))
  }
}
