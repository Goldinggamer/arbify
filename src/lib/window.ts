/**
 * Das Zeitfenster — **eine** Definition für Scanner und Oberfläche.
 *
 * Vorher stand es zweimal da: als `WINDOW_HOURS` im Backend (über eine
 * Umgebungsvariable einstellbar) und als fest verdrahtete Konstante in
 * `src/lib/filter.ts`. Die beiden mussten übereinstimmen, und nichts erzwang
 * das. Wäre das Fenster im Backend vergrößert worden, hätte die Oberfläche die
 * zusätzlichen Partien stillschweigend weggefiltert — ohne Fehlermeldung, ohne
 * sichtbaren Grund, denn der Zeitfilter hat keine Bedienfläche.
 *
 * ## Warum 24 Stunden
 *
 * Weit im Voraus stehen die Bücher am weitesten auseinander, dort liegen also
 * rechnerisch die höchsten Renditen. Nur sind das überwiegend **Quotenfehler**,
 * und die werden von den Anbietern storniert, sobald sie auffallen — je früher
 * die Partie liegt, desto mehr Zeit haben sie dafür. Eine Wette, die annulliert
 * wird, ist keine Arbitrage: das Gegenbein steht dann allein da, und aus einem
 * gesicherten Gewinn wird eine offene Wette.
 *
 * Ein Tag Vorlauf ist der Kompromiss: genug Zeit, um beide Beine in Ruhe zu
 * platzieren, und nah genug, dass die Quoten weitgehend abgeglichen sind und
 * ein Fund eher echt als fehlerhaft ist.
 *
 * Der Nebeneffekt ist der eigentliche Gewinn: das Tiefenbudget ist knapp und
 * wird auf die Partien im Fenster verteilt. Weniger Partien heißt, dass jede
 * davon mehr Märkte bekommt — und Vergleichsfläche entsteht in der Tiefe, nicht
 * in der Breite.
 */
export const DEFAULT_WINDOW_HOURS = 24

export const hoursToMs = (hours: number): number => hours * 60 * 60 * 1000

/** "24 h" / "3 Tage" — für die Beschriftung, ohne krumme Zahlen. */
export function windowLabel(hours: number): string {
  if (hours % 24 === 0 && hours >= 24) {
    const days = hours / 24
    return days === 1 ? '24 Stunden' : `${days} Tage`
  }
  return `${hours} Stunden`
}
