import type { Opportunity, Settings } from '../types'
import { taxOf } from '../data/tax.ts'

type StakeLeg = {
  index: number
  label: string
  bookmakerId: string
  /** Quote, wie sie beim Buchmacher steht — mit ihr wird gerechnet */
  odds: number
  /**
   * Gibt dieser Anbieter die Wettsteuer an den Kunden weiter?
   *
   * Reine Anzeige-Information. In die Aufteilung geht sie nicht ein: die
   * Rendite unten ist die aus den Quoten, ohne Steuerabzug.
   */
  taxed: boolean
  /** Empfohlener Einsatz in € */
  stake: number
  /** Auszahlung falls dieses Outcome eintritt */
  payout: number
  /** Gewinn falls dieses Outcome eintritt = payout - Gesamteinsatz */
  profit: number
  /** Anteil am Gesamteinsatz (0..1) */
  share: number
}

export type ArbResult = {
  /** Summe der impliziten Wahrscheinlichkeiten (1/quote). < 1 => Arbitrage */
  implied: number
  isArb: boolean
  /**
   * Rendite auf den Gesamteinsatz in Prozent.
   * Theoretisch: 1/implied - 1. Nach Rundung der tatsächliche Wert.
   */
  arbPercent: number
  /** Theoretischer Wert vor Rundung */
  theoreticalPercent: number
  legs: StakeLeg[]
  totalStake: number
  /** Garantierter Gewinn = schlechtestes Outcome */
  guaranteedProfit: number
  bestCaseProfit: number
}

const round = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : v)

/**
 * Berechnet die optimale Aufteilung der Bankroll über alle Outcomes.
 *
 * Kernidee: Einsätze werden proportional zu 1/quote verteilt. Dadurch ist die
 * Auszahlung bei jedem Outcome identisch (= Gesamteinsatz / implied) und der
 * Gewinn ist unabhängig vom Ergebnis garantiert — das ist per Definition das
 * Maximum an sicherem Gewinn für einen gegebenen Gesamteinsatz.
 *
 * Gerechnet wird mit den Quoten, wie sie beim Buchmacher stehen. Die
 * Wettsteuer bleibt außen vor und erscheint nur als Hinweis an der Wette —
 * siehe `src/data/tax.ts`.
 */
export function calculateArbitrage(
  odds: { odds: number; label: string; bookmakerId: string }[],
  settings: Pick<Settings, 'bankroll' | 'roundTo'>,
): ArbResult {
  const implied = odds.reduce((sum, o) => sum + 1 / o.odds, 0)
  const theoreticalPercent = (1 / implied - 1) * 100

  // 1) Ideale Aufteilung der vollen Bankroll
  const budget = settings.bankroll
  const shares = odds.map((o) => 1 / o.odds / implied)

  // 2) Runden auf die gewünschte Einsatz-Stückelung
  const stakes = shares.map((s) => Math.max(0, round(budget * s, settings.roundTo)))
  const totalStake = stakes.reduce((a, b) => a + b, 0)

  const legs: StakeLeg[] = odds.map((o, i) => {
    const payout = stakes[i] * o.odds
    return {
      index: i,
      label: o.label,
      bookmakerId: o.bookmakerId,
      odds: o.odds,
      taxed: taxOf(o.bookmakerId).mode !== 'none',
      stake: stakes[i],
      payout,
      profit: payout - totalStake,
      share: totalStake > 0 ? stakes[i] / totalStake : 0,
    }
  })

  const profits = legs.map((l) => l.profit)
  const guaranteedProfit = profits.length ? Math.min(...profits) : 0
  const bestCaseProfit = profits.length ? Math.max(...profits) : 0

  return {
    implied,
    isArb: implied < 1,
    arbPercent: totalStake > 0 ? (guaranteedProfit / totalStake) * 100 : 0,
    theoreticalPercent,
    legs,
    totalStake,
    guaranteedProfit,
    bestCaseProfit,
  }
}

/** Bequemer Wrapper für eine Opportunity aus der Liste. */
export function arbFor(opp: Opportunity, settings: Settings): ArbResult {
  return calculateArbitrage(
    opp.outcomes.map((o) => ({
      odds: o.best.odds,
      label: o.label,
      bookmakerId: o.best.bookmakerId,
    })),
    settings,
  )
}

/** Reiner Margen-Wert ohne Bankroll-Kontext — für Filter & Sortierung. */
export function arbPercentOf(opp: Opportunity): number {
  const implied = opp.outcomes.reduce((s, o) => s + 1 / o.best.odds, 0)
  return (1 / implied - 1) * 100
}

/** Die Anbieter dieses Funds, die die Wettsteuer an den Kunden weitergeben. */
export function taxedBooksOf(opp: Opportunity): string[] {
  return [...new Set(opp.outcomes.map((o) => o.best.bookmakerId))].filter(
    (id) => taxOf(id).mode !== 'none',
  )
}
