/** Märkte, die kein Adapter zuordnen konnte — der wichtigste Hinweis, wo Abdeckung fehlt (`/api/diagnostics`). */

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
 * Zwei Quoten eines Buchs auf derselben Seite eines Schlüssels heißt: zwei
 * verschiedene Märkte sind zusammengefallen. Gezählt, nicht verworfen.
 */
const collisions = new Map<
  string,
  { bookmakerId: string; market: string; count: number; beispiele: string[] }
>()

/** Kollision vermerken — mit Partie, damit sich ein seltener Fall nachstellen lässt. */
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
