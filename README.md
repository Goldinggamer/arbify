# Arbify

Arbitrage-Scanner für in Deutschland lizenzierte Sportwettenanbieter.

**Fokus: Vorspiel.** Laufende Spiele werden erfasst, aber bewusst nicht als
Arbitrage ausgewiesen — siehe [Warum kein Live](#warum-kein-live).

**Stand:** UI und Rechenkern fertig, **sechzehn Anbieter aktiv** —
Tipico, Betano, bwin, Sportingbet, ODDSET, LeoVegas, 888sport, Winamax,
Sportwetten.de, VBET, WettArena, Interwetten, Betway, NEO.bet, DAZN Bet und
AdmiralBet.
Rund 2.000 Events je Durchlauf, davon rund 350 bei mehreren Buchmachern
vergleichbar. Die Quoten der aussichtsreichen Events werden im Sekundentakt
nachgeladen.

> **Ein sechzehnter Adapter ist gebaut, aber abgeschaltet:** das italienische
> 888-Buch. Es liefert mehr Vergleichsfläche als das deutsche, ein Bein dort
> ist aus Deutschland aber nicht setzbar — und eine Arbitrage, die man nicht
> setzen kann, ist keine schwächere Arbitrage, sondern eine falsche Meldung.
> Begründung und Wiedereinschalten unter
> [888sport](#888sport-zwei-bücher-eine-marke).

## Starten

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` startet Scanner und Oberfläche zusammen: erst das Backend auf
`localhost:8787`, dann — sobald `/api/health` antwortet — Vite auf
`localhost:5173`. Beide Ausgaben laufen mit Präfix (`[scan]`, `[web]`) durch
dasselbe Terminal, `Ctrl-C` beendet beide. Ein anderer Backend-Port geht über
`API_PORT=9000 npm run dev` — Vite-Proxy und Scanner ziehen gemeinsam nach.

Einzeln geht weiter: `npm run scan` nur das Backend, `npm run dev:web` nur die
Oberfläche. Ohne laufenden Scanner zeigt die App Demo-Daten und markiert das im
Kopf mit einem gelben Hinweis. Einmaliger Scan ohne Server:

```bash
npm run scan:once
```

Rechenkern, Matcher, Marktmodell und die Marktzuordnung der Adapter sind mit
`node:test` abgedeckt — 155 Tests, ohne Netz:

```bash
npm test
```

Streuung über mehrere Durchläufe messen (drei volle Sweeps hintereinander):

```bash
node scripts/variance.ts
```

Tiefenlinks aller Anbieter gegen die echten Websites prüfen — Status,
Weiterleitung, Seitentitel und ob die Teamnamen im HTML stehen:

```bash
node scripts/check-links.ts
```

## Aufbau

```
src/      Frontend (React, Vite, Tailwind)
server/   Scanner: Adapter, Matching, Arbitrage-Suche, HTTP-API
scripts/  Einmal-Scan für die Konsole
```

| Datei | Zweck |
| --- | --- |
| `src/lib/arbitrage.ts` | Rechenkern: Erkennung und optimale Aufteilung der Bankroll |
| `src/lib/filter.ts` | Filter, Buchmacher-Einschränkung, Sortierung |
| `src/lib/api.ts` | Anbindung ans Backend, Fallback auf Demo-Daten |
| `server/types.ts` | Kanonisches Markt-Modell — die Grundlage jedes Vergleichs |
| `server/http.ts` | HTTP-Schicht: TLS-Impersonation, Rate-Limit, Retry |
| `server/adapters/` | Ein Adapter pro Buchmacher |
| `server/match.ts` | Zusammenführung desselben Events über Buchmacher hinweg |
| `server/scan.ts` | Arbitrage-Suche über zusammengeführte Events |

## Rechenkern

Bei Quoten `q₁ … qₙ` ist die implizite Gesamtwahrscheinlichkeit

```
implied = Σ 1/qᵢ
```

Ist `implied < 1`, existiert eine Arbitrage. Die Einsätze werden proportional zu
`1/qᵢ` verteilt:

```
einsatz_i = bankroll · (1/qᵢ) / implied
```

Dadurch ist die Auszahlung bei **jedem** Ausgang gleich (`bankroll / implied`) und
der Gewinn unabhängig vom Ergebnis garantiert:

```
rendite = 1/implied − 1
```

Beispiel: Bankroll 500 €, Quoten 2,12 und 2,20 → implied = 0,9264 → 7,95 %.
Einsätze 255 € / 245 €, Auszahlung jeweils ≈ 539 €, garantierter Gewinn 39 €.

Eine Korrektur danach: **Rundung** auf glatte Beträge. Angezeigt wird immer die
tatsächlich erreichte Rendite, daneben die theoretische.

Die **Wettsteuer** geht bewusst *nicht* in diese Rechnung ein — sie erscheint
als Hinweis an der Wette, siehe unten.

Einsatzlimits werden bewusst **nicht** mehr verrechnet: kein Anbieter liefert
sie über seine öffentlichen Endpunkte, und die Grenze im Wettschein einer
angemeldeten Sitzung weicht regelmäßig von der ausgeloggten Ansicht ab. Eine
Zahl, die ohnehin jeder vor dem Setzen selbst prüfen muss, gehört nicht in die
Aufteilung.

## Warum kein Live

Live-Arbitrage ist rechnerisch attraktiv und praktisch eine Falle, sobald das
Kapital nicht schon bei allen Buchmachern liegt:

1. Bis die Einzahlung beim zweiten Anbieter durch ist, vergehen Sekunden bis
   Minuten — genug, dass sich die Live-Quote bewegt.
2. Ist die Rendite dann weg, sitzt das Geld fest: Auszahlungen sind bei den
   meisten Anbietern an eine Umsatzbedingung geknüpft, das Kapital muss also
   erst einmal verspielt werden.

Das Risiko ist einseitig — man kann die Rendite verlieren, aber nicht
zurücktreten. Deshalb bewertet `server/scan.ts` laufende Partien gar nicht
mehr. Das hat nebenbei fast alle Fehlfunde beseitigt: die früher dominierende
Sorte („Über 4,5 zu 15,00 bei bwin gegen Unter 4,5 zu 1,20 bei
Sportwetten.de") war durchweg eine nachhinkende Live-Linie.

Aus demselben Grund gibt es die Warnung **Wenig Vorlauf**: unter 30 Minuten bis
zum Anpfiff steht dasselbe Problem im Raum. Der Fund wird markiert, nicht
verworfen — wer sein Kapital schon verteilt hat, kann ihn nutzen.

Folgen für die Architektur: der schnelle Takt ist von 4 auf 10 Sekunden
gelockert (Vorspiel-Quoten bewegen sich in Minuten, und der engere Takt hatte
uns bei Winamax prompt einen HTTP 403 eingebracht), und der Live-Umschalter in
der Oberfläche ist entfallen.

## Datenbeschaffung

Kein Browser-Scraping. Jede Anbieterseite ist eine SPA und holt ihre Quoten
selbst über interne JSON-Endpunkte — genau die werden direkt angesprochen.
Antwortzeiten liegen bei 200–800 ms statt 5–10 s pro Seitenaufruf, und die
Endpunkte sind über Frontend-Redesigns hinweg stabil.

Drei Zugriffsmuster, die sich im Pilot gezeigt haben:

| Anbieter | Plattform | Endpunkt | Besonderheit |
| --- | --- | --- | --- |
| Tipico | eigen | `/v1/tpapi/programgateway/…` | kein Bot-Schutz |
| Betano | Kaizen | `/api/league/hot/upcoming` | Cloudflare prüft TLS-Fingerprint |
| bwin | Entain | `/cds-api/bettingoffer/…` | Sportradar-ID |
| Sportingbet | Entain | dieselbe API, anderer Host | eine Zeile Konfiguration |
| ODDSET | Entain | dieselbe API, anderer Host | eine Zeile Konfiguration |
| LeoVegas | Kambi | `eu-offering-api.kambicdn.com`, Kennung `leode` | Quoten als Ganzzahl ×1000; `leo` ist ein anderes Buch |
| 888sport | Spectate | `/spectate/inplay-req/getScheduledEvents` | Sitzung nötig, nur Siegwette |
| ~~888sport (IT)~~ | Kambi | dieselbe API, Marke `888it` | gebaut, aber **abgeschaltet** — siehe unten |
| Winamax | eigen | `PRELOADED_STATE` im HTML | ~900 Partien in **einem** Abruf |
| Sportwetten.de | INSIC | `eventservice.sportwetten.de` | sauber typisiert, Sportradar-ID |
| VBET | BetConstruct | WebSocket `eu-swarm-*.betconstruct.com` | einziger Anbieter über die WS-Schicht |
| WettArena | eigen | `/API/FixtureMobile/…` | 300+ Felder je Spiel, Sportradar-ID |
| Interwetten | eigen | `/de/sport/upcoming/10?hours=n` | serverseitig gerendert |
| Betway | eigen (Next.js) | Seitenabruf mit Header `RSC: 1` | Quoten im Flight-Payload |
| NEO.bet | eigen | `/.sportsbet/program/matches` | ein offener Abruf, ganzes Programm, keine Tiefenstufe |
| DAZN Bet | OpenBet | LiveDoc: STOMP über SockJS | einziger Anbieter ganz ohne HTTP-Quoten |
| AdmiralBet | ASW-Gateway | `wss://ws.de.admiral.at` | deflate-gepacktes JSON, Entitätenspeicher |

Drei davon kosteten **keinen** neuen Adapter: Sportingbet und ODDSET laufen über
den Entain-Adapter, 888sport über den Kambi-Adapter — beide sind über die Marke
parametrisiert. Das ist der Hebel: nicht ein Adapter je Marke, sondern einer je
Plattform.

### Zweite Transportschicht: WebSocket

`server/ws.ts` kapselt JSON-RPC über WebSocket für Anbieter, die keine
HTTP-Abrufe anbieten. Die Klasse hält die Verbindung offen (ein Handshake
kostet rund eine Sekunde — bei vier Sekunden Refresh-Takt wäre Auf- und Abbau
je Durchlauf Verschwendung), ordnet Antworten über eine laufende Nummer zu und
verbindet nach Abbrüchen neu.

Bewusst die `ws`-Bibliothek statt Nodes eingebautem WebSocket, aus zwei
praktisch erzwungenen Gründen: SignalR-Hubs prüfen den `Origin`-Header, den der
eingebaute Client nicht setzen kann, und eine offene Verbindung würde den
Node-Prozess sonst am Leben halten — einmalige Skripte wie `npm run scan:once`
beendeten sich nie.

Genutzt wird sie von einem Anbieter (VBET/BetConstruct). Bei den übrigen
Kandidaten stellte sich heraus, dass ihre WebSocket-Kanäle **gar keine Quoten
führen**: Betways SignalR-Hub lehnt Quoten-Abos mit `MessageRejected` ab und ist
ein reiner Benutzer-Kanal, Interwettens Hub pusht nur sporadische Änderungen
laufender Spiele. Beide waren stattdessen über HTTP zu haben — die
SignalR-Marker im Seitenquelltext waren eine Fährte in die Irre.

### Dritte Transportschicht: LiveDoc (OpenBet)

`server/livedoc.ts`. Eine eigene Schicht neben `RpcSocket`, weil DAZN Bet kein
JSON-RPC spricht, sondern **drei gestapelte Protokolle**:

1. **SockJS** rahmt den WebSocket. Die Adresse trägt eine frei erfundene
   Server- und Sitzungskennung (`/{3 Ziffern}/{8 Zeichen}/websocket`), jede
   Nachricht beginnt mit einem Buchstaben: `o` offen, `h` Herzschlag, `a[…]`
   Nutzlast, `c[…]` geschlossen. Gesendet wird ein JSON-Array von Strings.
2. **STOMP** darüber. Ein Dokument wird nicht abgefragt, sondern *abonniert*:
   `SUBSCRIBE` auf eine Zieladresse wie `eventmap/upcomingFBL`, Parameter
   reisen als Kopfzeilen (`X-Lang`, `X-Size`, `X-Sort`, `X-StartTime`, …).
3. **JSON-Patch** als Nutzlast. Die erste Nachricht ist der volle Stand
   (`[{op:"add",path:"",value:{…}}]`), alle weiteren sind Deltas darauf. Große
   Dokumente kommen base64-kodiert und **roh**-deflate-gepackt (kein
   zlib-Rahmen — `inflateSync` scheitert, `inflateRawSync` trägt), erkennbar am
   Kopf `is-compressed: true`.

Die Klasse holt bewusst nur **Momentaufnahmen**: abonnieren, ersten Stand
abwarten, abbestellen. Für einen Scanner ist das die richtige Form — der
Scheduler fragt ohnehin in festem Takt neu, und ein Dauerabo über hunderte
Partien wäre Buchhaltung ohne Gewinn. Die *Verbindung* bleibt offen; teuer ist
der Handschlag, nicht das Abo. Gemessen: eine Verbindung schafft rund 900 Abos
je Sekunde, der Kupon mit 500 Partien kommt in 370 ms.

Ein Fehler dabei ist erwähnenswert, weil er nur unter Last auftrat: die erste
Fassung prüfte vor dem Verbinden `readyState === OPEN`. Während des Aufbaus
steht der aber auf `CONNECTING`, also öffnete **jeder gleichzeitige Aufruf eine
weitere Verbindung** und überschrieb die vorige — bei einer Anfrage
unauffällig, bei 150 sofort `WebSocket is not open`. Die Prüfung läuft jetzt
über das Versprechen, nicht über den Socket-Zustand.

Betano antwortet mit **403 auf curl, auch mit perfekten Headern** — geprüft wird
der TLS-ClientHello (JA3/JA4), nicht der User-Agent. `impit` bildet Chromes
Handshake nach und löst das ohne Browser.

Kambi fällt aus dem Rahmen: Quoten und Linien kommen als Ganzzahl mal 1000
(1,95 → 1950), und es gibt **keine Sportradar-ID**. Dort läuft das Matching
über Teamnamen plus Anstoßzeit.

bwin läuft auf Entains `cds-api` mit einer statischen, öffentlichen Access-ID.
Achtung bei den Hosts: die Daten-API liegt bei beiden Entain-Marken auf `www.`,
die Oberfläche auf `sports.`. Über `sports.sportingbet.de` läuft die cds-api in
einen 30-Sekunden-Timeout — das hatte den kompletten Refresh-Takt blockiert.

### Ratenbegrenzung: der Host entscheidet, nicht der Aufrufer

Früher gab jeder Adapter sein eigenes `minIntervalMs` mit, und wie viele
Anfragen tatsächlich gleichzeitig liefen, ergab sich aus der Poolgröße am
Aufrufort. Unter Last war das nicht mehr steuerbar: die Tiefenphase mehrerer
Adapter überlappt, und ein Host sieht die Summe.

Sichtbar wurde das nie als Fehler, sondern als **Schwankung** — Sportwetten.de
15,3 s statt 1,8 s, Tipico nur 48 statt 60 vertiefte Partien, WettArena in
einem Lauf mit 0 Events, und eine Vergleichsbasis, die zwischen 189 und 424
Partien wanderte. Die Retry-Schleife verwandelte jede Abweisung in Laufzeit.

Drei Änderungen in `server/http.ts`:

- **`HOST_POLICIES`** — je Host ein Mindestabstand *und* ein Deckel für
  gleichzeitige Anfragen, zentral an einer Stelle für alle 16 Anbieter. Der
  Wert eines Adapters wirkt nur noch nach oben; die Poolgrößen bestimmen die
  Rate nicht mehr, sondern nur die Größe des Wartezimmers.
- **Adaptive Drosselung** — eine 429 oder 403 ist die einzige belastbare
  Aussage darüber, dass die Rate zu hoch war. Statt nur zu warten und zu
  wiederholen, wird der Mindestabstand des Hosts multipliziert (×2 bis ×8) und
  klingt nach 30 Sekunden Ruhe wieder ab. Der Rest des Durchlaufs kommt damit
  durch, statt sein Budget zu verheizen.
- **Auslaufende Sperren** — ein Host, der alle Versuche überdauert abweist,
  galt vorher dauerhaft als gesperrt und wurde nur durch eine erfolgreiche
  Antwort befreit, die es nicht mehr geben konnte. Ein Sweep, der einmal
  hineinlief, blieb für die Prozesslaufzeit bei 0 Events. Die Markierung läuft
  jetzt nach zwei Minuten aus, und nach sechs Abweisungen im selben Durchlauf
  wird gar nicht mehr wiederholt — sonst kostet jede weitere Kette 13 Sekunden
  Backoff, ohne ein Event zu holen.

Dazu kommt **Telemetrie je Host** (`hostLoad` unter `/api/diagnostics`):
Anfragen, Wiederholungen, Abweisungen, Fehlschläge, Wartezeit,
Drosselungsfaktor. Ohne diese Zahlen ist eine Ratenbegrenzung nicht von einem
langsamen Anbieter zu unterscheiden.

Gemessen, drei Durchläufe hintereinander nach der Umstellung:

| Lauf | Events | gematcht | Dauer | Wiederholungen | Abweisungen |
| --- | --- | --- | --- | --- | --- |
| 1 | 1.163 | 169 | 19,5 s | 0 | 0 |
| 2 | 1.184 | 170 | 20,3 s | 0 | 0 |
| 3 | 1.206 | 173 | 21,7 s | 0 | 0 |

Kein Anbieter fiel in einem der Läufe auf 0 Events. Die Laufzeit ist dabei
nicht gestiegen — die vorherige Fassung brauchte für denselben Umfang 20,1 s.

Ehrlicher gezählt wird auch die Tiefenstufe: Adapter geben bei einem
Fehlschlag den Sweep-Stand zurück, damit ein hakendes Event nicht das ganze
Buch kostet. Als „vertieft" zählt deshalb nur noch, wo tatsächlich mehr Märkte
ankamen, und `deepenTargets` sagt daneben, wie viele es hätten sein sollen.
`48/60` heißt jetzt zwölf verlorene Anfragen; vorher hätte dort `60` gestanden.

### Zwei Takte: Discovery und Refresh

Ein vollständiger Durchlauf über alle Anbieter dauert rund 8 Sekunden und
bewegt zweistellige Megabyte. Im Sekundentakt ist das weder machbar noch
nötig: von über 1.000 Events stehen immer nur eine Handvoll kurz vor einer
Arbitrage.

| Takt | Intervall | Was |
| --- | --- | --- |
| Discovery | 60 s | kompletter Sweep, Matching, Markttiefe — findet neue Events |
| Refresh | 4 s | lädt nur die „heißen" Events nach: laufende Spiele und solche, deren beste Quoten unter 106 % impliziter Summe liegen |

Gemessen: Refresh-Zyklus 1,1 s, Datenalter im Betrieb 0,8–3,9 s.

Der Aktualisieren-Knopf ruft `/api/scan` auf und bekommt **nie** den alten
Stand: läuft gerade ein Durchlauf, wird er abgewartet und danach ein frischer
gestartet. Vorher gab `runScan` bei laufendem Scan sofort den letzten Snapshot
zurück — der Knopf sah dann aus, als täte er nichts.

Ergänzend gehen alle ausgehenden Anfragen mit `cache-control: no-cache` raus.
Tipico setzt auf seinen Datenendpunkten `max-age=30`; ohne den Header riskiert
man eine bis zu 30 Sekunden alte Antwort.

### Zwei Stufen: Sweep und Tiefe

Vollständige Marktdaten sind teuer — bei bwin sind es **16,8 MB für 100
Events**. Deshalb läuft jeder Durchlauf zweistufig:

1. **Sweep** — alle Events im Zeitfenster (Vorgabe: 24 Stunden), aber nur die
   Hauptmärkte.
   Günstig genug, um jeden Durchlauf für jeden Anbieter zu laufen.
2. **Tiefe** — volle Markttiefe, aber nur für Events, die bei mindestens zwei
   Buchmachern existieren. Alles andere kann ohnehin keine Arbitrage ergeben.

Wie die Anbieter im Sweep abgedeckt werden, unterscheidet sich stark:

| Anbieter | Sweep | Tiefe |
| --- | --- | --- |
| Tipico | `events/hourEvents/today` + `tomorrow-12` decken exakt das 24-h-Fenster ab und liefern 1X2 gleich mit | `events/{id}` — rund 30 Marktgruppen |
| Betano | kein anbieterweiter Endpunkt: Liga für Liga über `league/hot/upcoming`. Die rund 195 Liga-IDs stehen als Links im Markup der Fußball-Übersicht | Event-Seite, Marktdaten sind serverseitig ins HTML gerendert |
| bwin | `fixtures` mit Pagination, `offerMapping=Filtered` (~13 Märkte) | `fixture-view` mit `offerMapping=All` (~87 Märkte) |

Weil im Sommer die meisten der 195 Betano-Ligen leer sind, merkt sich der
Adapter, welche zuletzt Events hatten, und fragt die übrigen nur rotierend ab.

### Event-Matching

Die fehleranfälligste Stelle des Systems. Wer zwei verschiedene Partien
zusammenwirft — oder dieselbe Partie falsch herum — bekommt eine Arbitrage
angezeigt, die es nicht gibt.

**Gruppieren, zweistufig.** Tipico, Betano und die Entain-Marken liefern die
Sportradar-Match-ID (`sportRadarMatchId`, `betRadarId`, `addons.betRadar`) —
für die ist das Matching ein exakter ID-Join. Kambi-Marken wie LeoVegas liefern
sie nicht.

Deshalb läuft die Gruppierung in zwei Durchgängen: zuerst alles mit ID, dann
docken die Quellen ohne ID über normalisierte Teamnamen plus Anstoßzeit
(±20 Minuten) an die bestehenden Gruppen an. Ein einstufiges Verfahren würde
ID-Gruppen (`sr:…`) und Namensgruppen (`pair:…`) dauerhaft getrennt halten —
LeoVegas fand so anfangs **keinen einzigen** Gegenpart.

**Warum Durchgang 2 tolerant sein muss.** Neun der sechzehn Anbieter liefern
keine Sportradar-ID — gemessen 426 von 761 Rohzeilen, also die Mehrheit. Sie
hängen vollständig an diesem Durchgang. Solange er exakte Signaturgleichheit
verlangte, trennte ihn jeder Namenszusatz: „Deportes Concepción" gegen
„Concepcion", „RFS Riga" gegen „RFS", „CD Once Caldas" gegen „Once Caldas
Manizales". Dieselbe Partie lag dann in zwei Töpfen mit je zu wenig Büchern.
Zusätzlich zerlegte die Normalisierung æ, ø, å, ð, þ, đ und ł zu Leerzeichen —
das sind keine Diakritika, sie überleben das NFD. Aus „Stabæk" wurde
`["stab", "k"]`.

Beides ist behoben: Sonderbuchstaben werden transliteriert, und findet die
exakte Signatur nichts, sucht der Matcher die ähnlichste Gruppe im Zeitfenster.
Die Schwelle von 0,75 gilt für **beide Seiten einzeln**, nicht für die Summe.
Das ist kein Detail: LeoVegas führt eSports als „Barcelona (Int1liGenT) vs Real
Madrid (Terry14)". Über die Summe zöge das gemeinsame „barcelona" solche
Partien an echten Fußball heran — über das Minimum fallen sie durch.

Gemessen an einem eingefrorenen Pool, alte gegen neue Gruppierung bei
identischer Eingabe: 5,7 → 8,0 Buchmacher je Partie, 536 von 6415
Bestquoten-Schlüsseln besser, **keiner schlechter**. `matchedCount` sinkt dabei
von 101 auf 81 — das ist gewollt, denn zwei Hälften derselben Partie zählten
vorher doppelt.

**Ausrichten.** Buchmacher sind sich nicht einig, wer Heimmannschaft ist: bwin
führt „Cusco FC – Universitario", Tipico dieselbe Partie als „Universitario –
Cusco FC". HOME und AWAY sind also relativ zur Quelle. Der Matcher wählt eine
Quelle als Anker und richtet die übrigen daran aus — bei gedrehter Ausrichtung
werden HOME/AWAY getauscht, Handicap-Linien negiert und Team-Totals umgehängt.
Lässt sich die Ausrichtung nicht sicher bestimmen, wird die Quelle verworfen
statt geraten. Beide Zahlen stehen unter `/api/diagnostics`.

Interwetten wurde ebenfalls untersucht: server-gerendertes HTML plus SignalR-Hub
(`sr5.gamesassists.com/lbfeventHub`) für Live-Updates. Machbar, aber der
aufwändigste der drei Typen — deshalb nicht im Pilot.

### Markt-Normalisierung

Jeder Adapter übersetzt seine Märkte in ein kanonisches Modell
(`server/types.ts`): Typ, Halbzeit, Linie aus Heimsicht, Seite. Erst wenn zwei
Outcomes denselben Schlüssel haben, werden sie verglichen.

Unbekannte Markttypen werden **verworfen statt geraten** — ein falsch gemappter
Markt erzeugt Phantom-Arbs, ein fehlender kostet nur eine Chance. Was
durchgefallen ist, listet `/api/diagnostics`, damit die Mapping-Tabellen gezielt
gegen echte Daten erweitert werden können.

#### Ein Muster, das nie greift, fällt lautlos aus

Die Zuordnung besteht fast nur aus Textmustern gegen die Beschriftungen der
Buchmacher, und die sind die stillste Fehlerquelle im ganzen System: greift ein
Muster nicht, steht kein falscher Wert im Bestand, sondern gar keiner. Zwei
Fälle waren so über Monate unsichtbar:

- Kambi schreibt die Parität als **„Gesamttore ungerade/gerade"**. Geprüft
  wurde auf „gerade/ungerade" allein — und weil die Beschriftung mit
  „Gesamttore" beginnt, fiel sie vorher in den Über/Unter-Zweig, fand dort
  keine Linie und wurde verworfen. Die Meldung an `/api/diagnostics` steht
  hinter diesem Zweig und wurde nie erreicht: die Lücke tauchte in der Diagnose
  nicht auf, weil der Markt es nie bis dorthin schaffte.
- Winamax schreibt **„Anzahl der Tore - Gerade/Ungerade"**, das Muster verlangte
  „Anzahl Tore". Dasselbe Bild: kein Treffer, keine Meldung.

Deshalb liegt die Marktzuordnung der Adapter jetzt unter Test
(`server/adapters/markets.test.ts`), und **jede Beschriftung dort ist gegen den
echten Endpunkt abgemessen**, nicht angenommen. Zu jeder Zuordnung steht der
Nachbarmarkt daneben, der gerade nicht mitgehen darf — „Beide Teams treffen"
gegen „Beide Teams treffen in beiden Hälften", Gesamtparität gegen Teamparität,
Drei-Wege-Handicap gegen die zweiwegige asiatische Linie.

#### Der Bericht ist nur brauchbar, solange echte Lücken darin auffallen

`/api/diagnostics` zeigt die 60 häufigsten nicht zugeordneten Märkte. Das
funktioniert nur, wenn dort nicht steht, was ohnehin bewusst draußen ist.
Kambi führt Ecken und Torschüsse **je Team** und je Zeitintervall, Tipico setzt
seine Typnamen aus Bausteinen zusammen und hatte gar keine Ausschlussliste:
gezählt über einen Lauf standen so über 1.500 verschiedene Zeilen im Bericht,
fast alle mit Zähler 1 oder 2, und die wenigen echten Lücken gingen darin unter.

Die Ausschlusslisten in den Adaptern sind darum länger als die Positivlisten.
Was dort steht, ist geprüft und absichtlich verworfen — nicht übersehen. Nach
dem Aufräumen bleiben rund 230 Zeilen, und die Spitze der Liste besteht aus
Märkten, über die sich tatsächlich entscheiden lässt.

Bewusst ausgeschlossen sind Märkte, die keine saubere Zerlegung des
Ergebnisraums bilden oder sich auf etwas anderes beziehen als das Gesamtspiel:

- **Doppelte Chance** — 1X und X2 überlappen sich
- **Kombinationswetten** („Spielresultat und Gesamtanzahl Tore 2,5") — Schnitt­
  mengen zweier Ereignisse
- **Restzeit-Märkte** laufender Spiele (`standard-rest`, `points-more-less-rest`
  bei Tipico) — sehen strukturell aus wie Ganzspielmärkte, meinen aber nur die
  verbleibende Spielzeit
- **Halbzeit/Endstand, Genaues Ergebnis, Torschütze** — nicht im Modell
- **Intervall-Torwetten** („Gesamtanzahl Tore (0-4+)" bei den Entain-Marken) —
  mehrere Spannen statt zwei Seiten
- **Zwei-Wege-Handicap** — bei Kambi heißt das Kriterium schlicht „Handicap"
  (nachgemessen: nur Heim und Auswärts, keine Unentschieden-Seite). Es ist eine
  asiatische Linie mit Einsatzrückgabe und darf nicht ins europäische Handicap;
  die Drei-Wege-Form heißt dort „Drei-Wege-Handicap" oder „3-Wege Handicap"
- **Team-Parität** („Anzahl der Tore von X - Gerade/Ungerade") — das Modell
  kennt bei `OE` kein `subject`

Besonders heikel sind **Team-Totals**: „Velez Sarsfield – Gesamtanzahl Tore 1,5"
und „Gesamtanzahl Tore 1,5" heißen fast gleich, sind aber völlig verschiedene
Wetten. Sie werden über einen eigenen Markttyp mit `subject` getrennt gehalten;
ein Marktname mit unbekanntem Präfix wird verworfen statt geraten.

#### Der Fall „1. HZ": warum Team-Totals lange ausgeschlossen waren

Team-Über/Unter stand lange **nicht** in `COMPARABLE` — die Familie erzeugte
Vergleiche mit impliziten Summen von 66–90 %, während 1X2, Über/Unter und
Handicap sauber blieben. Die naheliegende Vermutung war ein Fehler in der
Familie selbst. Sie war falsch.

Nachgemessen über 491 buchmacherübergreifende Vergleiche: **jeder** der 139
unplausiblen Fälle hatte Sportwetten.de auf einem Bein, und **keine** Paarung
ohne Sportwetten.de war auffällig (0 von 165). Die Ursache lag in einer
einzigen Zeile: Sportwetten.de beschriftet die Halbzeit-Variante der Team-Totals
mit „1. HZ", alle anderen Halbzeit-Märkte dagegen mit „1. Halbzeit". `periodOf`
kannte nur die Langform, legte also 1.467 Halbzeit-Märkte als Ganzspiel ab —
und im Bestand fielen sie auf denselben Schlüssel wie die echten
Ganzspiel-Märkte. Weil je Seite die höchste Quote gewinnt, setzte sich dort
regelmäßig das Halbzeit-Über durch (Über 0,5 Gastteam: 3,00 in der Halbzeit
gegen 1,75 im ganzen Spiel) und wurde gegen ein Ganzspiel-Unter gerechnet.

Nach der Korrektur bleiben 3 von 491 Vergleichen unter 90 %, alle mit einem
Bein zwischen Quote 15 und 48 — dieselben Ausreißer, die `MAX_LEG_ODDS` und die
Plausibilitätsschranke in jeder anderen Familie ebenfalls abfangen. Damit ist
Team-Über/Unter so belastbar wie die übrigen und **wird gegengerechnet**.

Zwei Lehren, beide im Code verankert:

- Eine auffällige Marktfamilie ist erst dann ein Argument gegen die Familie,
  wenn die Auffälligkeit nicht an einer einzelnen Quelle hängt. Die Auswertung
  je Buchmacher-Paarung hätte das sofort gezeigt.
- Liefert **ein** Buchmacher zwei Quoten für dieselbe Seite desselben Marktes,
  sind dort zwei verschiedene Märkte auf einen Schlüssel gefallen. Genau das
  war hier der Fall, und es war im Bestand nicht zu sehen. Solche Kollisionen
  werden jetzt gezählt und stehen unter `/api/diagnostics` als
  `marketKeyCollisions`.

#### Derselbe Markt unter zwei Namen: „Team 1 trifft"

Der Kollisionszähler hat seinen Nutzen prompt bewiesen — gegen eine Zuordnung,
die inhaltlich völlig richtig war.

„Team 1 trifft" (ja/nein) ist dasselbe wie ein Team-Total über 0,5: „trifft"
heißt mindestens ein Tor, „trifft nicht" heißt keines. Die Zuordnung ist keine
Näherung, sondern eine Umbenennung, und sie war zugeordnet — bei VBET als
`Team1ScoreYes/no`, bei Tipico als `team-scores`.

Bei VBET war sie trotzdem falsch: **VBET liefert beide Formen für dieselbe
Partie**, `Team1OverUnder` mit `base=0.5` und diese hier. Beide fallen auf
denselben Schlüssel, und damit stand derselbe Buchmacher mit zwei Quoten auf
derselben Seite — gemessen 80 bzw. 96 Kollisionen je Lauf. Neue
Vergleichsfläche entsteht dabei keine, den Schlüssel gab es schon; verloren geht
aber die Aussagekraft der Kollisionszählung, und die ist das Instrument, mit dem
echte Schlüsselkollisionen überhaupt auffallen. Bei VBET ist die Zuordnung
darum zurückgenommen.

Bei Tipico bleibt sie: dort gibt es die Über/Unter-Form auf 0,5 nicht, die
Zuordnung erzeugt keine Kollision und öffnet den Vergleich gegen Kambi und
Winamax, die dieselbe Wette als Team-Über/Unter 0,5 führen.

Die Lehre ist nicht „solche Übersetzungen sind falsch", sondern: eine
Umbenennung lohnt nur, wenn der Buchmacher den Markt **nicht ohnehin** in der
Form liefert, die schon zugeordnet ist. Ob das so ist, sagt der Kollisionszähler
nach einem Lauf — nicht die Überlegung vorher.

### Schutzschranken gegen Phantom-Arbs

Jede dieser Schranken existiert, weil der entsprechende Fehler beim Testen
gegen echte Daten tatsächlich aufgetreten ist:

- Ein Markt wird nur bewertet, wenn **alle** seine Seiten vorhanden sind
- Die Bestquoten müssen von **mindestens zwei verschiedenen** Buchmachern kommen
- **Zwei Schwellen für die implizite Summe statt einer.** Unter **75 %** (rund
  33 % Rendite) wird verworfen und unter `/api/diagnostics` als
  `rejectedAsImplausible` gezählt — das ist praktisch immer ein Datenfehler.
  Zwischen 75 % und **90 %** bleibt der Fund erhalten und trägt die Warnung
  `implausible-high`.

  Vorher lag die harte Grenze bei 90 %, also bei 11,1 % Rendite — damit war
  *jeder* Fund darüber unsichtbar. Genau die interessanten Fälle fielen
  stillschweigend heraus: ein Anbieter, der eine Quote zu spät nachzieht,
  erzeugt durchaus 15 oder 20 %. Nur erzeugt ein Mapping-Fehler dasselbe Bild,
  und deshalb wird der Fund jetzt angezeigt **und** markiert, statt entweder
  verschwiegen oder stillschweigend als sauber ausgegeben zu werden.
- Veraltete Quoten, Wettsteuer und knapper Vorlauf werden als Warnung markiert

## API

| Endpunkt | Zweck |
| --- | --- |
| `GET /api/opportunities` | Aktueller Stand für das Frontend |
| `GET /api/scan` | Quoten der heißen Events sofort nachladen |
| `GET /api/scan?full=1` | kompletten Durchlauf erzwingen |
| `GET /api/diagnostics` | Adapter-Status, Match-Quote, Ausrichtungs-Korrekturen, nicht gemappte und verworfene Märkte |
| `GET /api/health` | Erreichbarkeit |
| `GET /api/alerts/config` | Gespiegelter Filter und Einrichtungsstand der Telefonmeldung |
| `PUT /api/alerts/config` | Filter und Einstellungen aus der Oberfläche übernehmen |
| `POST /api/alerts/test` | Probemeldung über den eingerichteten Weg |

Konfiguration über Umgebungsvariablen: `PORT`, `DISCOVERY_INTERVAL_MS`,
`REFRESH_INTERVAL_MS`, `WINDOW_HOURS`, `MAX_EVENTS`, `MIN_PERCENT`,
`MAX_DEPTH_EVENTS`, `MAX_HOT_EVENTS`, `HOT_THRESHOLD`.

## Meldungen aufs Telefon

Der Scanner läuft auf dem Rechner, der Nutzer nicht. Ton und Systemmeldung im
Browser lösen das nicht — beide brauchen den offenen Tab. Deshalb schickt der
**Server** die Funde selbst hinaus.

### Warum kein Web Push

iOS kann seit 16.4 echte Web-Benachrichtigungen, aber nur für Seiten mit
gültigem HTTPS-Zertifikat, die zum Home-Bildschirm hinzugefügt wurden. Für
einen Scanner auf `localhost` hieße das: Domain, Zertifikat, Service-Worker,
VAPID-Schlüssel. Der Weg hier ist umgekehrt und deshalb einfach — der Server
ruft hinaus, das Telefon muss den Rechner nie erreichen. Keine Portfreigabe,
kein dynamisches DNS.

### Einrichten (ntfy, kostenlos)

1. ntfy aus dem App Store laden.
2. Ein **langes zufälliges** Thema erzeugen:
   ```bash
   openssl rand -hex 16
   ```
3. In der ntfy-App unter „Subscribe to topic" eintragen.
4. In Arbify unter **Filter → Telefon** den Dienst `ntfy` wählen und dasselbe
   Thema eintragen.
5. Auf **Testen** tippen. Kommt die Probemeldung an, ist alles verdrahtet.

Damit steht es dauerhaft: der Server legt es in `.arbify-alerts.json` ab (in
`.gitignore`), und `npm run dev` genügt ab dann ohne Zusätze.

> **Das Thema ist ein Geheimnis.** Es ist bei ntfy der einzige Schutz des
> Kanals: wer es kennt, liest jeden Fund mit *und* kann dir selbst Meldungen
> schicken. Es gehört deshalb nicht in diese Datei, nicht ins Repository und
> nicht in einen Screenshot. Ist es doch einmal irgendwo gelandet, erzeuge ein
> neues und trage es an beiden Stellen neu ein — das kostet zwei Minuten.

### Alternativen

Für Läufe ohne Oberfläche — etwa als Hintergrunddienst — geht es weiterhin über
Umgebungsvariablen. Der Reiter „Telefon" hat Vorrang; die Anzeige dort nennt
die aktive Quelle, damit ein vergessenes `ARBIFY_NTFY_TOPIC` die Funde nicht
stillschweigend an ein altes Thema schickt.

| Variable | Bedeutung |
| --- | --- |
| `ARBIFY_NTFY_TOPIC` | Thema; aktiviert ntfy |
| `ARBIFY_NTFY_SERVER` | eigener ntfy-Server, Vorgabe `https://ntfy.sh` |
| `ARBIFY_NTFY_TOKEN` | Zugangstoken für geschützte Themen |
| `ARBIFY_PUSHOVER_TOKEN` + `ARBIFY_PUSHOVER_USER` | Pushover (5 $ einmalig) |
| `ARBIFY_WEBHOOK_URL` | freier Webhook, bekommt die Meldung als JSON |
| `ARBIFY_PUSH` | erzwingt einen Weg, wenn mehrere gesetzt sind |

Verschickt wird immer über **genau einen** Weg — doppelte Meldungen auf
demselben Telefon sind schlimmer als gar keine.

### Wie der Filter dorthin kommt

Der Nutzer stellt seinen Filter im Browser ein. Ein zweiter, serverseitiger
Filter wäre die naheliegende Lösung und die falsche: zwei Implementierungen
driften auseinander, und dann meldet das Telefon Funde, die auf dem Bildschirm
gar nicht stehen. Stattdessen spiegelt die Oberfläche ihren Filter per
`PUT /api/alerts/config`, und in `server/alerts.ts` läuft **dasselbe
`applyFilters`** aus `src/lib/filter.ts`. Eine Implementierung, zwei
Verbraucher — möglich, weil die Filterkette reines TypeScript ohne
Browser-Aufrufe ist.

Der Stand liegt in `.arbify-alerts.json` und überlebt damit einen Neustart des
Servers — samt Gedächtnis, welcher Fund schon gemeldet wurde.

### Damit es nicht nervt

| Regel | Vorgabe | Variable |
| --- | --- | --- |
| Ruhezeit je Fund | 30 min | `ARBIFY_PUSH_COOLDOWN_MS` |
| Höchstens N Meldungen je Fenster | 8 | `ARBIFY_PUSH_MAX` |
| Länge des Fensters | 10 min | `ARBIFY_PUSH_WINDOW_MS` |
| Ab dieser Rendite lauter | 5 % | `ARBIFY_PUSH_HIGH` |

Die Mengenbegrenzung ist kein Komfort, sondern Notwehr: ein Datenfehler bei
einem Anbieter erzeugt schlagartig dutzende Scheinfunde. Ohne Deckel wäre das
Telefon unbenutzbar, und die Meldungen verlören ihren Wert. Übrig bleiben die
acht mit der höchsten Rendite.

Die **Nachtruhe** ist in der Oberfläche einstellbar und holt bewusst nichts
nach: was um acht noch steht, meldet sich um acht — was dazwischen weg war,
gar nicht. Eine Arbitrage von vor fünf Stunden ist keine Nachricht mehr.

## Zeitfenster

Vorgabe sind **24 Stunden**. Die Zahl steht in `src/lib/window.ts` und gilt für
Scanner, Oberfläche und Telefonmeldung gemeinsam; `WINDOW_HOURS` überschreibt
sie, und der Server meldet den tatsächlichen Wert im Schnappschuss mit.

Vorher stand hier eine Woche, begründet damit, dass die Bücher weit vor Anpfiff
am weitesten auseinanderstehen und dort die zweistelligen Renditen liegen. Das
stimmt — nur sind das überwiegend **Quotenfehler**, und die werden storniert,
sobald sie auffallen. Je weiter die Partie weg ist, desto mehr Zeit hat der
Anbieter dafür. Eine annullierte Wette ist keine schwächere Arbitrage, sondern
gar keine: das Gegenbein bleibt stehen, und aus dem gesicherten Gewinn wird eine
offene Wette.

Was das kostet, gemessen an einem Durchlauf mit 15 Funden: **zehn lagen im
Tagesfenster, fünf darüber.** Deren Durchschnittsrendite war nicht auffällig
höher (1,75 % gegen 1,52 %), der größte Ausreißer aber lag bei 5,24 % sechs
Tage vor Anpfiff — genau das Profil, um das es geht.

Der Nebeneffekt ist Entlastung: 11.487 Partien werden zu 3.594, die über
mindestens zwei Bücher vergleichbaren 1.496 zu 453. Das Tiefenbudget bleibt
zwar **überzeichnet** — beim größten Buch stehen 336 Kandidaten für 120 Plätze
—, aber die Abdeckung steigt von rund 10 % auf 36 %. Die Tiefenphase arbeitet
die Partien nach Anstoßzeit ab: wo die Obergrenze greift, fallen die durch, die
noch am längsten Zeit haben.

Ein Anbieter füllte das Fenster zunächst nicht aus: **Tipico** lieferte über
`events/hourEvents` nur `today` und `tomorrow-12`, zusammen rund 36 Stunden —
51 Partien. Über die Zeitachse war da nichts zu holen (`hourEvents/{n}` nimmt
24 und 48, aber nicht 72 oder 168; `upcoming`, `next`, `48hrs` und die
naheliegenden Gruppenpfade antworten mit 400 oder 404).

Der Weg führt über die **Wettbewerbs-IDs** aus `navigationTree/all`:
`events/selectedEvents/all/{groupId}` gibt das vollständige Programm eines
Knotens zurück, und weil die Sportart selbst ein Knoten ist (Fußball = 1101),
genügt ein einziger Aufruf. Ergebnis: **374 statt 51 Partien** im Wochenfenster,
alle mit Quoten und Sportradar-ID. Der Endpunkt liefert das komplette Programm;
der Zuschnitt aufs Fenster passiert lokal.

Ein Detail hing daran: in diesem Endpunkt heißt `type: 'live'` „live
bewettbar", nicht „läuft gerade" — 176 von 516 Partien tragen das Feld, obwohl
sie Tage in der Zukunft liegen. Die alte Oder-Verknüpfung mit `status` hätte
ein Drittel des Programms als Live-Wette abgestempelt und damit von der
Arbitrage-Bewertung ausgeschlossen. Maßgeblich ist jetzt allein
`status === 'running'`.

## Wettsteuer

Nach dem Rennwett- und Lotteriegesetz fallen auf jede Sportwette **5,3 %** an
(seit 1. Juli 2021, davor 5 %). Schuldner ist immer der Buchmacher — ob er sie
an den Kunden weiterreicht, ist seine Entscheidung. Für einen
Arbitrage-Scanner ist das kein Randthema, sondern der größte Einzelposten:

> Eine Arbitrage von 3 % über zwei Bücher, von denen eines die Steuer
> weitergibt, ist keine Arbitrage. 5,3 % auf ein Bein, das gut die Hälfte des
> Einsatzes trägt, kosten rund 2,7 Prozentpunkte — mehr als der Fund wert war.

Die Handhabung je Anbieter steht in `src/data/tax.ts`:

| Anbieter | Handhabung |
| --- | --- |
| Tipico, Winamax, Interwetten, bet365, Tipwin, HAPPYBET | tragen die Steuer selbst |
| bwin, Betano, Betway, LeoVegas, Sportingbet | Abzug vom Gewinn |
| AdmiralBet, bet-at-home, DAZN Bet („Quotenabschlag"), 888sport | Abzug vom Einsatz |
| NEO.bet, MERKUR BETS | nur Kombiwetten steuerfrei — für Einzelwetten fällt sie an |
| ODDSET, Sportwetten.de, WettArena, VBET, Intertops, Tiptorro | nicht eindeutig belegt |

Abzug vom Einsatz und Abzug vom Bruttogewinn laufen aufs selbe hinaus: 50 € auf
Quote 2,20 ergeben brutto 110 €, minus 5,3 % sind 104,17 € — dasselbe wie
47,35 € (Einsatz nach Steuer) auf Quote 2,20. Unterschieden wird trotzdem,
weil im Wettschein ein anderer Hinweis steht und man wissen muss, wonach man
sucht.

Zwei Entscheidungen dahinter:

- **Hinweis, keine Verrechnung.** Die ausgewiesene Rendite bleibt der reine
  Quotenwert. Wie viel am Ende hängen bleibt, hängt am Konto — an Freiwetten,
  an Aktionen, an der im Wettschein tatsächlich angezeigten Quote. Eine
  „Rendite nach Steuer", die davon nichts weiß, sähe genauer aus als sie ist.
  Betroffene Wetten tragen stattdessen die Warnung `betting-tax`, und der
  Detailbereich nennt Anbieter und Abzugsart im Klartext.
- **Unbekannt heißt steuerpflichtig.** Ein Hinweis zu viel kostet einen Blick
  in den Wettschein, ein Hinweis zu wenig kostet Geld. Diese Anbieter werden im
  Detailbereich ausdrücklich als Annahme gekennzeichnet, nicht als Beleg.

Stand der Recherche: Juli 2026. Buchmacher ändern das ohne Ankündigung, und im
angemeldeten Konto kann etwas anderes gelten — die Tabelle ersetzt keinen Blick
in den eigenen Wettschein.

## Verbleibende Anbieter

### Korrektur: es war kein Geo-Blocking

Frühere Fassungen dieses Abschnitts erklärten die Ausfälle mit Geo-Blocking.
**Das war falsch.** Nachgemessen: `ifconfig.co` meldet Deutschland, München,
Vodafone, und bet-at-homes eigenes `/api/geo-country` antwortet mit
`{"countryCode":"DE"}`. Der tatsächliche Grund war in mehreren Fällen ein
**Zustimmungsdialog**, der das Booten der Wett-App blockiert — bei AdmiralBet
etwa ein Overlay mit `z-index: 1999999999`. Nach dem Klick auf „Alle Cookies
akzeptieren" rendert dieselbe Seite 180 Quoten.

Die Konsequenz für die Diagnose: „Seite lädt, aber null Quoten" ist kein
Beleg für eine Sperre. Es ist meistens ein ungeklickter Dialog.

### Stand je Anbieter

| Anbieter | Befund |
| --- | --- |
| **NEO.bet** | **Angebunden.** Ein offener Endpunkt, `/.sportsbet/program/matches`, liefert das komplette Programm samt 1X2, Dreiweg-Handicap und Über/Unter — ohne Login, Cookie oder Tiefenstufe. Der schnellste Adapter im Feld (~200 ms). |
| Intertops | **Eingestellt.** `intertops.de` meldet: „Leider ist intertops.de derzeit nicht in Betrieb." Kein technisches Problem — der Anbieter existiert nicht mehr. Aus der Zielliste entfernt. |
| HAPPYBET | **Nicht in Betrieb.** Die Domain zeigt auf eine IONOS-Parkadresse (217.160.0.77) und bricht schon im TLS-Handshake ab. |
| **DAZN Bet** | **Angebunden.** OpenBet unter `sb-pp-defe.daznbet.de`, Quoten ausschließlich über LiveDoc (STOMP über SockJS) — dafür entstand `server/livedoc.ts`. ~4,4 s je Durchlauf, 148 Partien im 24-Stunden-Fenster, 114 davon mit mindestens einem zweiten Buch vergleichbar. |
| Tipwin | Endpunkt bekannt: `api-web.tipwin.de/v2/100501/offer/data?filter=<Token>`. Der Filter ist ein undurchsichtiger Token; auch frisch aus dem Browser kopiert liefert er von außen HTTP 400. Erfordert Reverse Engineering des Bundles. |
| **AdmiralBet** | **Angebunden.** Eigenes Gateway-Protokoll über WebSocket, ~1,0 s je Durchlauf, 58 Partien im 24-Stunden-Fenster, 51 davon vergleichbar. Eigener Abschnitt unten. |
| Tiptorro | Läuft auf `tiptorro.de` (nicht `.com`). Die SPA holt `/api/user/GetDemoSession`, rendert danach aber nichts — leerer Body auch nach 30 Sekunden. |
| MERKUR BETS | Plattform (Cashpoint) identifiziert, API-Basis `apiv3-msw-mb-de.cashpoint.solutions` bekannt. Nur `/api/v1/cms/…` antwortet; alle Sport-Namensräume liefern 404 oder 500. |
| **888sport** | **Angebunden** über Spectate — Sitzung nötig, liefert nur die Siegwette. Das italienische Kambi-Buch ist gebaut, aber abgeschaltet. Eigener Abschnitt unten. |
| bet-at-home | Zustimmung erteilt, App rendert trotzdem nicht (Body 73 Zeichen). Der aus einem Tracking-Payload gefischte Host `sportsapiem.bet-at-home47.com` antwortet mit Cloudflare 520 — tote Herkunft. |
| bet365 | Starker Bot-Schutz, eigene Kategorie. |

### 888sport: zwei Bücher, eine Marke

In der Liste stehen **beide** 888-Bücher. Das ist Absicht, aber es lohnt sich
zu wissen, welches was kann.

#### Das deutsche Buch (`sport888de`, Spectate)

Frühere Fassungen hier sagten, es fehle „nur der Kambi-Marken-Code". Das war
falsch: **888sport.de läuft nicht mehr auf Kambi**, sondern auf **Spectate**
(`brandName: "888.de"`, Frontend von `cdn.spectateprod.com`, API unter
`spectate-web.888sport.de`).

Der Zugang war dreistufig, und die ersten beiden Stufen sind der eigentliche
Fund:

1. Ohne alles: **403** mit `server: awselb/2.0`. Das ist der AWS-Load-Balancer,
   nicht die Anwendung — kein Header kommt daran vorbei, auch die Nachbildung
   des Chrome-Handshakes nicht.
2. Ein Abruf von `www.888sport.de` setzt zwei **HttpOnly**-Kekse,
   `888Attribution` und `888Cookie`. Damit wechselt die Antwort auf
   `server: nginx` — der Balancer lässt durch. Weil die Kekse HttpOnly sind,
   stehen sie nicht in `document.cookie`; im Browser war schlicht **nicht zu
   sehen**, woran es lag. Der Vergleich „Browser 200, curl 403" führte deshalb
   erst in die Irre.
3. `POST /spectate/load/state` als multipart/form-data eröffnet die Sitzung und
   liefert per `Set-Cookie` die Sitzungskekse (`spectate_session`, `anon_hash`,
   `lang`, `odds_format`). Ohne die antworten alle Datenendpunkte mit 400.

Die Bootstrap-Werte stehen fest je Marke (`brand_id: 84`, `sub_brand_id: 136`,
`regulation_type_id: 12`, `product_package_id: 112`, …). Sie stammen aus dem
Webpack-Modul 30702 der Seite. Der Griff dorthin ist ein nützlicher Kniff:

```js
window.webpackChunksportsbookweb.push([['probe'], {}, (req) => { window.__req = req }])
window.__req(30702)   // liefert die Marken-Konstanten als Werte
```

Damit ist auch die Modulregistrierung (`__req.m`, 581 Module) durchsuchbar —
so kamen die Endpunktpfade ans Licht, ohne einen einzigen Aufruf mitzuschneiden.

**Grenze:** `getScheduledEvents?date=…` liefert das Tagesprogramm, aber **nur
die Siegwette**. Nachgemessen am aktuellen Feed: höchstens 3 Auswahlen je
Partie, ausschließlich die Typen `1`, `X`, `2`. Deshalb hat der Adapter keine
Tiefenstufe. Praktisch: 129 Partien, 387 Quoten, 1,3 s; 78 davon mit
mindestens einem zweiten Buch vergleichbar.

##### Warum die tieferen Märkte über HTTP nicht zu haben sind

Der Grund ist jetzt bekannt, und er ist struktureller Natur — nicht ein
übersehener Parameter. Drei Endpunkte, aus dem laufenden Frontend
mitgeschnitten statt geraten:

- **`/spectate/market_switcher_requests/getMarketSwitcher/football`** listet
  auf, welche Märkte 888 in der Listenansicht überhaupt anbietet, jeweils mit
  `market_id` und `selection_type_ids`: Siegwette (`1632241`), Beide Teams
  treffen (`8`), Über/Unter (`1323275`, Linien 0,5–3,5 über
  `special_odds_value`), Halbzeit-Über/Unter (`1323360`), Doppelte Chance
  (`6`), Siegwette + Beide Teams treffen (`1323267`).
- **`/spectate/sportsbook-req/getUpcomingEvents/football/{today|…}`** liefert
  `selection_pointers` — Tripel aus `event_id`, `market_id`, `selection_id`,
  **ohne Preise**, und ausschließlich für die Standard-Siegwette.
- **`/spectate/inplay-req/getScheduledEvents?date=…`** liefert Preise, aber nur
  für dieselbe Standard-Siegwette.

Damit ist die Architektur klar: **HTTP liefert Struktur, der WebSocket liefert
Preise.** Jeder Versuch, über HTTP einen anderen Markt zu wählen, ist
ergebnislos — `market_id`, `market`, `market_slug`, `mkt`, `market_ids` und
`special_odds_value` wurden gegen beide Endpunkte durchprobiert, als Query wie
als Pfadsegment. Die Antwort ist jedes Mal **byte-identisch** zur Anfrage ohne
Parameter (46.942 Zeichen bzw. 162 Pointer, immer `market_id: 1632241`).

Was am Protokoll noch fehlt, ist genau eine Sache: das Format des
Abonnement-Rahmens für `wss://spectate-ws-live-data.888sport.se`. Der Stand:

- Die Verbindung **öffnet sich ohne Anmeldung**, auch ohne Sitzungskekse.
- Sie beantwortet **keinen** Textrahmen — weder mit Daten noch mit einem
  Fehler. Getestet wurden, je auf frischer Verbindung,
  `{type:"subscribe",…}`, `{action:"subscribe",topics:[…]}`,
  `{cmd:"subscribe",…}`, `{subscribe:{events,markets}}`, Socket.IO-Rahmen
  (`42["subscribe",…]`) und Ping-Varianten. Alle: null Antworten, danach
  stiller Schluss (`1005`) nach etwa 4 Sekunden.
- `websockets:config` führt für `sb_live_data` **nur** die nackte URL, dazu
  Ping-Takt und Wiederverbindungs-Verzögerung — **kein** Pfad, **kein**
  Subprotokoll, **kein** Token.

Ohne Fehlerkanal gibt es nichts, wogegen man raten könnte; das Format muss aus
der laufenden Anwendung kommen. Genau da hakt es: die Wett-App von 888sport
**rendert im automatisierten Browser nicht** — die Partieliste bleibt leer, und
Partie-Adressen lassen sich nicht konstruieren (alle aus den Feed-Slugs
gebildeten Muster antworten mit 404). Nötig wäre ein Mitschnitt der
WebSocket-Rahmen aus einer echten, per Hand bedienten Sitzung.

#### Das italienische Buch (`sport888`, Kambi) — abgeschaltet

Angebunden, bevor das deutsche zugänglich war. Zwei gemessene Punkte:

- **Die Quoten sind eigenständig.** Von 228 Partien, die 888it und LeoVegas
  gemeinsam führen, weichen **209** im 1X2 ab (z. B. Chuncheon – Ulsan:
  2,17/3,00/2,95 gegen 2,20/3,05/2,95). Kein Abbild, ein zweites Buch — und mit
  allen Märkten, nicht nur der Siegwette. Es steuert 195 vergleichbare Partien
  bei, mehr als doppelt so viel wie das deutsche.
- **Ein Bein dort ist aus Deutschland nicht spielbar.** `sport.888casino.it`
  beantwortet von einer deutschen Leitung jeden Wettpfad mit HTTP 404, nur die
  Startseite lädt. Die Marke heißt deshalb im Frontend ausdrücklich
  **„888sport (IT)"**, damit der Zusatz an jedem Bein sichtbar ist.

#### Die Entscheidung: nur das deutsche

`sport888` steht **nicht** in `server/adapters/index.ts`. Der Adapter bleibt in
`kambi.ts` stehen, aktiv ist er nicht.

Der Ausschlag gab nicht die Menge, sondern die Art des Fehlers. Ein Bein, das
sich nicht setzen lässt, macht eine gemeldete Arbitrage nicht schlechter — es
macht sie **falsch**. Und weil die Trefferliste endlich ist, verdrängt jede
solche Meldung eine echte. 195 zusätzlich vergleichbare Partien sind ein
schlechter Tausch gegen eine Liste, die man vor dem Setzen erst filtern muss.

Dazu kam ein Sonderfall, den es mit beiden Büchern gibt: eine Arbitrage, deren
beide Beine bei **demselben Anbieter in zwei Ländern** liegen. Rechnerisch
korrekt, praktisch nicht spielbar.

Wieder einschalten (etwa um Quotenbewegungen zu beobachten, nicht um zu
setzen): `sport888` in `server/adapters/index.ts` importieren und in die Liste
hängen. Der Anzeigename trägt bereits „(IT)".

### Wie das LiveDoc-Protokoll gefunden wurde

Notiert, weil die Methode übertragbar ist: bei 888sport hat sie ein zweites Mal
getragen (dort über die Modulregistrierung, siehe oben), und AdmiralBet sieht
nach derselben Bauart aus.

Am Mitschnitt allein war nichts zu holen: die vier SockJS-Verbindungen stehen,
bevor sich ein Hook auf `window.WebSocket` einhängen kann, und `performance`
verzeichnet nur die `/…/livedoc/info`-Vorabfragen, nicht die Rahmen. Auch ein
Neuladen hilft nicht, weil es den Hook mit entfernt.

Der Weg führte stattdessen über den **Client selbst**. Aus dem Seitenkontext
heraus lassen sich alle 64 Next.js-Bündel per `fetch` holen und nach Begriffen
durchsuchen — same-origin, also ohne CORS-Hürde:

```js
const urls = [...new Set(performance.getEntriesByType('resource')
  .map(e => e.name).filter(u => /_next\/static\/chunks\/.*\.js$/.test(u)))]
for (const u of urls) { const t = await (await fetch(u)).text(); /* suchen */ }
```

Ein Bündel (770 KB) enthielt alles: die Server-Tabelle mit den Präfix-Sätzen je
Dienst, `subscribeStompClient(client, document, headers)`, die Behandlung von
`is-compressed`, `applyPatch` für die Deltas — und die Zieladressen als
Vorlagen. Der entscheidende Fund war `getStream(\`eventmap/${t}${n}\`, …)`
zusammen mit Aufrufen der Form `{ sortBy:'date', type:'upcoming', sportId:'FBL' }`:
daraus ergibt sich `eventmap/upcomingFBL`. Vorher hatte `eventmap/FBL` brav
ein leeres Dokument geliefert — kein Fehler, nur nichts drin.

Merksatz für die nächste Runde: **wenn der Verkehr nicht zu greifen ist, den
Client lesen.** Minifiziert heißt nicht unlesbar; Zieladressen und Kopfzeilen
stehen als Klartext-Vorlagen im Bündel.

### AdmiralBet: wie das Protokoll erschlossen wurde

> Die Überschrift hieß bis hierher „Adapter offen". Das stimmt nicht mehr:
> `server/adapters/admiralbet.ts` ist gebaut und aktiv (siehe die Tabelle
> weiter oben — „Angebunden"), die Marke liefert je Lauf rund 30 Partien. Was
> folgt, ist das Protokollprotokoll, kein offener Punkt.

Zwei frühere Behauptungen dieses Abschnitts waren falsch, beide sind jetzt
widerlegt: es war **kein Geo-Blocking** (`api/geo-country` meldet DE), und es
ist **kein SignalR**. Die Zeichenkette `SignalR` im Bündel stammt aus Angulars
eigenem Reaktivsystem (`consumerAllowSignalWrites`) — ein Fehlalarm der
Volltextsuche, der die Diagnose eine Runde lang in die falsche Richtung schob.

Der belastbare Befund kam aus einem einfachen Test: ein **vollständiger**
Neuaufbau der Event-Seite rendert 62 Quoten und erzeugt dabei 179 Ressourcen —
von denen keine einzige Quoten trägt. Serverseitiges Rendern scheidet aus, das
HTML ist eine 18-KB-Hülle ohne Teamnamen. Genau eine Transportart taucht in
`performance` grundsätzlich nicht auf: WebSocket.

Die Adresse steht nicht in den Bündeln der Hauptseite. Der Wettbereich ist ein
eigenes **Micro-Frontend** unter `static.admiral.at/mfo/asw.b2b.sports.ui.widget/…`
— dort in der Konfiguration: `"wsGateway": { "url": "wss://ws.de.admiral.at" }`.
Deren Wurzel antwortet auf HTTP mit 426 Upgrade Required, `/negotiate`, `/info`
und `/socket.io/` mit 404: ein blanker WebSocket ohne Aushandlung.

**Drahtformat** (aus der RxJS-Konfiguration): binäre Rahmen mit **roh**-deflate
gepacktem JSON. Deshalb blieb der Server auf Klartext stumm — er konnte ihn
nicht lesen.

**Umschlag:**

```
Anmelden   { connect: { headers: { token } }, properties: { type: "binary", service } }
Nutzdaten  { payload: [ …Befehle ],           properties: { type: "binary", service } }
Herzschlag { ping: {} }  →  { pong: {} }
```

`payload` muss eine **Liste** sein; ein einzelnes Objekt, eine JSON-Zeichenkette
oder eine `commands`-Hülle brechen die Verbindung jeweils ab. Der Dienst
`sportsbook` nimmt eine **anonyme** Anmeldung mit leerem Token an.

**Der entscheidende Handgriff** — und die Stelle, an der die Sache beinahe als
„gesperrt" abgehakt worden wäre: Nach der Anmeldung beantwortet der Server
jeden Befehl mit dem *richtigen* Antworttyp, aber leerem Rumpf
(`categoryDatas: []`, `groupDatas: []`). Das sieht wie eine Sperre aus und ist
keine — die Verbindung ist bloß keinem Mandanten zugeordnet. Zuständig dafür
ist `ConfigureEnvironment`, und zwar erst mit **`configurationNodeUrn`** im
Rumpf. Diese Kennung steht in der Widget-Konfiguration und in **keinem** der
Befehlsbauer im Bündel. Mit ihr meldet der Server `EnvironmentConfigured`, und
aus `preMatchEventCount: 0` werden **809**.

Wieder dieselbe Lehre wie beim Zustimmungsdialog, nur eine Ebene tiefer: eine
leere Antwort ist kein Beleg für eine Sperre.

**Datenmodell:** Befehle liefern nur Verweise (`asw:event:…`,
`asw:category:…`). Die Inhalte kommen getrennt als `SportsbookSnapshotUpdated`
mit `snapshotUpdateItems` — ein normalisierter Speicher aus
`{kind, type, entity}`. Ein Durchlauf brachte 408 Einträge: 254 `Category`,
52 `MarketConfig`, 42 `MarketType`, 23 `SelectionType`, 8 `Competitor`,
4 `Event`. Ein `Event` trägt `startTime`, `eventCompetitors` mit
`home`/`away`-Qualifizierer und eine Liste von Marktverweisen.

Bemerkenswert: die Entitäten führen **Sportradar-Kennungen** mit
(`season: "sr:season:140804"`, `venue: "sr:venue:610"`). Ob auch eine
Match-Kennung dabei ist, entscheidet, ob das Matching später über einen
ID-Join läuft.

Erprobt ist das Protokoll in `scripts/probe-admiralbet.ts`, gebaut ist es in
`server/aswgateway.ts` (Transport plus Entitätenspeicher) und
`server/adapters/admiralbet.ts` (Zuordnung).

**Zuschnitt des Adapters.** `RetrieveSportsbookView` mit gesetztem
`marketTypes` liefert Kupon **und** Quoten in einem einzigen Umlauf — 250
Partien, 1.540 Märkte, 3.871 Auswahlen. Ohne `marketTypes` kommen nur die
Partien ohne Quoten. Die Tiefenstufe holt je Partie `RetrieveDetailView`, das
den vollen Marktsatz nachlädt.

Die Taxonomie ist sauber typisiert: `asw:markettype:1` ist die Siegwette,
`:18` Über/Unter, `:14` Handicap, `:29` Beide Teams treffen, und die
Halbzeit-Varianten haben eigene Kennungen (`:60`, `:68`, `:83`, `:90`, …).
Zwei Eigenheiten:

- Die **Linie** steht in `properties`, nicht im Markt-Namen: `total: 2.5` für
  Über/Unter, `hcp: "1:0"` für das Handicap. Das Handicap ist als Torgutschrift
  `heim:auswärts` notiert, die kanonische Linie ist also die Differenz. Geprüft:
  bei `1:0` verkürzt sich die Heimquote von 2,80 auf 1,47 — also `line = +1`.
- Markttypen mit Suffix `:wl` („Whole Line", ganzzahlige Linien) sind eigene
  Kennungen und müssen mitgeführt werden, sonst fehlt die Hälfte der
  Über/Unter-Linien.

## Noch offen

- **888sport: tiefere Märkte** — eingegrenzt, aber offen. Dass HTTP nur die
  Siegwette hergibt, ist geklärt und begründet (siehe oben); fehlt allein das
  Format des Abonnement-Rahmens für `wss://spectate-ws-live-data.888sport.se`.
  Nächster Schritt ist ein Mitschnitt aus einer von Hand bedienten Sitzung —
  der automatisierte Browser bringt die Wett-App nicht zum Rendern.
- **Wettsteuer der offenen Anbieter** — für ODDSET, Sportwetten.de, WettArena,
  VBET, Intertops und Tiptorro ließ sich die Handhabung nicht belegen; sie
  gelten vorsichtshalber als steuerpflichtig. Klären lässt sich das nur im
  angemeldeten Wettschein.
- **Weitere Sportarten** — aktuell nur Fußball
- **Historie und Persistenz** — der Bestand lebt nur im Speicher
- **Mobil-Layout des Detailbereichs**

## Rechtliches

Das Abrufen der internen Endpunkte verstößt bei praktisch allen Anbietern gegen
die AGB. Bei öffentlich abrufbaren Daten ist das in Deutschland kein
Straftatbestand, IP-Sperren sind aber einzuplanen. Unabhängig davon limitieren
oder schließen Buchmacher Konten, die erkennbar Arbitrage spielen.
