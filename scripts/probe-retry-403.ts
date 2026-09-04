import { createServer } from 'node:http'
import { fetchText, HttpError } from '../server/http.ts'

/**
 * Fehlereinspeisung für die 403-Wiederholung in `fetchText`.
 *
 * Die echten 403 der Edges sind zu selten, um sie auf Kommando zu erzeugen —
 * also liefert ein lokaler Server sie kontrolliert.
 */

let plan: number[] = []
let hits = 0

const server = createServer((req, res) => {
  const status = plan[hits] ?? 200
  hits++
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(status === 200 ? 'ok' : `blocked ${status}`)
})

await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as { port: number }).port
const url = () => `http://127.0.0.1:${port}/x?n=${Math.random()}`

let failures = 0
function check(name: string, cond: boolean, detail: string) {
  console.log(`${cond ? 'PASS' : 'FEHLER'}  ${name.padEnd(46)} ${detail}`)
  if (!cond) failures++
}

async function run(name: string, statuses: number[], opts: Parameters<typeof fetchText>[1], expect: {
  body?: string
  status?: number
  attempts: number
  minMs?: number
  maxMs?: number
}) {
  plan = statuses
  hits = 0
  const t0 = Date.now()
  let body: string | null = null
  let status: number | null = null
  try {
    body = await fetchText(url(), { minIntervalMs: 0, ...opts })
  } catch (e) {
    status = e instanceof HttpError ? e.status : -1
  }
  const ms = Date.now() - t0
  const ok =
    hits === expect.attempts &&
    (expect.body === undefined || body === expect.body) &&
    (expect.status === undefined || status === expect.status) &&
    (expect.minMs === undefined || ms >= expect.minMs) &&
    (expect.maxMs === undefined || ms <= expect.maxMs)
  check(name, ok, `Versuche=${hits} (erwartet ${expect.attempts})  ${ms}ms  ${body ?? `HTTP ${status}`}`)
}

// 403 einmal, dann 200 — genau der beobachtete Fall: muss durchgehen.
await run('403 einmal, dann 200 -> Erfolg', [403], {}, { body: 'ok', attempts: 2, minMs: 1_200 })

// 403 zweimal, dann 200 — noch innerhalb der Wiederholungen.
await run('403 zweimal, dann 200 -> Erfolg', [403, 403], {}, { body: 'ok', attempts: 3, minMs: 3_600 })

// Eine Sperre von ~4 s (der gemessene Fall) muss überdauert werden.
await run('403 dreimal, dann 200 -> Erfolg', [403, 403, 403], {}, { body: 'ok', attempts: 4, minMs: 8_400 })

// Dauerhaft 403 — das größere Budget greift: fünf Versuche, dann Fehler.
// Der gedeckelte Backoff hält das Ganze unter 20 s, damit ein Adapter nicht
// beliebig lange hängt (ohne Deckel wären es 1,2+2,4+4,8+9,6 s).
await run(
  '403 dauerhaft -> Fehler nach 5 Versuchen, <20 s',
  Array(9).fill(403),
  {},
  { status: 403, attempts: 5, maxMs: 20_000 },
)

// Abschaltbar: wer 403 wörtlich nimmt, wartet nicht.
await run(
  '403 mit retryOn403:false -> sofort Fehler',
  [403, 403],
  { retryOn403: false },
  { status: 403, attempts: 1, maxMs: 500 },
)

// Unverändert: 404 ist unser Fehler und wird nicht wiederholt.
await run('404 -> sofort Fehler, kein Retry', [404, 404], {}, { status: 404, attempts: 1, maxMs: 500 })

// Nach einer durchgehenden Sperre gilt der Host als sperrend: der nächste
// Request wartet nicht mehr, und eine gute Antwort hebt die Markierung auf.
await run('nach Dauersperre: 403 sofort Fehler', [403], {}, { status: 403, attempts: 1, maxMs: 500 })
await run('nach Dauersperre: 200 geht weiter durch', [], {}, { body: 'ok', attempts: 1, maxMs: 500 })
await run('nach Erholung: 403 wird wieder wiederholt', [403], {}, { body: 'ok', attempts: 2, minMs: 1_200 })

// Unverändert: 429 und 5xx werden weiter wiederholt.
await run('429 einmal, dann 200 -> Erfolg', [429], {}, { body: 'ok', attempts: 2, minMs: 1_200 })
await run('500 einmal, dann 200 -> Erfolg', [500], {}, { body: 'ok', attempts: 2, minMs: 400, maxMs: 1_200 })

server.close()
console.log(failures ? `\n${failures} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden')
process.exit(failures ? 1 : 0)
