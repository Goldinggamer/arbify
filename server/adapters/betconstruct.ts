import { RpcSocket } from '../ws.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'

/**
 * BetConstruct ("swarm") — bei VBET im Einsatz.
 *
 * Der erste Anbieter, der über die WebSocket-Schicht läuft: HTTP-Abrufe
 * liefern hier grundsätzlich keine Quoten. Der Ablauf ist
 *
 *   1. Verbindung zu `wss://eu-swarm-*.betconstruct.com/`
 *   2. `request_session` mit der Site-ID der Marke
 *   3. `get` mit einer Feldauswahl — man beschreibt in `what`, welche Felder
 *      man je Ebene haben will, und filtert in `where`
 *
 * Die Antwort ist ein verschachtelter Baum
 * sport → region → competition → game → market → event, jeweils als Objekt
 * mit ID als Schlüssel. Markttypen sind sauber kodiert (`P1XP2`,
 * `OverUnder`, `Team1OverUnder`), Quoten stehen als `event.price`.
 *
 * Wie bei Winamax gilt: ganzzahlige Linien (`base=3`) bedeuten Einsatzrückgabe
 * beim exakten Ergebnis. Sie werden trotzdem übernommen und in `server/scan.ts`
 * als Push-Linien geführt — siehe dort. Der frühere `isHalfLine`-Filter warf
 * hier allein rund 2.500 Märkte je Durchlauf weg (Linie 1: 1.249×, Linie 2:
 * 697×, Linie 3: 379×), und weil AdmiralBet dieselben Linien behielt, standen
 * sie einander gegenüber, ohne je verglichen zu werden.
 */

/** BetConstruct-Sportkennungen: 1 ist Fußball, 4 ist Tennis. */
const SPORTS: { id: number; sport: Sport }[] = [
  { id: 1, sport: 'FOOTBALL' },
  { id: 4, sport: 'TENNIS' },
]

type Brand = {
  id: string
  name: string
  siteId: number
  url: string
  /** Swarm-Knoten; die Marken sind auf mehrere verteilt. */
  wsUrl: string
}

type BcEvent = { id?: number; name?: string; price?: number; type?: string; base?: number | null }
type BcMarket = {
  id?: number
  name?: string
  type?: string
  base?: number | null
  group_name?: string
  event?: Record<string, BcEvent>
}
type BcGame = {
  id?: number
  team1_name?: string
  team2_name?: string
  start_ts?: number
  is_live?: number
  market?: Record<string, BcMarket>
}
type BcCompetition = { id?: number; name?: string; game?: Record<string, BcGame> }
/** `alias` ist der URL-Baustein der Website ("Soccer", "England"), nicht der Anzeigename. */
type BcRegion = { id?: number; name?: string; alias?: string; competition?: Record<string, BcCompetition> }
type BcSport = { id?: number; name?: string; alias?: string; region?: Record<string, BcRegion> }

function periodOf(type: string, name: string): Period {
  const s = `${type} ${name}`.toLowerCase()
  if (s.includes('halftime') || s.includes('1. halbzeit')) return 'H1'
  if (s.includes('secondhalf') || s.includes('2. halbzeit')) return 'H2'
  return 'FT'
}

/**
 * Handicap-Linie aus Heimsicht.
 *
 * BetConstruct legt die Linie **pro Outcome** ab, nicht im Markt: bei einem
 * Heim-Handicap steht am Markt `base=1`, am Heim-Outcome aber `base=-1` und
 * am Auswärts-Outcome `base=+1`. Wer `market.base` nimmt, dreht das
 * Vorzeichen um und vergleicht anschließend ein Heim-Handicap gegen ein
 * Auswärts-Handicap — genau daraus entstand eine vorgetäuschte Arbitrage von
 * angeblich 11 %.
 */
function handicapLine(m: BcMarket): number | null {
  const home = Object.values(m.event ?? {}).find((e) => e.type === 'Home' || e.type === 'P1')
  const base = typeof home?.base === 'number' ? home.base : null
  return base ?? (typeof m.base === 'number' ? -m.base : null)
}

/**
 * Tennis-Markttypen.
 *
 * Zwei davon heißen genauso wie im Fußball und bedeuten etwas anderes:
 *
 *   `Handicap`  Fußball → dreiwegiges Tore-Handicap
 *               Tennis  → zweiwegiges **Spiele**-Handicap ("Games Handicap")
 *
 * Ein gemeinsamer Zweig wäre also nicht bloß unsauber, sondern falsch — das
 * Tennis-Handicap hat keine Unentschieden-Seite und zählt in Spielen, nicht in
 * Toren. Daneben führt VBET `Sets Handicap` mit derselben Struktur und einer
 * anderen Einheit; ohne `unit` im Schlüssel fielen beide zusammen.
 */
export function toTennisMarket(m: BcMarket, bookId: string): CanonicalMarket | null {
  const type = m.type ?? ''
  const name = m.name ?? ''
  const base = typeof m.base === 'number' ? m.base : null

  switch (type) {
    case 'P1P2':
      return { type: '2WAY', period: 'FT', line: null, subject: null }

    // "1. Satz: Sieger" — die Satznummer steht nur im Marktnamen.
    case 'SetWinner': {
      const n = /(\d)\.\s*satz/i.exec(name)?.[1]
      return n ? { type: '2WAY', period: `S${n}` as CanonicalMarket['period'], line: null, subject: null } : null
    }

    case 'Handicap': {
      const line = handicapLine(m)
      return line === null ? null : { type: 'AH', period: 'FT', line, subject: null, unit: 'GAMES' }
    }
    case 'Sets Handicap':
    case 'SetsHandicap': {
      const line = handicapLine(m)
      return line === null ? null : { type: 'AH', period: 'FT', line, subject: null, unit: 'SETS' }
    }

    case 'TotalofSets':
    case 'TotalSets':
      return base === null ? null : { type: 'OU', period: 'FT', line: base, subject: null, unit: 'SETS' }
    case 'TotalGames':
    case 'TotalofGames':
      return base === null ? null : { type: 'OU', period: 'FT', line: base, subject: null, unit: 'GAMES' }

    default:
      // Bekannt und bewusst draußen: `ThreeBet` ist die Satzwette (genaues
      // Ergebnis, vier Seiten), `1stSet-Match` eine Kombiwette, `Winner` die
      // Turnierwette mit dutzenden Teilnehmern, Tie-Breaks und Aufschläge
      // haben einen anderen Gegenstand.
      if (
        !/^(ThreeBet|SetBetting|1stSet-Match|Winner|Outright|TotalTieBreaks|TieBreak|Ace|DoubleFault|CorrectScore|ToWin|Qualify|Player|Point|Game[A-Z])/i.test(
          type,
        )
      )
        noteUnmapped(bookId, `TENNIS ${type} | ${name}`)
      return null
  }
}

export function toMarket(m: BcMarket, bookId: string): CanonicalMarket | null {
  const type = m.type ?? ''
  const name = m.name ?? ''
  const period = periodOf(type, name)
  const base = typeof m.base === 'number' ? m.base : null

  switch (type) {
    case 'P1XP2':
      return { type: '1X2', period: 'FT', line: null, subject: null }
    case 'HalfTimeResult':
    case 'FirstHalfP1XP2':
      return { type: '1X2', period: 'H1', line: null, subject: null }
    case 'SecondHalfResult':
      return { type: '1X2', period: 'H2', line: null, subject: null }

    case 'OverUnder':
      return base === null ? null : { type: 'OU', period, line: base, subject: null }
    case 'HalfTimeOverUnder':
      return base === null ? null : { type: 'OU', period: 'H1', line: base, subject: null }
    case 'SecondHalfOverUnder':
    case '2ndHalfTotalOver/Under':
      return base === null ? null : { type: 'OU', period: 'H2', line: base, subject: null }

    // Team-Totals: die Periode steckt im Typnamen, nicht im Marktnamen.
    case 'Team1OverUnder':
      return base === null ? null : { type: 'TEAM_OU', period, line: base, subject: 'HOME' }
    case 'Team2OverUnder':
      return base === null ? null : { type: 'TEAM_OU', period, line: base, subject: 'AWAY' }
    case 'HalfTimeTeam1OverUnder':
      return base === null ? null : { type: 'TEAM_OU', period: 'H1', line: base, subject: 'HOME' }
    case 'HalfTimeTeam2OverUnder':
      return base === null ? null : { type: 'TEAM_OU', period: 'H1', line: base, subject: 'AWAY' }
    case 'SecondHalfHomeTeamTotalGoalsOverUnder':
      return base === null ? null : { type: 'TEAM_OU', period: 'H2', line: base, subject: 'HOME' }
    case 'SecondHalfAwayTeamTotalGoalsOverUnder':
      return base === null ? null : { type: 'TEAM_OU', period: 'H2', line: base, subject: 'AWAY' }

    case 'BothTeamsToScore':
    case 'BothTeamsScore':
      return { type: 'BTTS', period, line: null, subject: null }

    // Die Periode steckt im Typnamen; `periodOf` würde sie hier nur über den
    // **deutschen** Marktnamen finden. Ausdrücklich setzen, damit die
    // Zuordnung nicht an der Sprache der Sitzung hängt.
    case '1stHalfBothTeamsToScore':
      return { type: 'BTTS', period: 'H1', line: null, subject: null }
    case '2ndHalfBothTeamsToScore':
      return { type: 'BTTS', period: 'H2', line: null, subject: null }

    case 'TotalEvenOdd':
    case 'EvenOdd':
    case 'EvenOddTotal':
      return { type: 'OE', period, line: null, subject: null }

    case 'Handicap':
    case 'EuropeanHandicap': {
      const line = handicapLine(m)
      return line === null ? null : { type: 'EH', period, line, subject: null }
    }

    // Drei-Wege-Handicap der ersten Hälfte ("1. Halbzeit: Tore Handicap
    // (3-Wege)"). Fehlt die Unentschieden-Seite, bleibt der Markt
    // unvollständig und fällt in `scanForArbitrage` heraus — nicht hier.
    case 'FirstHalfHandicap': {
      const line = handicapLine(m)
      return line === null ? null : { type: 'EH', period: 'H1', line, subject: null }
    }

    default:
      // Doppelte Chance, genaues Ergebnis, Spielerwetten und asiatische
      // Linien sind bewusst nicht im Modell.
      //
      // `Team1ScoreYes/no` ("Team 1 trifft") steht ausdrücklich **nicht** im
      // Modell, obwohl es dasselbe wie ein Team-Total über 0,5 ist. Es war
      // zugeordnet und wurde zurückgenommen: VBET liefert **beide** Formen für
      // dieselbe Partie, `Team1OverUnder` mit `base=0.5` und diese hier. Beide
      // fallen auf denselben Schlüssel, und damit gab derselbe Buchmacher zwei
      // Quoten für dieselbe Seite — gemessen 80 bzw. 96 Kollisionen je Lauf.
      // Neue Vergleichsfläche entsteht dabei keine, der Schlüssel existiert
      // schon; verloren geht aber die Aussagekraft der Kollisionszählung, und
      // die ist das Instrument, mit dem echte Schlüsselkollisionen auffallen.
      // Bei Tipico ist die Lage anders — dort gibt es die Über/Unter-Form auf
      // 0,5 nicht, deshalb ist sie da zugeordnet (siehe `team-scores`).
      if (
        !/DoubleChance|CorrectScore|HalfTimeFullTime|Asian|Player|Scorer|Corner|Card|Winner|Outright|DrawNoBet|RaceTo|Margin|MatchOutcomeAnd|AndTotal|BothTeamsAnd|MultiGoalInterval|Exact|InBothHalves|BothInHalves|GoalsInBoth|ToWinToNil|ToWinatLeast|ToScore|ScoreYes|Qualify|penalt|Combination|Outcomeand|OutcomeAnd|EP$/i.test(
          type,
        )
      )
        noteUnmapped(bookId, `${type} | ${name}`)
      return null
  }
}

function toSide(e: BcEvent, market: CanonicalMarket): Side | null {
  const t = (e.type ?? '').trim()
  if (market.type === '1X2' || market.type === 'EH' || market.type === '2WAY' || market.type === 'AH') {
    // Die Siegwette nutzt P1/X/P2, das Handicap dagegen Home/Tie/Away.
    // Fehlt "Tie", bleibt das Handicap unvollständig und fällt entweder
    // ganz weg oder — schlimmer — geht mit zwei von drei Seiten durch.
    if (t === 'P1' || t === 'W1' || t === 'Home') return 'HOME'
    if (t === 'X' || t === 'Draw' || t === 'Tie') return 'DRAW'
    if (t === 'P2' || t === 'W2' || t === 'Away') return 'AWAY'
    return null
  }
  if (market.type === 'OU' || market.type === 'TEAM_OU') {
    if (t === 'Over') return 'OVER'
    if (t === 'Under') return 'UNDER'
    return null
  }
  if (market.type === 'BTTS') {
    if (t === 'Yes') return 'YES'
    if (t === 'No') return 'NO'
    return null
  }
  if (market.type === 'OE') {
    if (t === 'Odd') return 'ODD'
    if (t === 'Even') return 'EVEN'
    return null
  }
  return null
}

/**
 * Tiefenlink auf die Partie.
 *
 * Die Website adressiert Partien als
 * `/sport-wetten/match/{Sport-Alias}/{Region-Alias}/{Wettbewerb}/{Partie}` —
 * abgelesen aus den Links der Seite selbst, z.B.
 * `/sport-wetten/match/Soccer/England/538/30722944`. Fehlt ein Baustein,
 * bleibt es beim Sportprogramm; ein halber Pfad landet sonst auf 404.
 */
function eventUrl(base: string, sport: BcSport, region: BcRegion, comp: BcCompetition, game: BcGame): string {
  if (!sport.alias || !region.alias || comp.id == null || game.id == null) return `${base}/sport-wetten`
  return `${base}/sport-wetten/match/${sport.alias}/${region.alias}/${comp.id}/${game.id}`
}

function makeAdapter(brand: Brand): BookmakerAdapter {
  const socket = new RpcSocket({
    url: brand.wsUrl,
    handshake: () => ({
      command: 'request_session',
      params: { language: 'ger', site_id: brand.siteId, source: 42 },
    }),
    handshakeOk: (msg) => msg?.code === 0 && !!msg?.data?.sid,
    timeoutMs: 20_000,
  })

  return {
    id: brand.id,
    name: brand.name,
    transport: 'websocket',

    async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
      const now = Math.floor(Date.now() / 1000)
      const until = now + Math.floor(ctx.windowMs / 1000)

      const res = await socket.request<{ code?: number; data?: { data?: { sport?: Record<string, BcSport> } } }>({
        command: 'get',
        params: {
          source: 'betting',
          what: {
            sport: ['id', 'name', 'alias'],
            region: ['id', 'name', 'alias'],
            competition: ['id', 'name'],
            game: ['id', 'team1_name', 'team2_name', 'start_ts', 'is_live'],
            market: ['id', 'name', 'type', 'base', 'group_name'],
            event: ['id', 'name', 'price', 'type', 'base'],
          },
          where: {
            // sport 1 ist Fußball, 4 ist Tennis; das Zeitfenster wird
            // serverseitig gefiltert, damit nicht das gesamte Programm über
            // die Leitung geht.
            sport: { id: { '@in': SPORTS.map((s) => s.id) } },
            game: { start_ts: { '@gte': now - 3 * 3600, '@lte': until } },
          },
        },
      })

      if (res?.code !== 0) throw new Error(`swarm-Antwortcode ${res?.code}`)

      const out: RawEvent[] = []
      const fetchedAt = new Date().toISOString()

      for (const spec of SPORTS) {
      const sport = res.data?.data?.sport?.[String(spec.id)]
      if (!sport) continue

      for (const region of Object.values(sport.region ?? {})) {
        for (const comp of Object.values(region.competition ?? {})) {
          for (const game of Object.values(comp.game ?? {})) {
            const home = game.team1_name?.trim()
            const away = game.team2_name?.trim()
            if (!home || !away || !game.start_ts) continue

            const outcomes: RawOutcome[] = []
            for (const m of Object.values(game.market ?? {})) {
              const market =
                spec.sport === 'TENNIS' ? toTennisMarket(m, brand.id) : toMarket(m, brand.id)
              if (!market) continue
              for (const e of Object.values(m.event ?? {})) {
                const odds = typeof e.price === 'number' ? e.price : null
                if (odds === null || !Number.isFinite(odds) || odds <= 1) continue
                const side = toSide(e, market)
                if (side) outcomes.push({ market, side, odds })
              }
            }
            if (!outcomes.length) continue

            out.push({
              bookmakerId: brand.id,
              bookEventId: String(game.id),
              // BetConstruct liefert keine Sportradar-ID im Betting-Zweig.
              sportradarId: null,
              sport: SPORT_LABEL[spec.sport],
              league: [region.name, comp.name].filter(Boolean).join(' — '),
              home,
              away,
              startTime: new Date(game.start_ts * 1000).toISOString(),
              isLive: game.is_live === 1,
              url: eventUrl(brand.url, sport, region, comp, game),
              outcomes,
              fetchedAt,
            })
          }
        }
      }
      }
      return out.slice(0, ctx.maxEvents)
    },
  }
}

export const vbet = makeAdapter({
  id: 'vbet',
  name: 'VBET',
  siteId: 18764169,
  url: 'https://www.vbet.de',
  wsUrl: 'wss://eu-swarm-springre.betconstruct.com/',
})
