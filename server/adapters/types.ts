import type { RawEvent, Sport } from '../types.ts'

/** Liegt ein Anstoß (ms) im Zeitfenster? Eine unlesbare Zeit liegt es nie. */
export const inWindow = (ms: number | undefined, cutoff: number): boolean =>
  typeof ms === 'number' && Number.isFinite(ms) && ms <= cutoff

export type AdapterContext = {
  /** Nur Events innerhalb dieses Zeitfensters holen (ms ab jetzt). */
  windowMs: number
  /** Obergrenze an Events pro Durchlauf — schützt vor Rate-Limits. */
  maxEvents: number
}

export type BookmakerAdapter = {
  /** Muss mit der id in src/data/bookmakers.ts übereinstimmen. */
  id: string
  name: string
  /** Wie der Anbieter erreicht wird — für Logging und Diagnose. */
  transport: 'plain' | 'impit' | 'websocket'

  /**
   * Stufe 1 — breiter Sweep.
   *
   * Holt möglichst alle Events im Zeitfenster, aber nur die Hauptmärkte.
   * Muss günstig sein, weil es jeden Durchlauf für jeden Anbieter läuft.
   */
  fetchEvents(ctx: AdapterContext): Promise<RawEvent[]>

  /**
   * Sportarten, in denen die Tiefe etwas hinzufügt; ohne Angabe alle. Nur
   * setzen, wo gemessen — eine Sportart ohne Gewinn nimmt den anderen sonst
   * Tiefenbudget weg.
   */
  depthSports?: Sport[]

  /**
   * Stufe 2 — volle Markttiefe, nur für Partien bei mindestens zwei Büchern.
   * Bei Fehlern bleibt der Sweep-Stand.
   */
  fetchDepth?(events: RawEvent[], ctx: AdapterContext): Promise<RawEvent[]>
}

export type AdapterResult = {
  bookmakerId: string
  events: RawEvent[]
  durationMs: number
  /** Wie viele Events der Sweep lieferte — `events` wird für den Snapshot geleert. */
  eventCount?: number
  error?: string
  /** Grund eines abgerissenen Abrufs, der beim zweiten Versuch durchging — sonst bliebe die Wiederholung unsichtbar. */
  retried?: string
  /** Wie viele Events in Stufe 2 vertieft wurden */
  deepened?: number
  /**
   * Wie viele Events für Stufe 2 vorgesehen waren.
   *
   * Ohne diese Zahl ist `deepened` nicht lesbar: 48 statt 60 kann heißen, dass
   * zwölf Anfragen abgewiesen wurden — oder dass es nur 48 Kandidaten gab.
   */
  deepenTargets?: number
}
