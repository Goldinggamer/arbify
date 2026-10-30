import { pooled } from '../http.ts'
import { sportOf, type RawEvent, type RawOutcome, type Sport } from '../types.ts'

/**
 * Gemeinsamer Ablauf der Tiefenstufe: je Partie die vollen Märkte laden und
 * nur übernehmen, wenn es mehr sind als im Sweep. Scheitert ein Abruf oder
 * liefert er nichts (`null`), bleibt der Sweep-Stand der Partie.
 */
export async function deepen(
  events: RawEvent[],
  limit: number,
  load: (ev: RawEvent, sport: Sport) => Promise<RawOutcome[] | null>,
): Promise<RawEvent[]> {
  const results = await pooled(events, limit, async (ev) => {
    const outcomes = await load(ev, sportOf(ev.sport))
    return outcomes && outcomes.length > ev.outcomes.length
      ? { ...ev, outcomes, fetchedAt: new Date().toISOString() }
      : ev
  })
  return results.map((r, i) => (r.status === 'fulfilled' ? r.value : events[i]))
}
