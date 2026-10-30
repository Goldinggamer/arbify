import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Aufzeichnen und Abspielen aller Netzantworten — Grundlage des Golden-Tests
 * (`scripts/golden.ts`).
 *
 *   ARBIFY_TAPE_RECORD=datei  zeichnet jede Antwort auf, geschrieben beim Beenden
 *   ARBIFY_TAPE_REPLAY=datei  spielt sie ab, ohne Netz, ohne Takt und Wartezeit
 *
 * Aufgezeichnet wird je Transport auf der Ebene „Anfrage → Antwort", nicht auf
 * der Leitung: so entfallen beim Abspielen Handschlag, Sitzung und Drosselung.
 * Dieselbe Anfrage mehrfach liefert die Aufnahmen der Reihe nach, danach
 * wiederholt sich die letzte.
 */

type Entry = { ok: true; value: unknown } | { ok: false; message: string; status?: number }
type Tape = { meta: { recordedAt: number }; entries: Record<string, Entry[]> }

const recordFile = process.env.ARBIFY_TAPE_RECORD
const replayFile = process.env.ARBIFY_TAPE_REPLAY

export const tapeMode: 'record' | 'replay' | null = recordFile ? 'record' : replayFile ? 'replay' : null

const tape: Tape = replayFile
  ? JSON.parse(readFileSync(replayFile, 'utf8'))
  : { meta: { recordedAt: Date.now() }, entries: {} }
const cursor = new Map<string, number>()

if (recordFile) process.on('exit', () => writeFileSync(recordFile, JSON.stringify(tape)))

/** Zeitpunkt der Aufnahme — beim Abspielen die eingefrorene Uhr. */
export const tapeRecordedAt = (): number => tape.meta.recordedAt

/** Führt `live` aus (und zeichnet auf) oder liefert beim Abspielen die Aufnahme. */
export async function taped<T>(key: string, live: () => Promise<T>): Promise<T> {
  if (tapeMode === 'replay') {
    const list = tape.entries[key]
    if (!list?.length) throw new Error(`Band: keine Aufnahme für ${key}`)
    const i = cursor.get(key) ?? 0
    cursor.set(key, i + 1)
    const entry = list[Math.min(i, list.length - 1)]
    if (entry.ok) return entry.value as T
    throw Object.assign(new Error(entry.message), { status: entry.status })
  }
  if (tapeMode !== 'record') return live()

  const list = (tape.entries[key] ??= [])
  try {
    const value = await live()
    list.push({ ok: true, value })
    return value
  } catch (e) {
    const err = e as { message?: string; status?: number }
    list.push({ ok: false, message: err?.message ?? String(e), status: err?.status })
    throw e
  }
}
