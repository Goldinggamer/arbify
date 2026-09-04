import WebSocket from 'ws'

/**
 * Zweite Transportschicht: JSON-RPC über WebSocket.
 *
 * Mehrere Anbieter liefern ihre Quoten grundsätzlich nicht über HTTP-Abrufe,
 * sondern nur über eine dauerhafte Verbindung — BetConstruct über ein eigenes
 * "swarm"-Protokoll, andere über SignalR. Der Rest des Systems soll davon
 * nichts merken: ein Adapter fragt an, bekommt JSON zurück, fertig.
 *
 * Bewusst die `ws`-Bibliothek statt Nodes eingebautem WebSocket. Zwei Gründe,
 * beide praktisch erzwungen:
 *   - **Header.** SignalR-Hubs prüfen `Origin`; der eingebaute Client kann
 *     keine setzen und wird abgewiesen.
 *   - **`unref`.** Eine offene Verbindung hält den Node-Prozess sonst am
 *     Leben, und einmalige Skripte wie `npm run scan:once` beenden sich nie.
 *
 * Was diese Klasse übernimmt:
 *   - Verbindung offen halten (ein Handshake kostet rund eine Sekunde; bei
 *     vier Sekunden Refresh-Takt wäre Auf- und Abbau reine Verschwendung)
 *   - Antworten zuordnen (über die Leitung laufen Antworten und
 *     unaufgeforderte Aktualisierungen gemischt ein — jede Anfrage bekommt
 *     eine `rid`)
 *   - Ausfälle überstehen (bricht die Verbindung ab, wird beim nächsten
 *     Aufruf neu verbunden; offene Anfragen laufen in ihren Timeout statt zu
 *     hängen)
 */

export type RpcOptions = {
  url: string
  /** Zusätzliche Header für den Verbindungsaufbau, z.B. `Origin`. */
  headers?: Record<string, string>
  /**
   * Wird nach dem Verbindungsaufbau gesendet. Die Verbindung gilt erst als
   * bereit, wenn die Antwort darauf da ist.
   */
  handshake?: () => unknown
  /** Prüft, ob die Handshake-Antwort erfolgreich war. */
  handshakeOk?: (msg: any) => boolean
  /**
   * Manche Protokolle (SignalR) rahmen Nachrichten mit einem Trennzeichen.
   * Ist es gesetzt, wird beim Senden angehängt und beim Empfang gesplittet.
   */
  separator?: string
  /**
   * Wie die `rid` einer eingehenden Nachricht heißt. SignalR nutzt
   * `invocationId`, BetConstruct `rid`.
   */
  ridField?: string
  timeoutMs?: number
  /** Server-initiierte Nachrichten ohne `rid` — z.B. Push-Aktualisierungen. */
  onPush?: (msg: any) => void
}

type Pending = {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RpcSocket {
  private opts: RpcOptions & { timeoutMs: number; ridField: string }
  private socket: WebSocket | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<string, Pending>()
  private counter = 0

  constructor(opts: RpcOptions) {
    this.opts = { timeoutMs: 15_000, ridField: 'rid', ...opts }
  }

  private frame(payload: object): string {
    return JSON.stringify(payload) + (this.opts.separator ?? '')
  }

  private connect(): Promise<void> {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return this.ready

    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (reason: string) => {
        if (settled) return
        settled = true
        this.teardown(new Error(reason))
        reject(new Error(reason))
      }

      const timer = setTimeout(
        () => fail(`Verbindungsaufbau zu ${this.opts.url} überschritten`),
        this.opts.timeoutMs,
      )

      let socket: WebSocket
      try {
        socket = new WebSocket(this.opts.url, { headers: this.opts.headers })
      } catch (e) {
        clearTimeout(timer)
        return fail(e instanceof Error ? e.message : String(e))
      }
      this.socket = socket

      socket.on('open', () => {
        // Die offene Verbindung darf den Prozess nicht am Leben halten.
        ;(socket as any)._socket?.unref?.()

        if (!this.opts.handshake) {
          clearTimeout(timer)
          settled = true
          return resolve()
        }
        const rid = this.nextRid()
        this.pending.set(rid, {
          resolve: (msg) => {
            clearTimeout(timer)
            if (this.opts.handshakeOk && !this.opts.handshakeOk(msg)) return fail('Handshake abgelehnt')
            settled = true
            resolve()
          },
          reject: () => fail('Handshake fehlgeschlagen'),
          timer: setTimeout(() => fail('Handshake überschritten'), this.opts.timeoutMs),
        })
        socket.send(this.frame({ ...(this.opts.handshake() as object), [this.opts.ridField]: rid }))
      })

      socket.on('message', (data: unknown) => this.dispatch(String(data)))
      socket.on('error', (e: Error) => fail(`Verbindungsfehler zu ${this.opts.url}: ${e.message}`))
      socket.on('close', () => {
        this.teardown(new Error('Verbindung geschlossen'))
        if (!settled) fail('Verbindung vor dem Handshake geschlossen')
      })
    })

    return this.ready
  }

  private dispatch(raw: string): void {
    const parts = this.opts.separator ? raw.split(this.opts.separator).filter(Boolean) : [raw]
    for (const part of parts) {
      let msg: any
      try {
        msg = JSON.parse(part)
      } catch {
        continue
      }
      const ridRaw = msg?.[this.opts.ridField]
      if (ridRaw == null) {
        this.opts.onPush?.(msg)
        continue
      }
      const entry = this.pending.get(String(ridRaw))
      if (!entry) {
        this.opts.onPush?.(msg)
        continue
      }
      this.pending.delete(String(ridRaw))
      clearTimeout(entry.timer)
      entry.resolve(msg)
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

  private nextRid(): string {
    return String(++this.counter)
  }

  /** Sendet eine Anfrage und wartet auf die Antwort mit derselben `rid`. */
  async request<T = any>(payload: object): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Verbindung nicht offen')

    const rid = this.nextRid()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(rid, {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(rid)
          reject(new Error(`Antwort auf ${this.opts.ridField} ${rid} überschritten`))
        }, this.opts.timeoutMs),
      })
      try {
        socket.send(this.frame({ ...payload, [this.opts.ridField]: rid }))
      } catch (e) {
        this.pending.delete(rid)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /**
   * Feuert eine Nachricht ab, ohne auf eine Antwort zu warten — für
   * Abonnements, deren Daten später als Push eintreffen.
   */
  async notify(payload: object): Promise<void> {
    await this.connect()
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Verbindung nicht offen')
    this.socket.send(this.frame(payload))
  }

  close(): void {
    this.teardown(new Error('Vom Aufrufer geschlossen'))
  }
}
