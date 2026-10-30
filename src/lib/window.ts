/**
 * Das Zeitfenster — eine Definition für Scanner, Oberfläche und Telefonmeldung.
 *
 * 24 Stunden: weiter entfernte Partien zeigen höhere Renditen, das sind aber
 * meist Quotenfehler, die der Anbieter noch storniert — und eine annullierte
 * Wette lässt das Gegenbein offen. Nebeneffekt: das Tiefenbudget reicht für
 * mehr der verbleibenden Partien.
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
