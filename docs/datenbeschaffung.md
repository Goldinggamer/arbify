# Datenbeschaffung

Kein Browser-Scraping. Jede Anbieterseite ist eine SPA und holt ihre Quoten
selbst über interne Endpunkte — genau die spricht Arbify direkt an. Das ist um
Größenordnungen schneller als Seitenaufrufe und übersteht Redesigns des
Frontends.

## Transportwege

| Weg | Datei | Anbieter |
| --- | --- | --- |
| HTTP | `server/http.ts` | die Mehrheit |
| HTTP mit Chrome-TLS | `server/http.ts` über `impit` | Betano (Cloudflare prüft den TLS-ClientHello, nicht den User-Agent) |
| JSON-RPC über WebSocket | `server/ws.ts` | VBET (BetConstruct-Swarm) |
| LiveDoc | `server/livedoc.ts` | DAZN Bet (OpenBet) |
| ASW-Gateway | `server/aswgateway.ts` | AdmiralBet |

Alle WebSocket-Wege nutzen die `ws`-Bibliothek statt Nodes eingebautem Client:
nur sie kann den `Origin`-Header setzen, und nur mit ihr beenden sich einmalige
Skripte wie `npm run scan:once`, statt an der offenen Verbindung hängen zu
bleiben. Verbindungen bleiben offen, weil der Handschlag teurer ist als die
Abfrage.

### LiveDoc (DAZN Bet)

Drei gestapelte Protokolle:

1. **SockJS** rahmt den WebSocket (`/{3 Ziffern}/{8 Zeichen}/websocket`).
   Nachrichten beginnen mit `o` (offen), `h` (Herzschlag), `a[…]` (Nutzlast)
   oder `c[…]` (geschlossen).
2. **STOMP** darüber: ein Dokument wird *abonniert*, z. B.
   `eventmap/upcomingFBL`; Parameter reisen als Kopfzeilen (`X-Lang`, `X-Size`,
   `X-Sort`, `X-StartTime`, …).
3. **JSON-Patch** als Nutzlast: erst der volle Stand, dann Deltas. Große
   Dokumente kommen base64-kodiert und **roh**-deflate-gepackt
   (`inflateRawSync`, nicht `inflateSync`), erkennbar am Kopf
   `is-compressed: true`.

Arbify holt nur Momentaufnahmen: abonnieren, ersten Stand abwarten,
abbestellen. Verbindungsaufbau wird über das Versprechen synchronisiert, nicht
über `readyState` — sonst öffnet jeder gleichzeitige Aufruf während
`CONNECTING` eine weitere Verbindung.

### ASW-Gateway (AdmiralBet)

`wss://ws.de.admiral.at`, binäre Rahmen mit roh-deflate-gepacktem JSON.

```
Anmelden   { connect: { headers: { token } }, properties: { type: "binary", service } }
Nutzdaten  { payload: [ …Befehle ],           properties: { type: "binary", service } }
Herzschlag { ping: {} }  →  { pong: {} }
```

- `payload` muss eine Liste sein. Der Dienst `sportsbook` nimmt eine anonyme
  Anmeldung mit leerem Token an.
- Ohne `ConfigureEnvironment` mit `configurationNodeUrn` antwortet der Server
  mit dem richtigen Antworttyp, aber leerem Inhalt — das sieht wie eine Sperre
  aus und ist keine.
- Befehle liefern nur Verweise (`asw:event:…`); die Inhalte kommen getrennt als
  `SportsbookSnapshotUpdated` in einen normalisierten Entitätenspeicher.
- `RetrieveSportsbookView` mit gesetztem `marketTypes` liefert Partien und
  Quoten in einem Umlauf; die Tiefenstufe holt `RetrieveDetailView`.
- Linien stehen in `properties` (`total: 2.5`, `hcp: "1:0"` als Torgutschrift
  heim:auswärts). Markttypen mit Suffix `:wl` (ganzzahlige Linien) müssen
  mitgeführt werden, sonst fehlt die Hälfte der Über/Unter-Linien.

### Spectate (888sport)

Drei Stufen bis zu den Daten: ein Abruf von `www.888sport.de` setzt
HttpOnly-Kekse, ohne die der AWS-Load-Balancer mit 403 antwortet;
`POST /spectate/load/state` eröffnet dann die Sitzung. Die Bootstrap-Werte
(`brand_id`, `sub_brand_id`, …) stehen fest im Adapter.

Über HTTP gibt es **nur die Siegwette** — Preise für weitere Märkte kommen
ausschließlich über einen WebSocket, dessen Abonnement-Format noch unbekannt
ist. Der Adapter hat deshalb keine Tiefenstufe.

Das italienische 888-Buch (Kambi, Marke `888it`) ist bewusst nicht
angebunden: ein Bein dort ist aus Deutschland nicht setzbar, eine Arbitrage
darüber also eine falsche Meldung. Ein fertiger Adapter steht in der
Git-Historie (`sport888` in `kambi.ts`).

### Weitere Eigenheiten

- **Kambi** liefert Quoten und Linien als Ganzzahl × 1000 und keine
  Sportradar-ID. Die Kennung `leode` ist LeoVegas Deutschland, `leo` ein
  anderes Buch.
- **Entain** (bwin, Sportingbet, ODDSET): Daten-API auf `www.`, nicht auf
  `sports.` — dort läuft die cds-api in einen 30-Sekunden-Timeout.
- **Winamax** liefert rund 900 Partien in einem Abruf über `PRELOADED_STATE`
  im HTML; **Betway** die Quoten im Next.js-Flight-Payload (Header `RSC: 1`).
- **Tipico**: `events/selectedEvents/all/{groupId}` mit der Sportart als Knoten
  liefert das ganze Programm. `type: 'live'` heißt dort „live bewettbar“, nicht
  „läuft“ — maßgeblich ist allein `status === 'running'`.
- Alle Anfragen gehen mit `cache-control: no-cache` raus; Tipico setzt sonst
  `max-age=30`.

## Ratenbegrenzung

Die Rate bestimmt der Host, nicht der Aufrufer: `HOST_POLICIES` in
`server/http.ts` legt je Host Mindestabstand und Höchstzahl gleichzeitiger
Anfragen fest. Mehrere Adapter auf demselben Host teilen sich das Budget.

- **Adaptive Drosselung:** eine 429 oder 403 multipliziert den Mindestabstand
  des Hosts (×2 bis ×8); nach 30 Sekunden Ruhe klingt das wieder ab.
- **Auslaufende Sperren:** ein Host, der alle Versuche abweist, gilt zwei
  Minuten als gesperrt; nach sechs Abweisungen im selben Durchlauf wird nicht
  mehr wiederholt.
- **Telemetrie** je Host steht unter `/api/diagnostics` (`hostLoad`):
  Anfragen, Wiederholungen, Abweisungen, Wartezeit, Drosselungsfaktor. Ohne
  diese Zahlen ist eine Sperre nicht von einem langsamen Anbieter zu
  unterscheiden.

## Takte und Stufen

| Takt | Vorgabe | Was |
| --- | --- | --- |
| Discovery | 60 s | kompletter Sweep, Matching, Markttiefe |
| Refresh | 10 s | lädt nur „heiße“ Partien nach (beste Quoten unter 106 % impliziter Summe, höchstens 12) |

Jeder Discovery-Lauf ist zweistufig:

1. **Sweep** — alle Partien im Zeitfenster, nur Hauptmärkte. Günstig genug für
   jeden Lauf.
2. **Tiefe** — volle Märkte, aber nur für Partien, die es bei mindestens zwei
   Büchern gibt (höchstens 120 je Anbieter, nach Anstoßzeit, je Sportart
   aufgeteilt). `depthSports` schließt Sportarten aus, in denen die Tiefe bei
   einem Anbieter nachweislich nichts hinzufügt. Schlägt die Tiefe fehl, bleibt
   der Sweep-Stand.

`/api/scan` gibt nie den alten Stand zurück: läuft gerade ein Durchlauf, wird
er abgewartet und danach ein frischer gestartet.

## Nicht angebundene Anbieter

| Anbieter | Stand |
| --- | --- |
| Tipwin | Endpunkt bekannt, Filter ist ein undurchsichtiger Token (HTTP 400 von außen) |
| Tiptorro | SPA rendert nach dem Demo-Login nichts |
| MERKUR BETS | Cashpoint-Plattform, Sport-Endpunkte antworten mit 404/500 |
| bet-at-home | App rendert trotz Zustimmung nicht, API-Host antwortet mit 520 |
| bet365 | starker Bot-Schutz |
| Intertops, HAPPYBET | eingestellt bzw. nicht in Betrieb |

Merksatz aus der Fehlersuche: „Seite lädt, aber null Quoten“ ist kein Beleg
für eine Sperre — meistens ist es ein ungeklickter Zustimmungsdialog oder eine
fehlende Konfiguration der Sitzung.
