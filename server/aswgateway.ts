import { deflateRawSync, inflateRawSync } from 'node:zlib'
import WebSocket from 'ws'

export type AswOptions = {
  url: string
  origin: string
  mandatorName: string
  configurationNodeUrn: string
  languageCode?: string
  currencyCode?: string
  timeZone?: string
  timeoutMs?: number
  settleMs?: number
  maxStoreSize?: number
}

export type SnapshotItem = { kind?: number; type: string; entity?: { urn?: string } & Record<string, any> }

type Pending = {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  settle?: ReturnType<typeof setTimeout>
  response?: any
}

const SERVICE = 'sportsbook'

export class AswGateway {
  private opts: Required<AswOptions>
  private socket: WebSocket | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<string, Pending>()
  private counter = 0

  readonly store = new Map<string, SnapshotItem>()

  constructor(opts: AswOptions) {
    this.opts = {
      languageCode: 'de',
      currencyCode: 'EUR',
      timeZone: 'Europe/Berlin',
      timeoutMs: 25_000,
      settleMs: 700,
      maxStoreSize: 200_000,
      ...opts,
    }
  }

  entity<T = any>(urn: string | undefined): T | undefined {
    return urn ? (this.store.get(urn)?.entity as T | undefined) : undefined
  }

  private send(socket: WebSocket, msg: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(deflateRawSync(Buffer.from(JSON.stringify(msg), 'utf8')))
  }

  private command(socket: WebSocket, cmd: unknown): void {
    this.send(socket, { payload: [cmd], properties: { type: 'binary', service: SERVICE } })
  }

  private connect(): Promise<void> {
    if (this.ready) return this.ready

    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (reason: string) => {
        if (settled) return
        settled = true
        this.teardown(new Error(reason))
        reject(new Error(reason))
      }
      const timer = setTimeout(() => fail(`ASW: Handschlag zu ${this.opts.url} überschritten`), this.opts.timeoutMs)

      let socket: WebSocket
      try {
        socket = new WebSocket(this.opts.url, { headers: { Origin: this.opts.origin } })
      } catch (e) {
        clearTimeout(timer)
        return fail(e instanceof Error ? e.message : String(e))
      }
      this.socket = socket

      socket.on('open', () => {
        ;(socket as any)._socket?.unref?.()
        this.send(socket, {
          connect: { headers: { token: '' } },
          properties: { type: 'binary', service: SERVICE },
        })
      })

      socket.on('message', (data: Buffer) => {
        let msg: any
        try {
          msg = JSON.parse(inflateRawSync(data).toString('utf8'))
        } catch {
          return
        }
        if (msg.pong) return
        if (msg.closed) return fail('ASW: Gegenstelle hat geschlossen')

        if (msg.connected) {
          this.command(socket, {
            type: 'ConfigureEnvironment',
            name: 'ConfigureEnvironment',
            body: {
              timeZone: this.opts.timeZone,
              languageCode: this.opts.languageCode,
              currencyCode: this.opts.currencyCode,
              mandatorName: this.opts.mandatorName,
              configurationNodeUrn: this.opts.configurationNodeUrn,
            },
            requestId: `env-${++this.counter}`,
          })
          return
        }

        if (typeof msg.payload === 'string') {
          try {
            msg.payload = JSON.parse(msg.payload)
          } catch {
            return
          }
        }
        for (const p of Array.isArray(msg.payload) ? msg.payload : []) this.absorb(p, () => {
          clearTimeout(timer)
          settled = true
          resolve()
        })
      })

      socket.on('error', (e: Error) => fail(`ASW: Verbindungsfehler — ${e.message}`))
      socket.on('close', () => {
        this.teardown(new Error('ASW: Verbindung geschlossen'))
        if (!settled) fail('ASW: Verbindung vor dem Handschlag geschlossen')
      })
    })

    return this.ready
  }

  private absorb(p: any, onConfigured: () => void): void {
    for (const item of p?.body?.snapshotUpdate?.snapshotUpdateItems ?? []) {
      const urn = item?.entity?.urn
      if (!urn) continue
      this.store.delete(urn)
      this.store.set(urn, item)
    }
    if (this.store.size > this.opts.maxStoreSize) {
      const drop = this.store.size - this.opts.maxStoreSize
      let i = 0
      for (const key of this.store.keys()) {
        if (i++ >= drop) break
        this.store.delete(key)
      }
    }

    if (p?.type === 'EnvironmentConfigured') return onConfigured()

    const id = p?.requestId
    if (!id) return
    const entry = this.pending.get(id)
    if (!entry) return
    entry.response = p
    if (entry.settle) clearTimeout(entry.settle)
    entry.settle = setTimeout(() => {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.resolve(entry.response)
    }, this.opts.settleMs)
  }

  private teardown(reason: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      if (p.settle) clearTimeout(p.settle)
      p.reject(reason)
    }
    this.pending.clear()
    this.ready = null
    if (this.socket) {
      try {
        this.socket.removeAllListeners()
        this.socket.close()
      } catch {
        /* egal */
      }
      this.socket = null
    }
  }

  async request<T = any>(type: string, body: Record<string, unknown>): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('ASW: Verbindung nicht offen')

    const requestId = `r${++this.counter}`
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        timer: setTimeout(() => {
          const entry = this.pending.get(requestId)
          this.pending.delete(requestId)
          if (entry?.settle) clearTimeout(entry.settle)
          if (entry?.response) resolve(entry.response)
          else reject(new Error(`ASW: keine Antwort auf ${type}`))
        }, this.opts.timeoutMs),
      })
      try {
        this.command(socket, { type, name: `q/${type}`, body, requestId })
      } catch (e) {
        this.pending.delete(requestId)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  close(): void {
    this.teardown(new Error('ASW: vom Aufrufer geschlossen'))
  }
}
