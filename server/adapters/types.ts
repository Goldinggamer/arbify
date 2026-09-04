import type { RawEvent, Sport } from '../types.ts'

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
  transport: 'plain' | 'impit' | 'websocket' | 'browser'

  /**
   * Stufe 1 — breiter Sweep.
   *
   * Holt möglichst alle Events im Zeitfenster, aber nur die Hauptmärkte.
   * Muss günstig sein, weil es jeden Durchlauf für jeden Anbieter läuft.
   */
  fetchEvents(ctx: AdapterContext): Promise<RawEvent[]>

  /**
   * Sportarten, für die die Tiefenstufe tatsächlich etwas hinzufügt.
   *
   * Ohne Angabe gilt: alle. Gesetzt wird das nur, wo nachgemessen ist, dass
   * eine Sportart bei diesem Anbieter im Detailabruf nichts liefert, was nicht
   * schon im Sweep steht — bei Betano etwa trägt Tennis ausschließlich die
   * Siegwette, und die kommt bereits aus der Liga-Abfrage.
   *
   * Das ist keine Kosmetik: das Tiefenbudget ist knapp und wird in
   * `server/store.ts` je Sportart aufgeteilt. Eine Sportart, die dort nichts
   * gewinnt, nimmt der anderen sonst die Hälfte weg — bei Betano fiel die
   * Quote dadurch von 110/120 auf 50/120, und die fehlenden sechzig waren
   * Fußball-Partien, deren Über/Unter- und Team-Märkte damit ausblieben.
   */
  depthSports?: Sport[]

  /**
   * Stufe 2 — Markttiefe, optional.
   *
   * Wird nur für Events aufgerufen, die auch bei mindestens einem anderen
   * Buchmacher existieren. Alles andere kann ohnehin keine Arbitrage
   * ergeben, und die vollen Marktdaten sind teuer: bei bwin sind es 16,8 MB
   * für 100 Events gegenüber wenigen hundert Kilobyte im Sweep.
   *
   * Gibt die angereicherten Events zurück; bei Fehlern bleibt der Sweep-Stand
   * bestehen.
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
  /**
   * Grund eines abgerissenen Abrufs, der beim zweiten Versuch durchging.
   *
   * Ohne dieses Feld wäre die Wiederholung unsichtbar: das Buch erscheint
   * fehlerfrei, und dass die Verbindung wackelt, fällt erst auf, wenn sie
   * zweimal hintereinander abreißt. Steht `error` daneben, hat auch der
   * zweite Versuch nicht geholfen.
   */
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
