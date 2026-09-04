import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * Dev-Starter: Scanner-Backend und Vite in einem Befehl.
 *
 * Vorher musste das Backend in einem zweiten Terminal laufen. Tat es das
 * nicht, lief der Vite-Proxy für /api ins Leere und das Frontend blieb auf
 * Demo-Daten hängen — begleitet von einer Wand aus ECONNREFUSED.
 *
 * Reihenfolge ist Absicht: erst das Backend, dann warten bis /api/health
 * antwortet, erst danach Vite. So sieht das Frontend beim allerersten
 * Request schon einen Server.
 */

// Bewusst nur API_PORT: PORT wird von Editoren und Startern gern auf den
// Web-Port gesetzt — als Fallback gelesen, landet das Backend auf 5173.
const API_PORT = Number(process.env.API_PORT ?? 8787)
const HEALTH_TIMEOUT_MS = 20_000

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`

const children = new Set<ChildProcess>()
let shuttingDown = false

/** Hängt jeder Zeile des Kindprozesses ein Präfix an, damit die Quelle klar ist. */
function prefix(child: ChildProcess, label: string): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    createInterface({ input: stream }).on('line', (line) => {
      console.log(`${cyan(label)} ${line}`)
    })
  }
}

function start(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  child.on('exit', (code, signal) => {
    children.delete(child)
    // Einer geht, alle gehen — ein halb laufendes Setup ist schlimmer als keins.
    if (!shuttingDown) {
      console.log(dim(`\n${command} beendet (${signal ?? code}) — fahre alles herunter.`))
      shutdown(typeof code === 'number' ? code : 1)
    }
  })
  return child
}

function shutdown(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) child.kill('SIGTERM')
  // Wer nach zwei Sekunden noch lebt, bekommt SIGKILL.
  const t = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL')
    process.exit(code)
  }, 2_000)
  t.unref()
  const done = setInterval(() => {
    if (children.size === 0) {
      clearInterval(done)
      process.exit(code)
    }
  }, 50)
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(dim('\nStoppe Scanner und Vite …'))
    shutdown(0)
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Pollt /api/health, bis das Backend antwortet oder die Geduld ausgeht. */
async function waitForBackend(): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const res = await fetch(`http://localhost:${API_PORT}/api/health`)
      if (res.ok) return true
    } catch {
      // Backend hört noch nicht — normal in den ersten Sekunden.
    }
    await sleep(250)
  }
  return false
}

const scan = start('node', ['server/index.ts'], { PORT: String(API_PORT) })
prefix(scan, '[scan]')

const ready = await waitForBackend()
if (shuttingDown) process.exit(0)
if (!ready) {
  console.log(
    dim(`[dev]  Backend antwortet nach ${HEALTH_TIMEOUT_MS / 1000} s nicht — starte Vite trotzdem.`),
  )
}

const web = start('node_modules/.bin/vite', [], { API_PORT: String(API_PORT) })
prefix(web, '[web] ')
