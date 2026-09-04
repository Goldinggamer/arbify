import type { BookmakerAdapter } from './types.ts'
import { tipico } from './tipico.ts'
import { betano } from './betano.ts'
import { bwin, oddset, sportingbet } from './bwin.ts'
import { leovegas } from './kambi.ts'
import { winamax } from './winamax.ts'
import { sportwettende } from './insic.ts'
import { vbet } from './betconstruct.ts'
import { wettarena } from './wettarena.ts'
import { interwetten } from './interwetten.ts'
import { betway } from './betway.ts'
import { neobet } from './neobet.ts'
import { daznbet } from './openbet.ts'
import { sport888de } from './spectate.ts'
import { admiralbet } from './admiralbet.ts'

/**
 * Registry der aktiven Anbieter.
 *
 * Vier Transportwege, weil die Anbieter unterschiedlich gebaut sind:
 *   HTTP        — die Mehrheit, teils mit TLS-Nachbildung (`impit`)
 *   WebSocket   — BetConstruct-Swarm (VBET), siehe `server/ws.ts`
 *   LiveDoc     — STOMP über SockJS (DAZN Bet), siehe `server/livedoc.ts`
 *   Sitzung     — Spectate (888sport), Kekse plus Bootstrap-Aufruf
 *
 * Plattform-Adapter decken je mehrere Marken ab:
 *   bwin.ts     (Entain)  → bwin, Sportingbet, ODDSET
 *   kambi.ts    (Kambi)   → LeoVegas
 *   openbet.ts  (OpenBet) → DAZN Bet
 *   spectate.ts (Spectate)→ 888sport
 * Das ist der Hebel: nicht ein Adapter je Marke, sondern einer je Plattform.
 *
 * ## Bewusst nicht aktiv: `sport888` (888sport Italien)
 *
 * `kambi.ts` exportiert zusätzlich die italienische 888-Marke. Sie ist
 * angebunden und funktioniert — sie steht hier trotzdem nicht drin.
 *
 * Der Grund ist nicht technisch. `sport.888casino.it` beantwortet von einer
 * deutschen Leitung jeden Wettpfad mit HTTP 404; ein Bein dort ist **nicht
 * setzbar**. Eine Arbitrage, die darüber läuft, ist damit keine schwächere
 * Arbitrage, sondern eine falsche Meldung. Und weil die Trefferliste endlich
 * ist, verdrängen solche Meldungen echte.
 *
 * Die Marke brächte 195 zusätzlich vergleichbare Partien und alle Märkte statt
 * nur der Siegwette — deutlich mehr als das deutsche Buch. Vergleichsfläche
 * ohne Setzbarkeit ist für einen Scanner aber kein Gewinn.
 *
 * Wer sie trotzdem will (etwa zum Beobachten von Quotenbewegungen), ergänzt
 * den Import um `sport888` und hängt ihn in die Liste. Der Anzeigename trägt
 * bereits den Zusatz „(IT)", damit der Unterschied an jedem Bein sichtbar ist.
 */
export const ADAPTERS: BookmakerAdapter[] = [
  tipico,
  betano,
  bwin,
  sportingbet,
  oddset,
  leovegas,
  winamax,
  sportwettende,
  vbet,
  wettarena,
  interwetten,
  betway,
  neobet,
  daznbet,
  sport888de,
  admiralbet,
]

export const ADAPTER_BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]))
