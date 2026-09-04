# Arbify — Zusammenfassung

## Was es ist

Ein Scanner für **Arbitrage-Wetten**: Er vergleicht die Quoten von 16
Buchmacher-Marken für dieselbe Partie und findet Fälle, in denen sich alle
Ausgänge so verteilen lassen, dass ein Gewinn feststeht — unabhängig davon, wie
das Spiel ausgeht. Rechnerisch heißt das: die Summe der impliziten
Wahrscheinlichkeiten liegt unter 100 %.

Die App läuft **lokal**: ein Node-Backend als Scanner, dazu eine React-Oberfläche
im Browser. Nichts davon ist öffentlich erreichbar.

## Woher die Daten kommen

Angebunden sind 16 Marken über 14 Plattformen — Tipico, Betano, bwin,
Sportingbet, ODDSET, LeoVegas, Winamax, Sportwetten.de, VBET, WettArena,
Interwetten, Betway, NEO.bet, DAZN Bet, 888sport und AdmiralBet.

Die Anbieter sind unterschiedlich gebaut, deshalb drei Transportwege: normales
HTTP, HTTP mit nachgebildetem Chrome-Fingerabdruck (gegen Bot-Schutz) und
WebSocket. Ein Durchlauf sammelt rund **7.000 Partien**; etwa **900** davon
liegen bei mindestens zwei Büchern vor und sind damit überhaupt vergleichbar.
Rund 80 % werden über die Sportradar-Match-ID exakt zusammengeführt, der Rest
über Namensähnlichkeit und Anstoßzeit.

## Der eigentlich schwierige Teil

Jeder Buchmacher benennt Märkte anders. Bevor irgendetwas verglichen wird,
übersetzt jeder Adapter seine Quoten in **ein gemeinsames Modell**: Markttyp
(1X2, 2-Weg, Über/Unter, Beide treffen, Handicap 3-Weg, Handicap 2-Weg,
Team-Über/Unter, Gerade/Ungerade), Spielabschnitt (ganze Partie, reguläre
Spielzeit, Halbzeiten, Viertel, Drittel, Sätze) und Einheit (Tore, Punkte,
Spiele, Sätze, Legs). Nur bei identischem Schlüssel dürfen zwei Quoten
gegeneinander gerechnet werden.

Das ist keine Formsache. Im Basketball und Eishockey führt dieselbe Partie ein
„Über 10,5 **mit** Verlängerung" **und** ein „Über 10,5 **ohne**" — wer beides
zusammenwirft, baut eine Wette, die genau dann verliert, wenn verlängert wird.
Ebenso muss die Heim/Auswärts-Ausrichtung stimmen: Bücher führen dieselbe Partie
gedreht, und ein vertauschtes Bein sieht aus wie 30 % Rendite.

## Was es kann

- **8 Sportarten**: Fußball, Tennis, Basketball, Eishockey, Handball,
  Volleyball, American Football, Darts.
- **Filter** nach Buchmacher, Sportart, Marktfamilie, Quotenspanne,
  Renditespanne, Warnhinweisen und Freitext.
- **Einsatzrechner**: verteilt die Bankroll auf alle Beine, zeigt garantierten
  Gewinn und optionale Rundung.
- **9 Warnhinweise** an jeder Wette — etwa Wettsteuer (5,3 %, die manche
  Anbieter weitergeben und die einen 3-%-Fund vernichtet), ganze Linien mit
  Einsatzrückgabe, auffällig hohe Renditen oder ungeklärte Verlängerungsregeln.
- **Zeitfenster** von 24 Stunden, im 60-Sekunden-Takt vollständig gescannt, die
  aussichtsreichsten Partien zusätzlich alle 10 Sekunden. Bewusst kurz: weiter
  entfernte Partien zeigen zwar höhere Renditen, das sind aber überwiegend
  Quotenfehler, die der Anbieter noch storniert — und eine annullierte Wette
  lässt das Gegenbein ungedeckt stehen.

## Benachrichtigungen

Drei Wege, alle an denselben Schwellenwert gekoppelt: Ton im Browser,
macOS-Systemmeldung und — der wichtigste — **Push aufs Telefon**. Den verschickt
der Server selbst über ntfy, Pushover oder einen Webhook; der Browser darf zu
sein. Gemeldet wird ausschließlich, was mit dem eingestellten Filter auch auf
dem Bildschirm stünde, weil serverseitig **dieselbe Filterfunktion** läuft.
Entdopplung, Ruhezeit, Mengenbegrenzung und optionale Nachtruhe verhindern, dass
daraus Dauerfeuer wird.

## Grenzen

Nur Vorspiel-Quoten, keine Live-Wetten. Einsatzlimits der Anbieter sind nicht
abgebildet — die stehen erst im Wettschein. Die Rendite ist der reine
Quotenwert, ohne Steuerabzug. Und: viele Sportarten sind saisonal, im Sommer
liefern die deutschen Bücher außerhalb von Fußball und Tennis wenig.

Abgesichert durch 141 automatische Tests.
