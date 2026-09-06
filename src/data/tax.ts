/**
 * Wettsteuer je Anbieter — als Hinweis, nicht als Rechenposten.
 *
 * In Deutschland fallen nach dem Rennwett- und Lotteriegesetz 5,3 % auf jede
 * Sportwette an (seit 1. Juli 2021, vorher 5 %). Die Steuer schuldet immer der
 * Buchmacher — ob er sie an den Kunden weiterreicht, ist seine Entscheidung.
 * Genau das macht sie für eine Arbitrage zum entscheidenden Posten:
 *
 *   Eine Arbitrage von 3 % über zwei Bücher, von denen eines die Steuer
 *   weitergibt, ist keine Arbitrage mehr. 5,3 % auf ein Bein, das gut die
 *   Hälfte des Einsatzes trägt, kosten rund 2,7 Prozentpunkte Rendite — mehr
 *   als der ganze Fund wert war.
 *
 * ## Die drei Wege, die Steuer weiterzureichen
 *
 * `stake`  — Abzug vom Einsatz: von 100 € landen 94,70 € auf der Wette.
 * `gross`  — Abzug vom Bruttogewinn, also von der Auszahlung.
 * `profit` — Abzug nur vom Nettogewinn (Auszahlung minus Einsatz).
 *
 * `stake` und `gross` sind rechnerisch dasselbe: 50 € auf Quote 2,20 ergeben
 * brutto 110 €, minus 5,3 % sind 104,17 € — identisch zu 47,35 € (= 50 € minus
 * Steuer) auf Quote 2,20. Beide werden deshalb als Faktor auf die Quote
 * gerechnet. Nur `profit` ist günstiger und wird getrennt gerechnet. Die
 * Unterscheidung zwischen `stake` und `gross` bleibt trotzdem erhalten, weil
 * der Hinweistext im Wettschein anders lautet und der Nutzer wissen soll,
 * wonach er sucht.
 *
 * ## Warum hier nichts gerechnet wird
 *
 * Die App weist die Rendite aus den Quoten aus, so wie sie beim Buchmacher
 * stehen. Sie zieht die Steuer **nicht** ab. Das ist bewusst so: wie viel am
 * Ende hängen bleibt, hängt am Konto — an Freiwetten, an Aktionen, an der im
 * Wettschein tatsächlich angezeigten Quote. Eine Zahl, die all das nicht
 * kennt, aber so aussieht, als kenne sie es, wäre schlechter als der schlichte
 * Hinweis: „bei diesem Bein kommt die Steuer noch drauf."
 *
 * ## Belastbarkeit der Einträge
 *
 * `verified: false` heißt: für diesen Anbieter ließ sich die Handhabung nicht
 * eindeutig belegen. Angenommen wird dann **mit** Steuer — die vorsichtige
 * Richtung. Ein Hinweis zu viel kostet einen Blick in den Wettschein, ein
 * Hinweis zu wenig kostet Geld.
 *
 * Stand der Recherche: Juli 2026. Buchmacher ändern das ohne Ankündigung —
 * die Angabe ersetzt keinen Blick in den eigenen Wettschein.
 */

// Der Steuersatz — 5,3 % nach § 17 Abs. 2 Rennwett- und Lotteriegesetz —
// ist in dieser App bewusst keine Rechengröße: sie zieht ihn nirgends ab, die
// Hinweistexte unten nennen ihn nur. Wird das je gewünscht, gehört er hierher.

export type TaxMode = 'none' | 'stake' | 'gross' | 'profit'

export type BookTax = {
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
