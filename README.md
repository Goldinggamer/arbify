# Arbify

Arbitrage-Scanner für 16 in Deutschland lizenzierte Sportwettenanbieter. Er
vergleicht die Quoten derselben Partie über alle Bücher und meldet Fälle, in
denen sich der Einsatz so verteilen lässt, dass der Gewinn unabhängig vom
Ausgang feststeht.

Läuft **lokal**: ein Node-Backend als Scanner, dazu eine React-Oberfläche. Nur
**Vorspiel** — laufende Partien werden bewusst nicht bewertet
([warum](docs/schutzschranken.md#warum-kein-live)).

## Funktionen

- 8 Sportarten: Fußball, Tennis, Basketball, Eishockey, Handball, Volleyball,
  American Football, Darts
- Filter nach Buchmacher, Sportart, Markt, Quote, Rendite, Warnhinweis, Freitext
- Einsatzrechner mit optionaler Rundung auf glatte Beträge
- 10 Warnhinweise je Wette, z. B. Wettsteuer, knapper Vorlauf, auffällig hohe Rendite
- Meldungen aufs Telefon (ntfy, Pushover, Webhook) — auch bei geschlossenem Browser

## Starten

```bash
npm install
npm run dev        # Scanner auf :8787, danach Oberfläche auf :5173
```

| Befehl | Zweck |
| --- | --- |
| `npm run scan` | nur das Backend |
| `npm run dev:web` | nur die Oberfläche (ohne Backend mit Demo-Daten) |
| `npm run scan:once` | ein Durchlauf in der Konsole, ohne Server |
| `npm test` | alle Tests, ohne Netz |
| `node scripts/variance.ts` | drei volle Durchläufe, misst die Streuung |
| `node scripts/check-links.ts` | prüft die Tiefenlinks gegen die echten Seiten |
| `node scripts/golden.ts record\|replay …` | Golden-Test: Live-Lauf aufzeichnen, offline abspielen |

Konfiguration über Umgebungsvariablen (Vorgabe in Klammern): `PORT` (8787),
`DISCOVERY_INTERVAL_MS` (60000), `REFRESH_INTERVAL_MS` (10000), `WINDOW_HOURS`
(24), `MAX_EVENTS` (1200), `MAX_DEPTH_EVENTS` (120), `MAX_HOT_EVENTS` (12),
`HOT_THRESHOLD` (1.06), `MIN_PERCENT` (0). Ein anderer Backend-Port für
`npm run dev`: `API_PORT=9000 npm run dev`.

## Aufbau

```
Adapter (je Plattform) → Matching → Arbitrage-Suche → Snapshot → HTTP-API → Oberfläche
```

| Pfad | Zweck |
| --- | --- |
| `server/adapters/` | ein Adapter je Plattform, übersetzt in das gemeinsame Marktmodell |
| `server/http.ts`, `ws.ts`, `livedoc.ts`, `aswgateway.ts` | Transportwege |
| `server/match.ts` | führt dieselbe Partie über Buchmacher hinweg zusammen |
| `server/scan.ts` | Arbitrage-Suche und Schutzschranken |
| `server/store.ts` | Takte (Discovery 60 s, Refresh 10 s) und Snapshot |
| `server/types.ts` | kanonisches Marktmodell |
| `src/` | Oberfläche; `src/lib/arbitrage.ts` ist der Rechenkern |

Ein Durchlauf ist zweistufig: erst alle Partien mit Hauptmärkten, dann volle
Markttiefe nur für Partien, die es bei mindestens zwei Büchern gibt.

## Anbieter

| Plattform | Marken | Transportweg | Sportradar-ID |
| --- | --- | --- | --- |
| Entain | bwin, Sportingbet, ODDSET | HTTP | ja |
| eigen | Tipico, WettArena | HTTP | ja |
| Kaizen | Betano | HTTP mit Chrome-TLS (`impit`) | ja |
| INSIC | Sportwetten.de | HTTP | ja |
| Kambi | LeoVegas | HTTP | nein |
| eigen | Winamax, Interwetten, Betway, NEO.bet | HTTP | nein |
| Spectate | 888sport | HTTP mit Sitzung | nein |
| BetConstruct | VBET | WebSocket | nein |
| OpenBet | DAZN Bet | LiveDoc (STOMP über SockJS) | nein |
| ASW | AdmiralBet | WebSocket, deflate-gepackt | nein |

Partien mit Sportradar-ID werden exakt zusammengeführt, die übrigen über
Teamnamen und Anstoßzeit. Details: [Datenbeschaffung](docs/datenbeschaffung.md),
[Matching und Märkte](docs/matching-und-maerkte.md).

## Rechenkern

Bei Quoten `q₁ … qₙ` existiert eine Arbitrage, wenn `Σ 1/qᵢ < 1`. Jeder Einsatz
ist proportional zu `1/qᵢ`, damit die Auszahlung bei jedem Ausgang gleich ist:

```
einsatz_i = bankroll · (1/qᵢ) / Σ(1/q)      rendite = 1/Σ(1/q) − 1
```

Beispiel: 500 € auf die Quoten 2,12 und 2,20 → 255 € / 245 €, Auszahlung je
≈ 539 €, garantierter Gewinn 39 € (7,95 %). Wettsteuer und Einsatzlimits gehen
bewusst nicht in die Rechnung ein, sondern erscheinen als Hinweis.

## API

| Endpunkt | Zweck |
| --- | --- |
| `GET /api/opportunities` | aktueller Stand |
| `GET /api/scan` | heiße Partien sofort nachladen (`?full=1`: kompletter Durchlauf) |
| `GET /api/diagnostics` | Adapter-Status, Host-Last, nicht zugeordnete und verworfene Märkte |
| `GET /api/health` | Erreichbarkeit |
| `GET`/`PUT /api/alerts/config`, `POST /api/alerts/test` | Telefonmeldungen |

## Meldungen aufs Telefon

1. ntfy-App installieren.
2. Ein langes zufälliges Thema erzeugen: `openssl rand -hex 16`.
3. In der App abonnieren.
4. In Arbify unter **Filter → Telefon** `ntfy` wählen und das Thema eintragen.
5. **Testen** tippen.

Das Thema ist der einzige Schutz des Kanals — nicht ins Repository, nicht in
Screenshots. Gemeldet wird nur, was mit dem eingestellten Filter auch auf dem
Bildschirm stünde. Weitere Wege und Grenzwerte: [Telefonmeldungen](docs/meldungen.md).

## Rechtliches

Das Abrufen der internen Endpunkte verstößt bei praktisch allen Anbietern gegen
die AGB. Bei öffentlich abrufbaren Daten ist das in Deutschland kein
Straftatbestand, IP-Sperren sind aber einzuplanen. Unabhängig davon limitieren
oder schließen Buchmacher Konten, die erkennbar Arbitrage spielen.
