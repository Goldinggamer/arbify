import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import {
  forceDiscovery,
  forceRefresh,
  getSnapshot,
  runDiscovery,
  runRefresh,
  type ScanConfig,
} from './store.ts'
import { collisionReport, unmappedReport } from './diagnostics.ts'
import { rejectedReport } from './scan.ts'
import { ADAPTERS } from './adapters/index.ts'
import { DEFAULT_WINDOW_HOURS, windowLabel } from '../src/lib/window.ts'
import {
  getAlertConfig,
  maybeNotify,
  pushStatus,
  sendTest,
  setAlertConfig,
  type AlertConfig,
} from './alerts.ts'

/**
 * Arbify-Backend.
 *
 *   GET /api/opportunities  — aktueller Stand für das Frontend
 *   GET /api/scan           — Quoten der heißen Events sofort nachladen
 *   GET /api/scan?full=1    — kompletten Durchlauf erzwingen
 *   GET /api/diagnostics    — Adapter-Status, Match-Quote, verworfene Märkte
 */

/**
 * Takt: Vorspiel-Quoten bewegen sich in Minuten, nicht in Sekunden.
 *
 * Der frühere Vier-Sekunden-Takt stammte aus der Zeit, als auch Live-Wetten
 * ein Produkt waren. Für Vorspiel bringt er nichts außer Last — Winamax hat
 * beim Testen prompt mit HTTP 403 geantwortet. Zehn Sekunden reichen
 * vollkommen und halten uns aus den Sperren der Anbieter heraus.
 */
const PORT = Number(process.env.PORT ?? 8787)
const DISCOVERY_MS = Number(process.env.DISCOVERY_INTERVAL_MS ?? 60_000)
const REFRESH_MS = Number(process.env.REFRESH_INTERVAL_MS ?? 10_000)

/**
 * Zeitfenster: 24 Stunden.
 *
 * Vorher stand hier eine Woche, mit der Begründung, dass die Bücher weit im
 * Voraus am weitesten auseinanderstehen und dort die zweistelligen Renditen
 * liegen. Das stimmt — nur sind das überwiegend **Quotenfehler**, und die
 * werden storniert, sobald sie auffallen. Je weiter die Partie weg ist, desto
 * mehr Zeit hat der Anbieter dafür. Eine annullierte Wette ist keine
 * Arbitrage: das Gegenbein bleibt stehen, und aus dem gesicherten Gewinn wird
 * eine offene Wette.
 *
 * Die Vorgabe steht in `src/lib/window.ts`, damit die Oberfläche nicht mit
 * einer zweiten Zahl danebenliegt. Über `WINDOW_HOURS` bleibt sie einstellbar,
 * und der Wert geht im Schnappschuss an die Oberfläche — sonst würde sie beim
 * Vergrößern des Fensters die zusätzlichen Partien wegfiltern.
 */
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? DEFAULT_WINDOW_HOURS)

const CONFIG: ScanConfig = {
  windowMs: WINDOW_HOURS * 60 * 60 * 1000,
  maxEvents: Number(process.env.MAX_EVENTS ?? 1_200),
  minPercent: Number(process.env.MIN_PERCENT ?? 0),
  maxDepthEvents: Number(process.env.MAX_DEPTH_EVENTS ?? 120),
  maxHotEvents: Number(process.env.MAX_HOT_EVENTS ?? 12),
  hotThreshold: Number(process.env.HOT_THRESHOLD ?? 1.06),
}

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Rumpf einer Anfrage einlesen.
 *
 * Mit Deckel: der Filter ist ein paar Kilobyte groß, alles darüber ist ein
 * Fehler oder ein Angriff. Der Server hört zwar nur auf `localhost`, aber ein
 * unbegrenzter Puffer ist auch dort keine gute Idee.
 */
const MAX_BODY = 256 * 1024

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > MAX_BODY) {
        reject(new Error('Anfrage zu groß'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  // Vorabfrage des Browsers — muss beantwortet werden, sonst kommt das PUT
  // des Filters nie an.
  if (req.method === 'OPTIONS') return json(res, 204, null)

  try {
    switch (url.pathname) {
      case '/api/opportunities':
        // `windowHours` mitschicken: die Oberfläche schneidet ihre Liste
        // ebenfalls auf das Fenster zu und darf dabei nicht raten.
        return json(res, 200, { ...getSnapshot(), windowHours: WINDOW_HOURS })

      /**
       * Der Filter der Oberfläche, gespiegelt für die Telefonmeldung.
       *
       * GET liefert zusätzlich den Einrichtungsstand des Meldewegs, damit die
       * Oberfläche „nicht eingerichtet" von „läuft" unterscheiden kann.
       */
      case '/api/alerts/config': {
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as {
            filters?: unknown
            settings?: unknown
            push?: unknown
          }
          if (!body.filters || !body.settings)
            return json(res, 400, { error: 'filters und settings erforderlich' })
          setAlertConfig({
            filters: body.filters as AlertConfig['filters'],
            settings: body.settings as AlertConfig['settings'],
            push: (body.push as AlertConfig['push']) ?? undefined,
            updatedAt: new Date().toISOString(),
          })
          return json(res, 200, { ok: true, push: pushStatus() })
        }
        return json(res, 200, { config: getAlertConfig(), push: pushStatus() })
      }

      case '/api/alerts/test': {
        try {
          await sendTest()
          return json(res, 200, { ok: true })
        } catch (e) {
          return json(res, 503, { error: e instanceof Error ? e.message : String(e) })
        }
      }

      case '/api/scan':
        return json(
          res,
          200,
          url.searchParams.has('full') ? await forceDiscovery(CONFIG) : await forceRefresh(CONFIG),
        )

      case '/api/diagnostics': {
        const s = getSnapshot()
        return json(res, 200, {
          adapters: ADAPTERS.map((a) => ({ id: a.id, name: a.name, transport: a.transport })),
          books: s.books,
          eventCount: s.eventCount,
          matchedCount: s.matchedCount,
          srMatchRate: s.srMatchRate,
          hotCount: s.hotCount,
          hostLoad: s.hostLoad,
          flippedSources: s.flippedSources,
          droppedSources: s.droppedSources,
          lastDiscovery: s.lastDiscovery,
          lastRefresh: s.lastRefresh,
          intervals: { discoveryMs: DISCOVERY_MS, refreshMs: REFRESH_MS },
          unmappedMarkets: unmappedReport(),
          marketKeyCollisions: collisionReport(),
          rejectedAsImplausible: rejectedReport(),
        })
      }

      case '/api/health':
        return json(res, 200, { ok: true, lastRefresh: getSnapshot().lastRefresh })

      default:
        return json(res, 404, { error: 'Nicht gefunden' })
    }
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
})

/**
 * Hält den Mac wach, solange der Scanner läuft.
 *
 * Gemessen an einem Vormittag: von 57 Minuten schlief der Rechner 50. In der
 * Zeit läuft die Uhr weiter, der Prozess nicht — es wird nicht gescannt, es
 * kommt keine Meldung aufs Telefon, und beim Aufwachen sind die drei
 * Dauerverbindungen tot. Genau das, was die Telefonmeldung eigentlich
 * abschaffen sollte.
 *
 * `-w` bindet `caffeinate` an die eigene Prozesskennung: endet der Scanner —
 * auch durch SIGKILL oder Absturz — endet die Sperre mit ihm. Deshalb braucht
 * es hier kein Aufräumen. `-i` verhindert den Leerlaufschlaf, `-s` den
 * Systemschlaf am Netzteil; der Bildschirm darf weiter ausgehen.
 *
 * Abschaltbar über ARBIFY_NO_CAFFEINATE=1.
 */
function bleibWach(): void {
  if (process.platform !== 'darwin' || process.env.ARBIFY_NO_CAFFEINATE === '1') return
  try {
    const child = spawn('caffeinate', ['-is', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: true,
    })
    // Der eigene Prozess soll nicht auf caffeinate warten müssen.
    child.unref()
    child.on('error', (e) => console.log(`Schlafsperre nicht aktiv: ${e.message}`))
    child.on('spawn', () => console.log('Schlafsperre aktiv (caffeinate) — Bildschirm darf ausgehen'))
  } catch (e) {
    console.log(`Schlafsperre nicht aktiv: ${e instanceof Error ? e.message : String(e)}`)
  }
}

server.listen(PORT, () => {
  console.log(`Arbify-Backend auf http://localhost:${PORT}`)
  console.log(`Adapter: ${ADAPTERS.map((a) => `${a.id} (${a.transport})`).join(', ')}`)
  console.log(`Discovery alle ${DISCOVERY_MS / 1000} s · Quoten-Refresh alle ${REFRESH_MS / 1000} s`)
  console.log(`Zeitfenster: nächste ${windowLabel(WINDOW_HOURS)}`)
  const push = pushStatus()
  console.log(
    push.ready
      ? `Telefonmeldung: ${push.via}${push.hasConfig ? '' : ' — wartet auf den Filter aus der Oberfläche'}`
      : 'Telefonmeldung: nicht eingerichtet (ARBIFY_NTFY_TOPIC oder ARBIFY_PUSHOVER_*)',
  )
  bleibWach()
  void discoveryLoop()
  void refreshLoop()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function discoveryLoop(): Promise<void> {
  for (;;) {
    const t = Date.now()
    try {
      const s = await runDiscovery(CONFIG)
      const failed = s.books.filter((b) => b.error)
      const wiederholt = s.books.filter((b) => b.retried && !b.error)
      console.log(
        `[${new Date().toLocaleTimeString('de-DE')}] Discovery: ${s.eventCount} Events, ` +
          `${s.matchedCount} gematcht (${Math.round(s.srMatchRate * 100)} % SR-ID), ` +
          `${s.hotCount} heiß, ${s.opportunities.length} Arbs, ${(s.durationMs / 1000).toFixed(1)} s` +
          (failed.length ? ` — Fehler: ${failed.map((f) => `${f.bookmakerId}: ${f.error}`).join('; ')}` : '') +
          (wiederholt.length
            ? ` — nach Abbruch wiederholt: ${wiederholt.map((b) => `${b.bookmakerId}: ${b.retried}`).join('; ')}`
            : ''),
      )
      await maybeNotify(s.opportunities)
    } catch (e) {
      console.error('Discovery fehlgeschlagen:', e)
    }
    await sleep(Math.max(5_000, DISCOVERY_MS - (Date.now() - t)))
  }
}

async function refreshLoop(): Promise<void> {
  // Kurz warten, damit die erste Discovery ein Universum aufgebaut hat.
  await sleep(3_000)
  for (;;) {
    const t = Date.now()
    try {
      // Der Refresh ist der eigentliche Auslöser: er läuft alle zehn Sekunden
      // und ist die Stelle, an der sich Quoten überhaupt bewegen. Die
      // Entdopplung in `alerts.ts` sorgt dafür, dass daraus kein Dauerfeuer
      // wird.
      const s = await runRefresh(CONFIG)
      await maybeNotify(s.opportunities)
    } catch (e) {
      console.error('Refresh fehlgeschlagen:', e)
    }
    // Dauert ein Zyklus länger als das Intervall, staut sich nichts auf —
    // es geht direkt in den nächsten, mit einer kurzen Atempause.
    await sleep(Math.max(500, REFRESH_MS - (Date.now() - t)))
  }
}
