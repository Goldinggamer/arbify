import type { BetWarning, BetWarningId } from '../types'

export const BET_WARNINGS: BetWarning[] = [
  {
    id: 'betting-tax',
    label: 'Wettsteuer',
    detail:
      'Mindestens ein Anbieter dieser Wette gibt die 5,3 % Wettsteuer an den Kunden weiter. ' +
      'Die ausgewiesene Rendite rechnet das bereits ein — im Wettschein steht dann eine ' +
      'niedrigere Quote oder ein Abzug bei der Auszahlung.',
  },
  {
    id: 'implausible-high',
    label: 'Auffällig hoch',
    detail:
      'Über 11 % Rendite. Das kommt vor, wenn ein Anbieter eine Quote zu spät nachzieht — ' +
      'ist aber genauso das typische Bild eines Datenfehlers. Vor dem Setzen beide Quoten ' +
      'im Wettschein gegenprüfen: stimmen Markt, Linie und Anstoßzeit wirklich überein?',
  },
  {
    id: 'stale-odds',
    label: 'Veraltete Quote',
    detail: 'Die Quote wurde länger nicht aktualisiert und könnte beim Platzieren bereits weg sein.',
  },
  {
    id: 'related-contingency',
    label: 'Verbundene Wetten',
    detail: 'Die Outcomes hängen voneinander ab — der Buchmacher könnte die Wette stornieren.',
  },
  {
    id: 'promo-odds',
    label: 'Aktionsquote',
    detail: 'Quotenboost oder Promo. Häufig einsatzbegrenzt und nicht für jeden Account verfügbar.',
  },
  {
    id: 'short-notice',
    label: 'Wenig Vorlauf',
    detail:
      'Anpfiff in unter 30 Minuten. Wer erst noch Geld beim zweiten Buchmacher ' +
      'einzahlen muss, schafft das kaum — und bleibt im Zweifel auf einem ' +
      'Einsatz sitzen, den nur eine Umsatzbedingung wieder freigibt.',
  },
  {
    id: 'account-risk',
    label: 'Limitierungsrisiko',
    detail: 'Dieser Buchmacher limitiert Arbitrage-Spieler erfahrungsgemäß schnell.',
  },
  {
    id: 'push-line',
    label: 'Ganze Linie',
    detail:
      'Die Torgrenze ist eine ganze Zahl (z.B. Über/Unter 2,0). Fällt genau diese Zahl an ' +
      'Toren, werden beide Wetten annulliert und der komplette Einsatz kommt zurück — dann ' +
      'gibt es weder Gewinn noch Verlust, die ausgewiesene Rendite entfällt für diesen Fall. ' +
      'In jedem anderen Ausgang gewinnt genau ein Bein und die Rendite stimmt. Voraussetzung ' +
      'ist, dass beide Anbieter die Linie mit Einsatzrückgabe führen — im Wettschein prüfen.',
  },
  {
    id: 'overtime',
    label: 'Verlängerung prüfen',
    detail:
      'Basketball, Eishockey und American Football führen zu jeder Linie zwei Wetten: eine mit ' +
      'Verlängerung und eine ohne. Die Anbieter markieren die reguläre Spielzeit ausdrücklich, ' +
      'die Variante mit Verlängerung dagegen meist gar nicht — danach ist diese Wette ' +
      'zusammengestellt. Schweigt ein Anbieter und wertet trotzdem nur die reguläre Spielzeit, ' +
      'decken sich die beiden Beine nicht, und die Wette verliert genau dann, wenn es in die ' +
      'Verlängerung geht. Im Wettschein steht die Regel bei beiden Anbietern — kurz vergleichen.',
  },
  {
    id: 'market-collision',
    label: 'Marktzuordnung unklar',
    detail:
      'Bei mindestens einem Anbieter sind für dieselbe Seite zwei Quoten aufgetaucht. Das heißt, ' +
      'dass zwei verschiedene Märkte auf denselben Schlüssel gefallen sind — etwa „4. Viertel" und ' +
      '„1. Halbzeit". Gerechnet wird mit der besten Quote, der Fund wird also nicht unterdrückt; ' +
      'er kann aber auf einer Verwechslung beruhen. Vor dem Setzen im Wettschein prüfen, ob beide ' +
      'Beine wirklich denselben Markt meinen — und den Fall melden, damit die Ursache im Adapter ' +
      'behoben wird.',
  },
]

export const WARNING_BY_ID: Record<BetWarningId, BetWarning> = Object.fromEntries(
  BET_WARNINGS.map((w) => [w.id, w]),
) as Record<BetWarningId, BetWarning>

/**
 * Alle bekannten Warnungskennungen — **abgeleitet**, nicht danebengeschrieben.
 *
 * In `src/lib/api.ts` stand dieselbe Liste ein zweites Mal, von Hand gepflegt,
 * und sie filtert eingehende Warnungen des Backends. Zwei Kennungen fehlten
 * dort: `push-line` und `overtime`. Beide wurden serverseitig korrekt gesetzt
 * und beim Empfang stillschweigend weggeworfen — die Warnung erschien nie an
 * der Wette, und der Warnfilter konnte sie nicht ausblenden, weil sie in den
 * Daten gar nicht ankam.
 *
 * Der Fehler war praktisch unsichtbar: die Auswahlliste im Filter rendert aus
 * `BET_WARNINGS` und sah vollständig aus. Deshalb steht die Liste jetzt nur
 * noch an dieser einen Stelle.
 */
export const ALL_WARNING_IDS: BetWarningId[] = BET_WARNINGS.map((w) => w.id)
