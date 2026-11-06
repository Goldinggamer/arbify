import { readFile, rename, writeFile } from 'node:fs/promises'
import type { AdapterResult } from './adapters/types.ts'
import type { RawEvent } from './types.ts'

/**
 * Gespeicherter Rohbestand des letzten Durchlaufs.
 *
 * Ein kalter Start braucht rund eine Minute, bis alle Bücher und die
 * Markttiefe da sind (Betano allein ~30 s für einen Abruf je Liga). Mit dem
 * gespeicherten Stand steht die Liste sofort; die Quoten tragen ihren alten
 * `fetchedAt` und werden deshalb als veraltet markiert, bis die frischen
 * Bücher nach und nach eintreffen.
 */

const CACHE_FILE = process.env.ARBIFY_CACHE_FILE ?? '.arbify-cache.json'

/** Älter als das lohnt nicht: Vorspiel-Quoten bewegen sich in Minuten, Partien beginnen. */
const MAX_AGE_MS = 30 * 60 * 1000

type Persisted = {
  savedAt: string
  pool: RawEvent[]
  books: AdapterResult[]
}

export async function loadCache(now = Date.now()): Promise<{ pool: RawEvent[]; books: AdapterResult[] } | null> {
  try {
    const data = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as Persisted
    const age = now - new Date(data.savedAt).getTime()
    if (!(age >= 0 && age <= MAX_AGE_MS) || !Array.isArray(data.pool)) return null
    // Inzwischen angepfiffene Partien gehören nicht in einen Vorspiel-Stand.
    const pool = data.pool.filter((e) => new Date(e.startTime).getTime() > now)
    return { pool, books: data.books ?? [] }
  } catch {
    return null
  }
}

/**
 * Schreibt über eine Zwischendatei und benennt dann um: ein Abbruch mitten im
 * Schreiben hinterlässt sonst eine halbe Datei, die beim nächsten Start
 * nicht mehr lesbar ist.
 */
export async function saveCache(pool: RawEvent[], books: AdapterResult[]): Promise<void> {
  if (!pool.length) return
  const tmp = `${CACHE_FILE}.tmp`
  await writeFile(tmp, JSON.stringify({ savedAt: new Date().toISOString(), pool, books } satisfies Persisted))
  await rename(tmp, CACHE_FILE)
}
