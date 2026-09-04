import { fetchText } from '../http.ts'
import { sliceJsonObject } from './html-state.ts'
import type { CanonicalMarket, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'

/**
 * Betway.
 *
 * Der SignalR-Hub der Seite existiert, führt aber keine Quoten — er ist ein
 * reiner Benutzer-Kanal (HEARTBEAT, CLIENT_INTERACTION); Quoten-Abos werden
 * mit `MessageRejected` abgelehnt. Der tragfähige Weg ist die Next.js-Seite
 * selbst: mit dem Header `RSC: 1` liefert sie statt HTML den
 * React-Server-Components-Flight-Payload, und darin stehen die Quoten als
 * JSON-Blöcke `{"events":…,"markets":…,"outcomes":…}`.
 *
 * Drei Dinge, die dabei zu beachten sind:
 *
 *  - **Cloudflare.** curl und Node-fetch werden abgewiesen; nötig ist der
 *    TLS-Fingerprint eines echten Chrome, also `impit`.
 *  - **`"$undefined"`.** Der Flight-Payload kodiert `undefined` als
 *    Zeichenkette. Wer das nicht abfängt, bekommt Quoten vom Typ String.
 *  - **Kein stabiler Vertrag.** Das ist interne Seitenmechanik, kein
 *    öffentliches API — das Format kann sich mit jedem Deploy ändern. Der
 *    Parser bleibt deshalb defensiv und liefert im Zweifel nichts statt
 *    Falsches.
 *
 * Über die Listenseiten kommt nur der Hauptmarkt (1X2); weitere Märkte
 * lägen auf den Event-Detailseiten.
 */

const HOST = 'https://betway.de'
const OPTS = {
  transport: 'impit' as const,
  minIntervalMs: 400,
  headers: { rsc: '1', accept: 'text/x-component' },
}

/**
 * Vorspiel-Kalender je Sportart und die laufenden Spiele.
 *
 * Der Live-Pfad führt alle Sportarten gemischt; welche Partie zu welcher
 * gehört, entscheidet `categoryCName` am Event, nicht der Pfad.
 */
const PAGES = [
  '/de/de/sports/cat/soccer/calendar',
  '/de/de/sports/cat/tennis/calendar',
  '/de/de/sports/live',
]

/**
 * Sportarten samt Hauptmarkt.
 *
 * Bei Tennis ist die Siegwette **zweiseitig**, und die Auswahl heißt
 * "Spieler 1" / "Spieler 2" statt "Heim" / "Auswärts" — beides muss stimmen,
 * sonst kommt entweder kein Markt oder keine Seite zustande.
 */
const SPORTS: { category: string; sport: Sport; label: string; market: CanonicalMarket }[] = [
  {
    category: 'soccer',
    sport: 'FOOTBALL',
    label: 'Fußball',
    market: { type: '1X2', period: 'FT', line: null, subject: null },
  },
  {
    category: 'tennis',
    sport: 'TENNIS',
    label: 'Tennis',
    market: { type: '2WAY', period: 'FT', line: null, subject: null },
  },
]

const SPORT_BY_CATEGORY = new Map(SPORTS.map((s) => [s.category, s]))

type BetwayEvent = {
  id?: number
  name?: string
  groupName?: string
  subcategoryName?: string
  categoryCName?: string
  startsAt?: string
  started?: boolean
  trading?: string
  suspended?: boolean
}
type BetwayMarket = {
  id?: number
  typeCName?: string
  eventId?: number
  outcomes?: number[]
  suspended?: boolean
}
type BetwayOutcome = {
  id?: number
  marketId?: number
  teamCName?: string
  name?: { coupon?: string; default?: string }
  sortIndex?: number
  oddsDecimal?: number | string
  suspended?: boolean
}
type Block = {
  events?: Record<string, BetwayEvent>
  markets?: Record<string, BetwayMarket>
  outcomes?: Record<string, BetwayOutcome>
}

/** Der Flight-Payload kodiert `undefined` als Zeichenkette. */
const clean = <T,>(v: T): T | undefined => (v === ('$undefined' as unknown) ? undefined : v)

const num = (v: unknown): number | null => {
  const c = clean(v)
  const n = typeof c === 'number' ? c : Number(String(c ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/**
 * Sammelt alle `{"events":…}`-Blöcke aus dem Flight-Payload.
 *
 * Der Payload ist kein zusammenhängendes JSON, sondern eine Folge von
 * Zeilen mit eingebetteten Objekten. Gesucht wird deshalb nach dem Marker
 * und von dort aus klammerbalanciert ausgeschnitten.
 */
function extractBlocks(payload: string): Block[] {
  const blocks: Block[] = []
  for (const m of payload.matchAll(/\{"events":\{/g)) {
    const raw = sliceJsonObject(payload, m.index ?? 0)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as Block
      if (parsed.events && parsed.outcomes) blocks.push(parsed)
    } catch {
      // Angeschnittene Blöcke gibt es; die werden übergangen.
    }
  }
  return blocks
}

/**
 * Seitenkennung eines Outcomes.
 *
 * Verlässlich ist `name.coupon` — dort steht "Heim" / "Remis" / "Auswärts".
 * `teamCName` sieht auf den ersten Blick passend aus, enthält aber je nach
 * Seite den Team-Slug ("arsenal") oder gar nichts; wer sich darauf verlässt,
 * bekommt null Treffer. `sortIndex` (1/2/3) dient als Rückfallebene.
 */
function toSide(o: BetwayOutcome): Side | null {
  const coupon = String(clean(o.name?.coupon) ?? '').toLowerCase()
  if (coupon === 'heim' || coupon === 'home') return 'HOME'
  if (coupon === 'remis' || coupon === 'unentschieden' || coupon === 'draw') return 'DRAW'
  if (coupon === 'auswärts' || coupon === 'auswaerts' || coupon === 'away') return 'AWAY'
  // Tennis beschriftet die beiden Seiten mit den Spielerpositionen.
  if (coupon === 'spieler 1' || coupon === 'player 1') return 'HOME'
  if (coupon === 'spieler 2' || coupon === 'player 2') return 'AWAY'

  const team = String(clean(o.teamCName) ?? '').toLowerCase()
  if (team === '1') return 'HOME'
  if (team === 'x') return 'DRAW'
  if (team === '2') return 'AWAY'

  switch (clean(o.sortIndex)) {
    case 1:
      return 'HOME'
    case 2:
      return 'DRAW'
    case 3:
      return 'AWAY'
    default:
      return null
  }
}

export const betway: BookmakerAdapter = {
  id: 'betway',
  name: 'Betway',
  transport: 'impit',

  async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
    const cutoff = Date.now() + ctx.windowMs
    const now = new Date().toISOString()
    const found = new Map<string, RawEvent>()

    for (const page of PAGES) {
      let payload: string
      try {
        payload = await fetchText(HOST + page, OPTS)
      } catch {
        continue
      }

      for (const block of extractBlocks(payload)) {
        // Quoten je Markt einsammeln, damit ein Event mehrere Märkte tragen kann.
        // Der Markttyp wird erst beim Event aufgelöst — er hängt an der
        // Sportart, und die steht am Event, nicht am Markt.
        const byEvent = new Map<number, { side: Side; odds: number }[]>()
        for (const market of Object.values(block.markets ?? {})) {
          // Nur die Siegwette: andere Typen stehen auf den Listenseiten nicht
          // vollständig, und Halbes wäre gefährlicher als nichts. Fußball nennt
          // sie `win-draw-win`, Tennis `to-win`.
          const type = clean(market.typeCName)
          if (type !== 'win-draw-win' && type !== 'to-win') continue
          if (market.suspended || market.eventId == null) continue

          for (const oid of market.outcomes ?? []) {
            const o = block.outcomes?.[String(oid)]
            if (!o || o.suspended) continue
            const odds = num(o.oddsDecimal)
            const side = toSide(o)
            if (odds === null || odds <= 1 || !side) continue
            const list = byEvent.get(market.eventId) ?? []
            list.push({ side, odds })
            byEvent.set(market.eventId, list)
          }
        }

        for (const [eventId, picks] of byEvent) {
          const e = block.events?.[String(eventId)]
          if (!e || e.suspended) continue
          const spec = SPORT_BY_CATEGORY.get(String(clean(e.categoryCName) ?? ''))
          if (!spec) continue
          const outcomes: RawOutcome[] = picks.map((p) => ({ market: spec.market, side: p.side, odds: p.odds }))

          const name = String(clean(e.name) ?? '')
          const [home, away] = name.split(' - ')
          const startsAt = clean(e.startsAt)
          if (!home?.trim() || !away?.trim() || !startsAt) continue

          const start = new Date(String(startsAt))
          if (!Number.isFinite(start.getTime()) || start.getTime() > cutoff) continue

          const key = String(eventId)
          const existing = found.get(key)
          if (existing) {
            // Dieselbe Partie steht in mehreren Flight-Blöcken. Ohne
            // Entdopplung landet jede Quote mehrfach im Bestand.
            const seen = new Set(existing.outcomes.map((o) => `${o.market.type}|${o.side}|${o.odds}`))
            for (const o of outcomes) {
              const k = `${o.market.type}|${o.side}|${o.odds}`
              if (!seen.has(k)) {
                seen.add(k)
                existing.outcomes.push(o)
              }
            }
            continue
          }
          found.set(key, {
            bookmakerId: 'betway',
            bookEventId: key,
            // Betway legt im Flight-Payload keine Sportradar-ID offen.
            sportradarId: null,
            sport: SPORT_LABEL[spec.sport],
            league: [clean(e.subcategoryName), clean(e.groupName)].filter(Boolean).join(' — ') || 'Unbekannt',
            home: home.trim(),
            away: away.trim(),
            startTime: start.toISOString(),
            // `trading: "live"` heißt "wird gehandelt", nicht "läuft" — auch
            // Partien in drei Tagen tragen es. Maßgeblich ist `started`.
            isLive: !!clean(e.started),
            url: `${HOST}/de/de/sports/evt/${key}`,
            outcomes,
            fetchedAt: now,
          })
        }
      }
    }

    return [...found.values()].slice(0, ctx.maxEvents)
  },
}
