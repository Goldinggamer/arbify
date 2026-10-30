/**
 * Wettsteuer (5,3 %) je Anbieter — als Hinweis, nicht als Rechenposten
 * (docs/schutzschranken.md#wettsteuer).
 *
 * `stake` Abzug vom Einsatz, `gross` vom Bruttogewinn, `profit` nur vom
 * Nettogewinn. `stake` und `gross` sind rechnerisch gleich, bleiben aber
 * getrennt, weil der Wettschein es anders beschriftet.
 *
 * `verified: false`: nicht belegt, angenommen wird mit Steuer. Stand: Juli 2026.
 */

// Der Steuersatz — 5,3 % nach § 17 Abs. 2 Rennwett- und Lotteriegesetz —
// ist in dieser App bewusst keine Rechengröße: sie zieht ihn nirgends ab, die
// Hinweistexte unten nennen ihn nur. Wird das je gewünscht, gehört er hierher.

type TaxMode = 'none' | 'stake' | 'gross' | 'profit'

type BookTax = {
  mode: TaxMode
  /** Handhabung belegt? Sonst gilt die vorsichtige Annahme „mit Steuer". */
  verified: boolean
  /** Zusatz für den Hinweistext, z.B. Ausnahmen für Kombiwetten. */
  note?: string
}

const NO_TAX: BookTax = { mode: 'none', verified: true }

const TAX: Record<string, BookTax> = {
  // ---- Anbieter, die die Steuer selbst tragen -----------------------------
  tipico: NO_TAX,
  winamax: NO_TAX,
  interwetten: NO_TAX,
  bet365: NO_TAX,
  tipwin: NO_TAX,
  happybet: NO_TAX,

  // ---- Abzug vom Gewinn ---------------------------------------------------
  bwin: { mode: 'gross', verified: true },
  betano: { mode: 'gross', verified: true },
  betway: { mode: 'gross', verified: true },
  leovegas: { mode: 'gross', verified: true },
  sportingbet: {
    mode: 'gross',
    verified: true,
    note: 'Im Konto wählbar: Abzug vom Einsatz oder vom Gewinn. Gerechnet wird mit dem Gewinn-Abzug.',
  },

  // ---- Abzug vom Einsatz --------------------------------------------------
  admiralbet: { mode: 'stake', verified: true },
  betathome: { mode: 'stake', verified: true },
  daznbet: {
    mode: 'stake',
    verified: true,
    note: 'Heißt dort „Quotenabschlag" — die Quote im Wettschein ist bereits gekürzt.',
  },
  // Der Adapter meldet 888sport unter `sport888de`, die Anbieterliste führt
  // ihn als `888sport`. Beide Schlüssel zeigen auf denselben Eintrag.
  '888sport': { mode: 'stake', verified: true },
  sport888de: { mode: 'stake', verified: true },

  // ---- Nur teilweise steuerfrei ------------------------------------------
  neobet: {
    mode: 'gross',
    verified: true,
    note: 'Nur Kombiwetten sind steuerfrei. Für die hier gezeigten Einzelwetten fällt die Steuer an.',
  },
  merkurbets: {
    mode: 'gross',
    verified: true,
    note: 'Seit April 2025 sind nur noch Kombi- und Bet-Builder-Wetten steuerfrei, Einzelwetten nicht.',
  },
}

/**
 * Vorsichtige Annahme für alles, was nicht in der Tabelle steht.
 *
 * Betrifft heute ODDSET, Sportwetten.de, WettArena, VBET, Intertops und
 * Tiptorro: für diese Anbieter war die Handhabung nicht eindeutig zu belegen.
 */
const ASSUMED: BookTax = { mode: 'gross', verified: false }

export const taxOf = (bookmakerId: string): BookTax => TAX[bookmakerId] ?? ASSUMED

export function taxLabel(mode: TaxMode): string {
  switch (mode) {
    case 'none':
      return 'trägt die Wettsteuer selbst'
    case 'stake':
      return '5,3 % Wettsteuer vom Einsatz'
    case 'profit':
      return '5,3 % Wettsteuer vom Nettogewinn'
    default:
      return '5,3 % Wettsteuer vom Gewinn'
  }
}
