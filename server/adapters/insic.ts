import { fetchJson } from '../http.ts'
import type { CanonicalMarket, Period, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'
import { noteUnmapped } from '../diagnostics.ts'

/**
 * INSIC-Plattform — bei Sportwetten.de im Einsatz.
 *
 * Der angenehmste Datensatz im ganzen Projekt: eine einzige Antwort enthält
 * Events, Märkte, Quoten und den Kategoriebaum, alles sauber typisiert
 * (`3WAY`, `OVER_UNDER`, `TOTALS_HOME_TEAM`, …) — kein Raten über deutsche
 * Marktnamen nötig. Und es gibt `betradar_id`, also die Sportradar-Match-ID
 * für den exakten Join.
 *
 * Der Adapter ist über `base` parametrisiert; andere INSIC-Mandanten lassen
 * sich damit ergänzen, sobald ihre Hosts bekannt sind.
 */

const OPTS = { transport: 'impit' as const, minIntervalMs: 200 }
const PAGE_ROWS = 200

/**
 * Sortierung der Ereignisliste — **stabil**, nicht nach Beliebtheit.
 *
 * Hier stand `sportsStandard`. Das ist die Reihenfolge der Website und
 * bewegt sich mit den Quoten; die Blätterung über `offset` greift damit in
 * eine Liste, die sich unter ihr verschiebt. Nachgemessen an einem
 * vollständigen Durchlauf über 1.725 Partien:
 *
 *   sportsStandard   1.725 geliefert, 1.703 eindeutig  →  22 doppelt, 22 fehlend
 *   id               1.725 geliefert, 1.725 eindeutig  →   0 doppelt,  0 fehlend
 *
 * Die Dopplungen waren sichtbar — sie standen als Kollisionen in der
 * Diagnose. Die **22 fehlenden Partien** waren es nicht: ein Event, das
 * zwischen zwei Seitenabrufen nach hinten rutscht, wird schlicht übersprungen
 * und taucht nirgends als Verlust auf.
 */
const SORT = 'id'

type Tenant = { id: string; name: string; base: string; web: string }

type InsicEvent = {
  label?: string
  label_de?: string
  category_id?: string
  expires_ts?: number
  betradar_id?: string
  live_status?: string
  event_code?: string
  markets?: string[]
}

type InsicMarket = {
  type?: string
  label?: string
  period?: string
  special_value?: string
  predictions?: string[]
  trading_status?: string
}

type InsicPrediction = {
  odds?: string
  label?: string
  label_short?: string
  type?: string
}

type InsicResponse = {
  events?: Record<string, InsicEvent>
  markets?: Record<string, InsicMarket>
  predictions?: Record<string, InsicPrediction>
  categories?: Record<string, { path?: string; label?: string }>
  pagination?: { registers?: number; offset?: number; rows?: number }
}

const num = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/**
 * Die Periode steht nicht verlässlich im `period`-Feld — dort bedeutet "1"
 * das gesamte Spiel und nicht die erste Halbzeit. Die Beschriftung ist
 * eindeutig, aber **nicht einheitlich**: derselbe Anbieter schreibt mal
 * „1. Halbzeit Über/Unter", mal „1. HZ Heimteam Über/Unter".
 *
 * Die Kurzform zu übersehen war teuer. `TOTALS_HOME_TEAM` und
 * `TOTALS_AWAY_TEAM` benutzen ausschließlich „1. HZ" — 1.467 Märkte, die
 * damit als Gesamtspiel durchgingen und im Bestand auf denselben Schlüssel
 * fielen wie die echten Ganzspiel-Märkte. Weil die Auswertung je Seite die
 * höchste Quote nimmt, gewann dort regelmäßig das Halbzeit-Über (Über 0,5
 * Gastteam: 3,00 in der Halbzeit gegen 1,75 im ganzen Spiel) und wurde gegen
 * das Ganzspiel-Unter eines anderen Buchs gerechnet. Das ergab implizite
 * Summen von 66–90 % — die vermeintlichen „Phantom-Arbitragen" bei
 * Team-Über/Unter, wegen derer die Familie vom Vergleich ausgeschlossen war.
 */
function periodOf(label: string): Period {
  const l = label.toLowerCase()
  if (/1\.\s*(halbzeit|hälfte|hz)\b/.test(l)) return 'H1'
  if (/2\.\s*(halbzeit|hälfte|hz)\b/.test(l)) return 'H2'
  return 'FT'
}

/** "0:1" → −1 aus Heimsicht. */
function handicapOf(special: string | undefined): number | null {
  const m = /^(-?[\d.]+)\s*:\s*(-?[\d.]+)$/.exec(special ?? '')
  if (!m) return null
  return Number(m[1]) - Number(m[2])
}

/**
 * Tennis-Markttypen.
 *
 * Der angenehmste Teil des Anbieters: die Typen sind ausgeschrieben und
 * trennen von sich aus, was anderswo verwechselbar ist — `TOTAL_SETS` gegen
 * `TOTAL_GAMES`, `POINTS_SPREADS_SETS` gegen `POINTS_SPREADS_GAMES`. Die
 * Satznummer steht bei `SET` im `special_value`, nicht im Label.
 */
function toTennisMarket(m: InsicMarket): CanonicalMarket | null {
  const type = (m.type ?? '').toUpperCase()
  const spec = m.special_value ?? ''
  const line = num(spec)

  /** "1.5:0" → 1.5 aus Heimsicht; dieselbe Schreibweise wie beim Fußball-Handicap. */
  const spread = (): number | null => {
    const h = /^(-?[\d.]+)\s*:\s*(-?[\d.]+)$/.exec(spec)
    return h ? Number(h[1]) - Number(h[2]) : line
  }

  switch (type) {
    // Matchsieger. Zweiseitig — Tennis kennt kein Unentschieden, und ein
    // `1X2` hier hätte über `SIDES` eine dritte Seite verlangt, die es nie
    // gibt: der Markt wäre nie vollständig geworden und stillschweigend
    // aus jeder Auswertung gefallen.
    case '2WAY':
    case 'MATCH_WINNER':
      return { type: '2WAY', period: 'FT', line: null, subject: null }

    // Satzsieger. `special_value` trägt die Satznummer.
    case 'SET': {
      const n = Number(spec)
      if (!Number.isInteger(n) || n < 1 || n > 5) return null
      return { type: '2WAY', period: `S${n}` as CanonicalMarket['period'], line: null, subject: null }
    }

    case 'TOTAL_SETS':
      return line === null ? null : { type: 'OU', period: 'FT', line, subject: null, unit: 'SETS' }
    case 'TOTAL_GAMES':
    case 'TOTAL_GAMES_MATCH':
      return line === null ? null : { type: 'OU', period: 'FT', line, subject: null, unit: 'GAMES' }

    case 'POINTS_SPREADS_SETS': {
      const l = spread()
      return l === null ? null : { type: 'AH', period: 'FT', line: l, subject: null, unit: 'SETS' }
    }
    case 'POINTS_SPREADS_GAMES':
    case 'GAMES_HANDICAP': {
      const l = spread()
      return l === null ? null : { type: 'AH', period: 'FT', line: l, subject: null, unit: 'GAMES' }
    }

    default:
      // Ergebniswetten über Sätze haben zu viele Seiten, Aufschlag- und
      // Punktwetten einen anderen Gegenstand.
      if (!/CORRECT_\dSET_SCORE|CORRECT_SET|TIE_?BREAK|SERVICE|ACES|DOUBLE_FAULT|POINT|GAME_WINNER|OUTRIGHT|WINNER_CHAMPIONSHIP/.test(type))
        noteUnmapped('insic', `TENNIS ${type} | ${m.label ?? ''}`)
      return null
  }
}

function toMarket(m: InsicMarket, sport: Sport = 'FOOTBALL'): CanonicalMarket | null {
  if (sport === 'TENNIS') return toTennisMarket(m)

  const type = (m.type ?? '').toUpperCase()
  const label = m.label ?? ''
  const period = periodOf(label)
  const line = num(m.special_value)

  switch (type) {
    case '3WAY':
    case 'THREE_WAY_PERIOD':
    // „1. Halbzeit" — die Siegwette der ersten Hälfte, gleiche Seiten.
    case 'FIRST_HALFTIME':
      return { type: '1X2', period, line: null, subject: null }

    case 'OVER_UNDER':
    // Eigener Typ, aber dieselbe Struktur; die Halbzeit steht in der
    // Beschriftung und wird von `periodOf` gelesen.
    case 'OVER_UNDER_FIRST_HALF':
      return line === null ? null : { type: 'OU', period, line, subject: null }

    case 'TOTALS_HOME_TEAM':
      return line === null ? null : { type: 'TEAM_OU', period, line, subject: 'HOME' }

    case 'TOTALS_AWAY_TEAM':
      return line === null ? null : { type: 'TEAM_OU', period, line, subject: 'AWAY' }

    case 'EUROPEAN_HANDICAP':
    case 'EUROPEAN_HANDICAP_HT': {
      const h = handicapOf(m.special_value)
      return h === null ? null : { type: 'EH', period, line: h, subject: null }
    }

    case 'GOAL_NO_GOAL':
    case 'GOAL_NO_GOAL_HT':
    case 'BOTH_TEAMS_TO_SCORE':
      return { type: 'BTTS', period, line: null, subject: null }

    case 'ODD_EVEN':
    case 'EVEN_ODD':
    case 'TOTAL_GOALS_ODD_EVEN':
    case 'ODD_EVEN_GOALS':
      return { type: 'OE', period, line: null, subject: null }

    default:
      // Kombinationswetten und Sonderwetten sind bewusst nicht im Modell.
      // `HALFTIME_FULLTIME` steht bewusst neben `HALF_TIME`: Insic schreibt
      // den Typ hier ohne Unterstrich, das ältere Muster griff nicht.
      if (
        !/DOUBLE_CHANCE|CORRECT_SCORE|HALF_TIME|HALFTIME_FULLTIME|SCORER|AGGREGATED|_GOAL_NO_GOAL|OUTRIGHT|RACE_TO|WINNING_MARGIN|WINNING_METHOD|FIRST_|LAST_|DRAW_NO_BET|XTH_GOAL|GOALS_HOME_TEAM|GOALS_AWAY_TEAM|HIGHEST_SCORING_HALF|3WAY_OVER_UNDER|REST_OF_MATCH|TO_QUALIFY|EXACT_NUMBER/.test(
          type,
        )
      )
        noteUnmapped('insic', `${type} | ${label}`)
      return null
  }
}

function toSide(p: InsicPrediction, market: CanonicalMarket): Side | null {
  const t = (p.type ?? '').toUpperCase()
  const short = (p.label_short ?? '').trim().toLowerCase()
  const label = (p.label ?? '').trim().toLowerCase()

  if (market.type === '1X2' || market.type === 'EH' || market.type === '2WAY' || market.type === 'AH') {
    if (t === 'HOME' || short === '1') return 'HOME'
    if (t === 'DRAW' || short === 'x') return 'DRAW'
    if (t === 'VISITOR' || t === 'AWAY' || short === '2') return 'AWAY'
    return null
  }
  if (market.type === 'OU' || market.type === 'TEAM_OU') {
    if (t === 'OVER' || label.startsWith('über')) return 'OVER'
    if (t === 'UNDER' || label.startsWith('unter')) return 'UNDER'
    return null
  }
  if (market.type === 'BTTS') {
    if (t === 'YES' || label === 'ja') return 'YES'
    if (t === 'NO' || label === 'nein') return 'NO'
    return null
  }
  if (market.type === 'OE') {
    if (label.startsWith('ungerade') || t === 'ODD') return 'ODD'
    if (label.startsWith('gerade') || t === 'EVEN') return 'EVEN'
    return null
  }
  return null
}

function makeAdapter(tenant: Tenant): BookmakerAdapter {
  return {
    id: tenant.id,
    name: tenant.name,
    transport: 'impit',

    async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
      const cutoff = Date.now() + ctx.windowMs
      const out: RawEvent[] = []
      /**
       * Bereits gelieferte Event-IDs.
       *
       * Zweite Sicherung hinter der stabilen Sortierung: jede Blätterung über
       * `offset` läuft über eine Liste, die sich zwischen zwei Abrufen ändern
       * kann. Ein doppelt geliefertes Event legt in `server/scan.ts` zwei
       * Quoten auf dieselbe Seite desselben Schlüssels — genau die Dopplung,
       * die dort als Kollision gemeldet wird.
       */
      const gesehen = new Set<string>()
      let offset = 0
      let total = Infinity

      while (offset < total && out.length < ctx.maxEvents) {
        let res: InsicResponse
        try {
          res = await fetchJson<InsicResponse>(
            `${tenant.base}/de/v1/events?sportsbook_id=0&offset=${offset}&rows=${PAGE_ROWS}&sort=${SORT}`,
            OPTS,
          )
        } catch (e) {
          // Eine Seite, die auch nach den Wiederholungen nicht kommt, kostet
          // ihre ~200 Zeilen — nicht den ganzen Buchmacher. Nur wenn schon die
          // erste Seite fehlt, gibt es nichts zu retten und der Fehler zählt.
          if (!out.length) throw e
          break
        }
        total = res.pagination?.registers ?? 0
        const events = Object.entries(res.events ?? {})
        if (!events.length) break

        for (const [eventId, e] of events) {
          if (gesehen.has(eventId)) continue
          gesehen.add(eventId)
          const path = res.categories?.[String(e.category_id)]?.path ?? ''
          // Die Antwort enthält alle Sportarten in einem Strom; Fußball steht
          // vorn, Tennis beginnt erst ab etwa offset 600. Beide werden
          // übernommen, alles andere übersprungen.
          const head = path.toLowerCase()
          const sport: Sport | null = head.startsWith('fußball')
            ? 'FOOTBALL'
            : head.startsWith('tennis')
              ? 'TENNIS'
              : null
          if (!sport) continue
          if (!e.expires_ts || e.expires_ts * 1000 > cutoff) continue

          const title = e.label_de ?? e.label ?? ''
          const [home, away] = title.split(' - ')
          if (!home?.trim() || !away?.trim()) continue

          const outcomes: RawOutcome[] = []
          for (const marketId of e.markets ?? []) {
            const m = res.markets?.[marketId]
            if (!m || m.trading_status === 'Suspended') continue
            const market = toMarket(m, sport)
            if (!market) continue
            for (const pid of m.predictions ?? []) {
              const p = res.predictions?.[pid]
              const odds = num(p?.odds)
              if (!p || odds === null || odds <= 1) continue
              const side = toSide(p, market)
              if (side) outcomes.push({ market, side, odds })
            }
          }
          if (!outcomes.length) continue

          out.push({
            bookmakerId: tenant.id,
            bookEventId: eventId,
            sportradarId: e.betradar_id ? Number(e.betradar_id) || null : null,
            sport: SPORT_LABEL[sport],
            // "Fußball / Deutschland / 1. Bundesliga" → "Deutschland — 1. Bundesliga"
            league: path.split('/').slice(1).map((s) => s.trim()).filter(Boolean).join(' — ') || 'Unbekannt',
            home: home.trim(),
            away: away.trim(),
            startTime: new Date(e.expires_ts * 1000).toISOString(),
            isLive: e.live_status === 'enabled',
            // Die Website öffnet eine Partie über `/?events={id}` — dieselbe
            // Kennung wie im Eventservice. Der frühere Link auf `/wetten` war
            // eine 404-Seite.
            url: `${tenant.web}/?events=${eventId}`,
            outcomes,
            fetchedAt: new Date().toISOString(),
          })
        }
        offset += PAGE_ROWS
      }
      return out.slice(0, ctx.maxEvents)
    },
  }
}

export const sportwettende = makeAdapter({
  id: 'sportwettende',
  name: 'Sportwetten.de',
  base: 'https://eventservice.sportwetten.de',
  web: 'https://www.sportwetten.de',
})
