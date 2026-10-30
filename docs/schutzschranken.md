# Schutzschranken

Jede dieser Regeln existiert, weil der entsprechende Fehler gegen echte Daten
tatsächlich aufgetreten ist.

## Warum kein Live

Live-Arbitrage ist rechnerisch attraktiv und praktisch eine Falle, solange das
Kapital nicht schon bei allen Buchmachern liegt: bis eine Einzahlung beim
zweiten Anbieter durch ist, hat sich die Quote bewegt — und das Geld sitzt
wegen der Umsatzbedingungen fest. Das Risiko ist einseitig. `server/scan.ts`
bewertet laufende Partien deshalb gar nicht. Nebenbei verschwanden damit fast
alle Fehlfunde, die meist nachhinkende Live-Linien waren.

## Arbitrage-Suche (`server/scan.ts`)

- Ein Markt wird nur bewertet, wenn **alle** seine Seiten vorhanden sind.
- Die Bestquoten müssen von **mindestens zwei verschiedenen** Buchmachern kommen.
- Beine über Quote 30 (`MAX_LEG_ODDS`) werden nicht gewertet.
- **Zwei Schwellen für die implizite Summe:**
  - unter **75 %** (rund 33 % Rendite): verworfen, praktisch immer ein
    Datenfehler; gezählt als `rejectedAsImplausible`
  - zwischen 75 % und **90 %**: angezeigt, aber mit der Warnung
    `implausible-high`. Ein Anbieter, der eine Quote zu spät nachzieht, erzeugt
    durchaus 15 %; ein Zuordnungsfehler erzeugt dasselbe Bild. Deshalb
    anzeigen **und** markieren.

## Warnhinweise statt Filter

Was ein Fund nicht ungültig macht, aber vor dem Setzen geprüft werden muss,
erscheint als Warnung an der Wette (`src/data/warnings.ts`), u. a.:

- **Veraltete Quoten** (älter als 60 s)
- **Wenig Vorlauf** — unter 30 Minuten bis zum Anpfiff gilt dasselbe Problem
  wie bei Live-Wetten. Markiert, nicht verworfen: wer sein Kapital schon
  verteilt hat, kann den Fund nutzen.
- **Wettsteuer**, ganze Linien mit Einsatzrückgabe, ungeklärte
  Verlängerungsregeln, Marktkollisionen

## Zeitfenster: 24 Stunden

Festgelegt in `src/lib/window.ts`, gemeinsam für Scanner, Oberfläche und
Telefonmeldung; `WINDOW_HOURS` überschreibt es. Weiter entfernte Partien
zeigen zwar höhere Renditen, das sind aber überwiegend Quotenfehler, die der
Anbieter noch storniert — und eine annullierte Wette lässt das Gegenbein
ungedeckt stehen. Nebeneffekt: das Tiefenbudget reicht für einen deutlich
größeren Anteil der Partien.

## Wettsteuer

Auf jede Sportwette fallen **5,3 %** an. Schuldner ist der Buchmacher; ob er
sie weitergibt, entscheidet er. Eine 3-%-Arbitrage, bei der ein Bein die
Steuer trägt, ist keine mehr.

Die Handhabung je Anbieter steht in `src/data/tax.ts` (Stand der Recherche:
Juli 2026):

| Anbieter | Handhabung |
| --- | --- |
| Tipico, Winamax, Interwetten | tragen die Steuer selbst |
| bwin, Betano, Betway, LeoVegas, Sportingbet | Abzug vom Gewinn |
| AdmiralBet, DAZN Bet („Quotenabschlag“), 888sport | Abzug vom Einsatz |
| NEO.bet | nur Kombiwetten steuerfrei |
| ODDSET, Sportwetten.de, WettArena, VBET | nicht belegt — gelten als steuerpflichtig |

Zwei Entscheidungen:

- **Hinweis, keine Verrechnung.** Die Rendite bleibt der reine Quotenwert; was
  am Ende hängen bleibt, hängt am Konto (Freiwetten, Aktionen, tatsächliche
  Quote im Wettschein). Betroffene Wetten tragen die Warnung `betting-tax`.
- **Unbekannt heißt steuerpflichtig.** Ein Hinweis zu viel kostet einen Blick
  in den Wettschein, einer zu wenig kostet Geld.

Einsatzlimits werden aus demselben Grund nicht verrechnet: kein Anbieter
liefert sie öffentlich, und im angemeldeten Wettschein gelten oft andere.
