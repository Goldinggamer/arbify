import type { Bookmaker } from '../types'

/**
 * In Deutschland lizenzierte Sportwettenanbieter (Whitelist der GGL).
 * `licensedSince` = Datum der Lizenzerteilung.
 */
export const BOOKMAKERS: Bookmaker[] = [
  { id: 'bet365', name: 'bet365', short: 'b365', color: '#027B5B', fg: '#FFE04B', licensedSince: '2020-10-09', url: 'https://www.bet365.de', oneClick: true, bestForLive: true, popular: true },
  { id: 'merkurbets', name: 'MERKUR BETS', short: 'MB', color: '#E30613', licensedSince: '2020-10-09', url: 'https://www.merkurbets.de' },
  { id: 'interwetten', name: 'Interwetten', short: 'IW', color: '#00693E', licensedSince: '2020-11-02', url: 'https://www.interwetten.com/de', popular: true },
  { id: 'betathome', name: 'bet-at-home', short: 'BAH', color: '#D9251C', licensedSince: '2020-11-02', url: 'https://www.bet-at-home.de' },
  { id: 'winamax', name: 'Winamax', short: 'WMX', color: '#E8112D', licensedSince: '2021-06-29', url: 'https://www.winamax.de', oneClick: true, popular: true },
  { id: 'bwin', name: 'bwin', short: 'bw', color: '#111C2E', fg: '#FFDD00', licensedSince: '2022-11-14', url: 'https://sports.bwin.de', bestForLive: true, popular: true },
  { id: 'betano', name: 'Betano', short: 'BT', color: '#FF4E00', licensedSince: '2021-02-19', url: 'https://www.betano.de', oneClick: true, popular: true },
  { id: 'neobet', name: 'NEO.bet', short: 'NEO', color: '#7B2FF7', licensedSince: '2020-10-09', url: 'https://neo.bet' },
  { id: 'admiralbet', name: 'AdmiralBet', short: 'AB', color: '#1B3C87', licensedSince: '2020-10-09', url: 'https://www.admiralbet.de' },
  { id: 'sportwettende', name: 'Sportwetten.de', short: 'SW', color: '#009EE0', licensedSince: '2020-11-19', url: 'https://www.sportwetten.de' },
  { id: 'betway', name: 'Betway', short: 'BW', color: '#00A826', licensedSince: '2021-03-09', url: 'https://betway.de', bestForLive: true },
  { id: 'oddset', name: 'ODDSET', short: 'ODS', color: '#E2001A', licensedSince: '2020-11-18', url: 'https://www.oddset.de' },
  { id: 'daznbet', name: 'DAZN Bet', short: 'DZN', color: '#F8F800', fg: '#111111', licensedSince: '2023-08-22', url: 'https://www.daznbet.com/de' },
  { id: 'wettarena', name: 'WettArena', short: 'WA', color: '#0B7A3B', licensedSince: '2020-10-09', url: 'https://www.wettarena.de' },
  { id: 'intertops', name: 'Intertops', short: 'IT', color: '#003A70', licensedSince: '2022-12-28', url: 'https://www.intertops.de' },
  { id: 'leovegas', name: 'LeoVegas', short: 'LV', color: '#F5A623', fg: '#111111', licensedSince: '2024-10-21', url: 'https://www.leovegas.de' },
  { id: 'vbet', name: 'VBET', short: 'VB', color: '#0D5EF4', licensedSince: '2023-12-05', url: 'https://www.vbet.de' },
  { id: 'sportingbet', name: 'Sportingbet', short: 'SB', color: '#0A2240', fg: '#F5B927', licensedSince: '2022-12-21', url: 'https://sports.sportingbet.de' },
  { id: 'tipico', name: 'Tipico', short: 'TP', color: '#D2001E', licensedSince: '2020-10-09', url: 'https://sports.tipico.de', oneClick: true, bestForLive: true, popular: true },
  { id: 'tipwin', name: 'Tipwin', short: 'TW', color: '#004A99', licensedSince: '2020-10-09', url: 'https://www.tipwin.de' },
  { id: 'tiptorro', name: 'Tiptorro', short: 'TT', color: '#F07C00', licensedSince: '2021-06-30', url: 'https://www.tiptorro.com' },
  { id: 'happybet', name: 'HAPPYBET', short: 'HB', color: '#00B5AD', licensedSince: '2020-10-09', url: 'https://www.happybet.de' },
  { id: '888sport', name: '888sport', short: '888', color: '#F26522', licensedSince: '2021-01-01', url: 'https://www.888sport.de', bestForLive: true },
]

export const BOOKMAKER_BY_ID: Record<string, Bookmaker> = Object.fromEntries(
  BOOKMAKERS.map((b) => [b.id, b]),
)

export const SPORTS = ['Fußball', 'Basketball', 'Tennis', 'Eishockey', 'Handball'] as const
