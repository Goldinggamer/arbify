/**
 * AdmiralBet — das Quotenprotokoll, vollständig erschlossen.
 *
 * ## Zwei frühere Behauptungen dieses Projekts waren falsch
 *
 *  - **„Geo-Blocking"** — nein, `api/geo-country` meldet DE.
 *  - **„SignalR"** — nein. Die Zeichenkette `SignalR` im Bündel stammt aus
 *    Angulars eigenem Reaktivsystem (`consumerAllowSignalWrites`), nicht aus
 *    der Bibliothek gleichen Namens. Ein Fehlalarm der Volltextsuche.
 *
 * ## Wie der Transport gefunden wurde
 *
 * Ein **vollständiger** Neuaufbau der Event-Seite rendert 62 Quoten und
 * erzeugt dabei 179 Ressourcen — von denen keine einzige Quoten trägt. Alles
 * unter `api.de.admiral.at` ist CMS und Konfiguration. Serverseitiges Rendern
 * scheidet aus: das HTML ist eine 18-KB-Hülle ohne Teamnamen. Genau eine
 * Transportart taucht in `performance` grundsätzlich nicht auf: WebSocket.
 *
 * Der Wettbereich ist ein eigenes Micro-Frontend unter `static.admiral.at` —
 * dort, nicht in den Bündeln der Hauptseite, steht die Adresse:
 *
 *     "wsGateway": { "url": "wss://ws.de.admiral.at" }
 *
 * Deren Wurzel antwortet auf HTTP mit 426 Upgrade Required, `/negotiate`,
 * `/info` und `/socket.io/` mit 404 — ein blanker WebSocket.
 *
 * ## Drahtformat
 *
 * Aus der RxJS-Konfiguration im selben Bündel:
 *
 *     binaryType: "arraybuffer"
 *     serializer:   o => deflateRaw(JSON.stringify(o))
 *     deserializer: o => JSON.parse(inflateRaw(o.data))
 *
 * Binäre Rahmen mit **roh**-deflate-gepacktem JSON. Deshalb blieb der Server
 * auf Klartext-Versuche stumm — er konnte sie nicht lesen.
 *
 * ## Umschlag
 *
 *     Anmelden   { connect: { headers: { token } },  properties: { type, service } }
 *     Nutzdaten  { payload: [ …Befehle ],            properties: { type, service } }
 *     Abmelden   { close: {},                        properties: { type, service } }
 *     Herzschlag { ping: {} }  →  { pong: {} }
 *
 * `type` ist die Zeichenkette `"binary"`, keine Zahl. `payload` muss eine
 * **Liste** sein — ein einzelnes Objekt, eine JSON-Zeichenkette oder eine
 * `commands`-Hülle lassen die Verbindung jeweils abbrechen.
 *
 * Dienste: `core`, `sportsbook`, `bettingCustomer`, `betslip`. `sportsbook`
 * nimmt eine **anonyme** Anmeldung mit leerem Token an; `core` lehnt sie mit
 * „service unavailable" ab.
 *
 * ## Der entscheidende Handgriff
 *
 * Die Anmeldung allein genügt nicht. Ohne sie antwortet der Server auf jeden
 * Befehl mit dem **richtigen** Antworttyp, aber leerem Rumpf — `categoryDatas: []`,
 * `groupDatas: []`, `events: []`. Das sieht wie eine Sperre aus und ist keine:
 * die Verbindung ist bloß keinem Mandanten zugeordnet.
 *
 * Zugeordnet wird sie durch `ConfigureEnvironment` — und zwar erst, wenn im
 * Rumpf **`configurationNodeUrn`** steht. Diese Kennung stammt aus der
 * Widget-Konfiguration der Seite und taucht in keinem der Befehlsbauer im
 * Bündel auf. Mit ihr meldet der Server `EnvironmentConfigured`, und aus
 * `preMatchEventCount: 0` werden 809.
 *
 * ## Datenfluss
 *
 * Befehle liefern nur **Verweise** (`asw:event:…`, `asw:category:…`). Die
 * Inhalte kommen getrennt als `SportsbookSnapshotUpdated` mit
 * `snapshotUpdateItems` — ein normalisierter Speicher aus `{kind, type, entity}`.
 * Ein Adapter muss diesen Speicher führen und die Verweise darin auflösen.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import WebSocket from 'ws'

const URL_WS = 'wss://ws.de.admiral.at/'
const ORIGIN = 'https://www.admiralbet.de'
/** Aus `static.admiral.at/mfo/asw.b2b.sports.ui.widget/…/config/admiralbet-de-gt.js` */
const NODE_URN = 'asw:node:admiral:device:6ef60b8b-26fa-4dbb-b719-3c1124acb938'
const MANDATOR = 'admiralbet-de-gt'
/** Fußball; die Wurzelabfrage listet alle Sportarten mit ihren Kennungen. */
const FOOTBALL = 'asw:category:10000002'

const pack = (o: unknown): Buffer => deflateRawSync(Buffer.from(JSON.stringify(o), 'utf8'))

function unpack(data: Buffer): any {
  const msg = JSON.parse(inflateRawSync(data).toString('utf8'))
  if (msg && typeof msg.payload === 'string') {
    try {
      msg.payload = JSON.parse(msg.payload)
    } catch {
      /* bleibt Text */
    }
  }
  return msg
}

const rid = () => Math.random().toString(36).slice(2, 10)

const CONNECT = { connect: { headers: { token: '' } }, properties: { type: 'binary', service: 'sportsbook' } }
const command = (c: unknown) => ({ payload: [c], properties: { type: 'binary', service: 'sportsbook' } })

const configureEnvironment = () => ({
  type: 'ConfigureEnvironment',
  name: 'ConfigureEnvironment',
  body: {
    timeZone: 'Europe/Berlin',
    languageCode: 'de',
    currencyCode: 'EUR',
    mandatorName: MANDATOR,
    // Ohne dieses Feld bleibt jede Antwort leer.
    configurationNodeUrn: NODE_URN,
  },
  requestId: rid(),
})

const rootChildren = () => ({
  type: 'RetrieveCategoryRootChildren',
  name: 'RetrieveCategoryRootChildren',
  body: {},
  requestId: rid(),
})

const sportsbookView = (category: string) => ({
  type: 'RetrieveSportsbookView',
  name: 'SportsbookView/RetrieveSportsbookView',
  body: { categories: [category], expandedEventCount: 1, marketTypes: [] },
  requestId: rid(),
})

const ws = new WebSocket(URL_WS, { headers: { Origin: ORIGIN } })
const responses: any[] = []
const entities: any[] = []

await new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, 16_000)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  ws.on('open', async () => {
    ws.send(pack(CONNECT))
    await sleep(700)
    ws.send(pack(command(configureEnvironment())))
    await sleep(700)
    ws.send(pack(command(rootChildren())))
    await sleep(1500)
    ws.send(pack(command(sportsbookView(FOOTBALL))))
  })

  ws.on('message', (data: Buffer) => {
    let msg: any
    try {
      msg = unpack(data)
    } catch {
      return
    }
    for (const p of Array.isArray(msg.payload) ? msg.payload : []) {
      responses.push(p)
      for (const item of p.body?.snapshotUpdate?.snapshotUpdateItems ?? []) entities.push(item)
    }
  })

  ws.on('close', () => {
    clearTimeout(timer)
    resolve()
  })
  ws.on('error', () => {
    clearTimeout(timer)
    resolve()
  })
})
try {
  ws.close()
} catch {
  /* egal */
}

console.log(`Antworten: ${[...new Set(responses.map((r) => r.type))].join(', ')}`)

const roots = responses.find((r) => r.type === 'CategoryRootChildrenRetrieved')
console.log(`\nSportarten: ${roots?.body?.categoryDatas?.length ?? 0}`)
for (const c of (roots?.body?.categoryDatas ?? []).slice(0, 4)) {
  console.log(`  ${c.category}  Vorspiel ${c.preMatchEventCount}  live ${c.inPlayEventCount}`)
}

const view = responses.find((r) => r.type === 'SportsbookViewRetrieved')
const groups = view?.body?.groupDatas ?? []
const evRefs = groups.flatMap((g: any) => [...(g.preMatchEventDatas ?? []), ...(g.inPlayEventDatas ?? [])])
console.log(`\nKupon: ${groups.length} Gruppen, ${evRefs.length} Partien`)
console.log(`  Beispiel: ${JSON.stringify(evRefs[0])}`)

const byType = new Map<string, number>()
for (const e of entities) byType.set(e.type, (byType.get(e.type) ?? 0) + 1)
console.log(`\nSpeicher: ${entities.length} Einträge`)
for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}× ${t}`)

for (const wanted of ['Event', 'Market', 'Selection', 'Competitor']) {
  const e = entities.find((x) => x.type === wanted)
  if (e) console.log(`\n${wanted}: ${JSON.stringify(e.entity).slice(0, 700)}`)
}

process.exit(0)
