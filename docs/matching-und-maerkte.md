# Matching und Märkte

Die fehleranfälligste Stelle des Systems: wer zwei verschiedene Partien
zusammenwirft, dieselbe Partie falsch herum ausrichtet oder zwei verschiedene
Märkte gleichsetzt, bekommt eine Arbitrage angezeigt, die es nicht gibt.

## Event-Matching (`server/match.ts`)

**Zwei Durchgänge.**

1. Quellen mit Sportradar-ID (Tipico, Betano, die Entain-Marken,
   Sportwetten.de, WettArena) werden exakt über die ID gruppiert.
2. Alle übrigen docken über normalisierte Teamnamen plus Anstoßzeit (±20
   Minuten) an die bestehenden Gruppen an. Ohne zweiten Durchgang blieben
   ID-Gruppen und Namensgruppen dauerhaft getrennt.

**Toleranz im zweiten Durchgang.** Die Mehrheit der Anbieter liefert keine ID
und hängt vollständig an diesem Durchgang. Namenszusätze („RFS Riga“ gegen
„RFS“) dürfen ihn nicht trennen. Deshalb:

- Sonderbuchstaben (æ, ø, å, ð, þ, đ, ł) werden transliteriert — sie sind keine
  Diakritika und überleben die NFD-Normalisierung nicht.
- Findet die exakte Signatur nichts, wird die ähnlichste Gruppe im Zeitfenster
  gesucht. Die Schwelle 0,75 gilt für **jedes Team einzeln**, nicht für die
  Summe — sonst zöge ein gemeinsames „barcelona“ eSports-Partien an echten
  Fußball heran.

**Ausrichtung.** Bücher sind sich nicht einig, wer Heimmannschaft ist. Der
Matcher wählt eine Quelle als Anker und richtet die übrigen daran aus: bei
gedrehter Ausrichtung werden HOME/AWAY getauscht, Handicap-Linien negiert und
Team-Totals umgehängt. Ist die Ausrichtung nicht sicher, wird die Quelle
verworfen statt geraten. Beide Zahlen stehen unter `/api/diagnostics`.

## Kanonisches Marktmodell (`server/types.ts`)

Jeder Adapter übersetzt seine Märkte in Markttyp, Spielabschnitt, Linie aus
Heimsicht, Seite und — bei Team-Märkten — `subject`. Nur Outcomes mit gleichem
`marketKey()` werden verglichen.

Das ist keine Formsache: im Basketball und Eishockey führt dieselbe Partie
„Über 10,5 mit Verlängerung“ **und** „ohne“. Wer beides zusammenwirft, baut
eine Wette, die genau dann verliert, wenn verlängert wird.

**Unbekannt wird verworfen, nicht geraten.** Ein falsch zugeordneter Markt
erzeugt Phantom-Arbs, ein fehlender kostet nur eine Chance. Was durchfällt,
listet `/api/diagnostics`.

### Bewusst ausgeschlossen

Märkte, die keine saubere Zerlegung des Ergebnisraums sind oder sich nicht auf
das Gesamtspiel beziehen:

- Doppelte Chance (1X und X2 überlappen sich)
- Kombinationswetten („Spielresultat und Gesamtanzahl Tore 2,5“)
- Restzeit-Märkte laufender Spiele
- Halbzeit/Endstand, Genaues Ergebnis, Torschütze
- Intervall-Torwetten („Gesamtanzahl Tore (0-4+)“)
- Zwei-Wege-Handicap bei Kambi (asiatische Linie mit Einsatzrückgabe, gehört
  nicht ins europäische Handicap)
- Team-Parität (das Modell kennt bei Gerade/Ungerade kein `subject`)

Die Ausschlusslisten in den Adaptern sind darum länger als die Positivlisten.
Was dort steht, ist geprüft und absichtlich verworfen. Das hält den
Diagnosebericht klein genug, dass echte Lücken darin auffallen.

### Regeln, die aus echten Fehlern stammen

- **Ein Muster, das nie greift, fällt lautlos aus.** Greift ein Textmuster
  nicht, steht kein falscher Wert im Bestand, sondern gar keiner — und oft auch
  keine Meldung in der Diagnose. Deshalb ist jede Beschriftung in
  `server/adapters/markets.test.ts` gegen den echten Endpunkt abgemessen, und
  zu jeder Zuordnung steht der Nachbarmarkt, der gerade **nicht** mitgehen darf.
- **Abschnitts-Kürzel prüfen.** Sportwetten.de schreibt die Halbzeit bei
  Team-Totals „1. HZ“ statt „1. Halbzeit“. Solange das nicht erkannt wurde,
  landeten Halbzeit-Märkte als Ganzspiel im Bestand und erzeugten Scheinfunde.
- **Auffälligkeiten erst je Buchmacher-Paarung auswerten.** Eine verdächtige
  Marktfamilie ist erst dann ein Argument gegen die Familie, wenn die
  Auffälligkeit nicht an einer einzelnen Quelle hängt.
- **Schlüsselkollisionen zählen.** Liefert *ein* Buchmacher zwei Quoten für
  dieselbe Seite desselben Schlüssels, sind zwei verschiedene Märkte
  zusammengefallen. Das steht unter `/api/diagnostics` als
  `marketKeyCollisions`.
- **Umbenennungen nur, wo die Form fehlt.** „Team 1 trifft“ ist dasselbe wie
  Team-Über 0,5. Die Zuordnung lohnt nur, wenn der Buchmacher den Markt nicht
  ohnehin schon als Team-Über/Unter liefert — sonst entsteht eine Kollision
  (deshalb aktiv bei Tipico, nicht bei VBET).
- **Team-Totals** („Velez – Gesamtanzahl Tore 1,5“) und Gesamt-Totals heißen
  fast gleich und sind völlig verschiedene Wetten. Sie laufen über einen
  eigenen Markttyp mit `subject`; ein unbekanntes Präfix wird verworfen.
