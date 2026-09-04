/**
 * Sammelt Märkte, die kein Adapter zuordnen konnte.
 *
 * Nicht gemappte Märkte sind der wichtigste Hinweis darauf, wo Abdeckung
 * fehlt: sie kosten Arbitrage-Chancen, richten aber keinen Schaden an. Der
 * Endpunkt /api/diagnostics zeigt die häufigsten, damit die Mapping-Tabellen
 * gezielt gegen echte Daten erweitert werden können — statt zu raten.
 */

const unmapped = new Map<string, { bookmakerId: string; label: string; count: number }>()

export function noteUnmapped(bookmakerId: string, label: string): void {
  const key = `${bookmakerId}::${label}`
  const entry = unmapped.get(key)
  if (entry) entry.count++
  else unmapped.set(key, { bookmakerId, label, count: 1 })
}

export function unmappedReport(limit = 60) {
  return [...unmapped.values()].sort((a, b) => b.count - a.count).slice(0, limit)
}

/**
 * Ein Buchmacher, der für denselben Markt und dieselbe Seite zwei Quoten
 * liefert, hat keine zwei Meinungen — bei ihm sind zwei **verschiedene**
 * Märkte auf denselben Schlüssel gefallen.
 *
 * Genau so entstand der Team-Über/Unter-Fehler: Halbzeit-Märkte von
 * Sportwetten.de landeten unter der Ganzspiel-Kennung, und weil je Seite die
 * höchste Quote gewinnt, ging die Halbzeit-Quote als Ganzspiel-Quote in die
 * Rechnung. Der Bestand sah dabei völlig normal aus — auffällig war nur das
 * Ergebnis, und auch das erst in der Familienstatistik.
 *
 * Diese Zählung macht die Ursache direkt sichtbar. Verworfen wird nichts: die
 * Kollision kann auch von zwei Handelsständen derselben Marke kommen. Sie
 * gehört aber in die Diagnose, bevor jemand nach dem Ergebnis sucht.
 */
const collisions = new Map<
  string,
  { bookmakerId: string; market: string; count: number; beispiele: string[] }
>()

/**
 * Zwei Märkte eines Buchs auf einem Schlüssel — immer ein Zuordnungsfehler.
 *
 * `event` ist nicht schmückendes Beiwerk, sondern der Unterschied zwischen
 * „irgendwo bei Betway" und einer Partie, deren Rohdaten man aufrufen kann.
 * Ohne die Angabe war ein seltener Fall (zwei Vorkommen in einem Durchlauf)
 * praktisch nicht zu finden: bis man ihn nachstellen wollte, hatten sich die
 * Quoten geändert und er trat nicht mehr auf.
 */
export function noteCollision(bookmakerId: string, market: string, event?: string): void {
  const key = `${bookmakerId}::${market}`
  const entry = collisions.get(key)
  if (entry) {
    entry.count++
    if (event && entry.beispiele.length < 3 && !entry.beispiele.includes(event))
      entry.beispiele.push(event)
  } else {
    collisions.set(key, { bookmakerId, market, count: 1, beispiele: event ? [event] : [] })
  }
}

export function collisionReport(limit = 40) {
  return [...collisions.values()].sort((a, b) => b.count - a.count).slice(0, limit)
}

export function resetDiagnostics(): void {
  unmapped.clear()
  collisions.clear()
}
