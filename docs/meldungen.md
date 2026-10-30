# Telefonmeldungen

Der Scanner läuft auf dem Rechner, der Nutzer ist unterwegs. Deshalb schickt
der **Server** die Funde selbst hinaus — der Browser darf geschlossen sein.
Web Push scheidet für `localhost` aus (iOS verlangt HTTPS und eine zum
Home-Bildschirm hinzugefügte Seite); so ruft der Server hinaus, und das
Telefon muss den Rechner nie erreichen.

Einrichten mit ntfy: siehe [README](../README.md#meldungen-aufs-telefon). Der
Stand liegt in `.arbify-alerts.json` (in `.gitignore`) und überlebt einen
Neustart, samt Gedächtnis, welcher Fund schon gemeldet wurde.

## Gleicher Filter wie auf dem Bildschirm

Die Oberfläche spiegelt ihren Filter per `PUT /api/alerts/config`, und
`server/alerts.ts` ruft dasselbe `applyFilters` aus `src/lib/filter.ts` auf.
Eine Implementierung, zwei Verbraucher — sonst meldet das Telefon Funde, die
auf dem Bildschirm gar nicht stehen.

## Ohne Oberfläche: Umgebungsvariablen

Der Reiter „Telefon“ hat Vorrang; die Anzeige dort nennt die aktive Quelle.

| Variable | Bedeutung |
| --- | --- |
| `ARBIFY_NTFY_TOPIC` | Thema; aktiviert ntfy |
| `ARBIFY_NTFY_SERVER` | eigener ntfy-Server, Vorgabe `https://ntfy.sh` |
| `ARBIFY_NTFY_TOKEN` | Zugangstoken für geschützte Themen |
| `ARBIFY_PUSHOVER_TOKEN` + `ARBIFY_PUSHOVER_USER` | Pushover |
| `ARBIFY_WEBHOOK_URL` | freier Webhook, bekommt die Meldung als JSON |
| `ARBIFY_PUSH` | erzwingt einen Weg, wenn mehrere gesetzt sind |

Verschickt wird immer über **genau einen** Weg.

## Damit es nicht nervt

| Regel | Vorgabe | Variable |
| --- | --- | --- |
| Ruhezeit je Fund | 30 min | `ARBIFY_PUSH_COOLDOWN_MS` |
| Höchstens N Meldungen je Fenster | 8 | `ARBIFY_PUSH_MAX` |
| Länge des Fensters | 10 min | `ARBIFY_PUSH_WINDOW_MS` |
| Ab dieser Rendite lauter | 5 % | `ARBIFY_PUSH_HIGH` |

Die Mengenbegrenzung ist Notwehr: ein Datenfehler bei einem Anbieter erzeugt
schlagartig dutzende Scheinfunde. Gemeldet werden dann die acht mit der
höchsten Rendite. Die **Nachtruhe** (in der Oberfläche einstellbar) holt
nichts nach — eine Arbitrage von vor fünf Stunden ist keine Nachricht mehr.
