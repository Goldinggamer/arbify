import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawEvent } from './types.ts'

/**
 * Der gespeicherte Stand macht den Start schnell — darf aber nie alte Quoten
 * als brauchbar ausgeben. Darum: zu alte Dateien zählen nicht, und Partien,
 * die inzwischen begonnen haben, fliegen heraus.
 */

const dir = mkdtempSync(join(tmpdir(), 'arbify-cache-'))
const file = join(dir, 'cache.json')
process.env.ARBIFY_CACHE_FILE = file
const { loadCache, saveCache } = await import('./cache.ts')

const NOW = Date.parse('2026-11-06T12:00:00Z')

const ev = (id: string, startTime: string): RawEvent => ({
  bookmakerId: 'tipico',
  bookEventId: id,
  sportradarId: null,
  sport: 'Fußball',
  league: 'Bundesliga',
  home: 'A',
  away: 'B',
  startTime,
  isLive: false,
  url: '',
  outcomes: [],
  fetchedAt: '2026-11-06T11:55:00Z',
})

const write = (savedAt: string, pool: RawEvent[]) =>
  writeFileSync(file, JSON.stringify({ savedAt, pool, books: [] }))

test('frischer Stand wird geladen, angepfiffene Partien fallen heraus', async () => {
  write('2026-11-06T11:55:00Z', [ev('1', '2026-11-06T18:00:00Z'), ev('2', '2026-11-06T11:30:00Z')])
  const c = await loadCache(NOW)
  assert.deepEqual(
    c?.pool.map((e) => e.bookEventId),
    ['1'],
  )
})

test('ein Stand älter als 30 Minuten zählt nicht', async () => {
  write('2026-11-06T11:20:00Z', [ev('1', '2026-11-06T18:00:00Z')])
  assert.equal(await loadCache(NOW), null)
})

test('ein Stand aus der Zukunft (verstellte Uhr) zählt nicht', async () => {
  write('2026-11-06T13:00:00Z', [ev('1', '2026-11-06T18:00:00Z')])
  assert.equal(await loadCache(NOW), null)
})

test('kaputte Datei ergibt keinen Stand statt eines Absturzes', async () => {
  writeFileSync(file, '{"savedAt": "2026-11-06T11:55:00Z", "pool": [')
  assert.equal(await loadCache(NOW), null)
})

test('speichern und laden ergibt denselben Bestand', async () => {
  const pool = [ev('7', new Date(Date.now() + 3_600_000).toISOString())]
  await saveCache(pool, [])
  assert.deepEqual((await loadCache())?.pool, pool)
})
