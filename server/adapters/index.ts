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
 * Registry der aktiven Anbieter. Ein Adapter je Plattform, nicht je Marke:
 * `bwin.ts` deckt bwin, Sportingbet und ODDSET ab. Transportwege und
 * Eigenheiten: docs/datenbeschaffung.md.
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
