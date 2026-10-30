import { fetchText } from '../http.ts'
import type { CanonicalMarket, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'

/**
 * Interwetten — `/de/sport/upcoming/{sportId}?hours={n}` rendert das
 * Vorspiel-Programm ins HTML, ohne Login. Je Partie `li.s-event` mit
 * Teams, Anstoß (ohne Jahr) und `data-betting`; die Quote kommt aus dem Span.
 */

const HOST = 'https://www.interwetten.de'
const OPTS = { transport: 'impit' as const, minIntervalMs: 400 }
/** Sportkennung laut `data-kos-id` in der Navigation: 10 = Fußball, 11 = Tennis. */
const SPORT_FOOTBALL = 10

/** Sportarten samt Kennung und Hauptmarkt. Tennis ist 11 und zweiseitig. */
const SPORTS: { id: number; sport: Sport; market: CanonicalMarket }[] = [
  {
    id: SPORT_FOOTBALL,
    sport: 'FOOTBALL',
    market: { type: '1X2', period: 'FT', line: null, subject: null },
  },
  {
    id: 11,
    sport: 'TENNIS',
    market: { type: '2WAY', period: 'FT', line: null, subject: null },
  },
]

/** Nur die Siegwette — `offergroupid` greift auf dieser Seite nicht. */

const decode = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()

/** "28.07. - 17:00" → ISO. Laufendes Jahr, außer das Datum läge über zwei Monate zurück; deutsche Ortszeit. */
function parseKickoff(text: string, now = new Date()): string | null {
  const m = /(\d{1,2})\.(\d{1,2})\.?\s*-\s*(\d{1,2}):(\d{2})/.exec(text)
  if (!m) return null
  const [, d, mo, h, mi] = m.map(Number)
  const offset = '+02:00' // deutsche Sommerzeit; im Winter eine Stunde daneben
  for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
    const iso = `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00${offset}`
    const t = new Date(iso)
    if (!Number.isFinite(t.getTime())) continue
    if (t.getTime() > now.getTime() - 60 * 24 * 3600_000) return t.toISOString()
  }
  return null
}

/** Ordnet die Tipp-Kennung der Seite einer kanonischen Seite zu. */
function toSide(tip: string, market: CanonicalMarket): Side | null {
  const t = tip.trim().toLowerCase()
  if (market.type === '1X2' || market.type === 'EH' || market.type === '2WAY' || market.type === 'AH') {
    if (t === '1') return 'HOME'
    if (t === 'x') return 'DRAW'
    if (t === '2') return 'AWAY'
    return null
  }
  if (market.type === 'OU') {
    if (t.startsWith('über') || t.startsWith('over') || t === 'u') return 'OVER'
    if (t.startsWith('unter') || t.startsWith('under') || t === 'd') return 'UNDER'
    return null
  }
  if (market.type === 'BTTS') {
    if (t === 'ja' || t === 'j' || t === 'yes') return 'YES'
    if (t === 'nein' || t === 'n' || t === 'no') return 'NO'
    return null
  }
  return null
}

type ParsedEvent = {
  eventId: string
  /** Pfad zur Partie, wie er im Markup steht — mit Slug, sonst 404. */
  path: string
  home: string
  away: string
  startTime: string
  outcomes: RawOutcome[]
}

/**
 * Zerlegt eine Angebotsseite. Bewusst mit Regex statt DOM-Parser: das
 * Markup ist flach und stabil, und eine zusätzliche Abhängigkeit lohnt für
 * drei Muster nicht.
 */
function parsePage(html: string, market: CanonicalMarket): ParsedEvent[] {
  const events: ParsedEvent[] = []
  // Jeder Event-Block beginnt mit <li class="s-event
  const blocks = html.split(/<li class="s-event\b/).slice(1)

  for (const block of blocks) {
    // Der Pfad wird **mitsamt Slug** behalten: `/e/{id}` allein antwortet
    // die Seite mit 404, erst `/e/{id}/{slug}` führt zur Partie. Gemessen an
    // zwei Partien mit je drei Schreibweisen — nur die vollständige ging durch.
    const idMatch = /(\/de\/sportwetten\/e\/(\d+)\/[a-z0-9-]+)/.exec(block)
    if (!idMatch) continue
    const players = [...block.matchAll(/<strong class="s-event-player">([^<]*)<\/strong>/g)].map((m) =>
      decode(m[1]),
    )
    if (players.length < 2 || !players[0] || !players[1]) continue

    const timeMatch = /s-event-gametime"[^>]*>\s*<span>([^<]+)<\/span>/.exec(block)
    const startTime = timeMatch ? parseKickoff(decode(timeMatch[1])) : null
    if (!startTime) continue

    const outcomes: RawOutcome[] = []
    // Markt-Container: data-betting="[marktId, eventId, kurz, MARKTNAME, …]"
    for (const mk of block.matchAll(
      /data-betting="\[(\d+),(\d+),&quot;[^&]*&quot;,&quot;([^&]*)&quot;[^"]*"([\s\S]*?)(?=<div id="js-market-|<div class="s-event-other|$)/g,
    )) {
      // Der Marktname (mk[3]) wird nicht ausgewertet: die Seite liefert je
      // Sportart genau einen Hauptmarkt, und welcher das ist, steht in `SPORTS`.
      for (const oc of mk[4].matchAll(
        /data-betting="\[(\d+),&quot;([^&]*)&quot;[^"]*"[\s\S]{0,400}?class="js-outcome-odd s-outcome-odd">([\d.]+)</g,
      )) {
        const side = toSide(decode(oc[2]), market)
        const odds = Number(oc[3])
        if (side && Number.isFinite(odds) && odds > 1) outcomes.push({ market, side, odds })
      }
    }
    if (!outcomes.length) continue

    events.push({ eventId: idMatch[2], path: idMatch[1], home: players[0], away: players[1], startTime, outcomes })
  }
  return events
}

export const interwetten: BookmakerAdapter = {
  id: 'interwetten',
  name: 'Interwetten',
  transport: 'impit',

  async fetchEvents(ctx: AdapterContext): Promise<RawEvent[]> {
    const hours = Math.max(1, Math.ceil(ctx.windowMs / 3600_000))
    const cutoff = Date.now() + ctx.windowMs
    const now = new Date().toISOString()
    const out: RawEvent[] = []

    for (const spec of SPORTS) {
      let html: string
      try {
        html = await fetchText(
          `${HOST}/de/sport/upcoming/${spec.id}?hours=${hours}&offergroupid=7`,
          OPTS,
        )
      } catch {
        continue // Eine Sportart darf ausfallen, ohne den Rest zu kippen.
      }

      for (const e of parsePage(html, spec.market)) {
        if (new Date(e.startTime).getTime() > cutoff) continue
        if (out.length >= ctx.maxEvents) break
        out.push({
        bookmakerId: 'interwetten',
        bookEventId: e.eventId,
        // Interwetten liefert im Markup keine Sportradar-ID — Matching läuft
        // über normalisierte Teamnamen plus Anstoßzeit.
        sportradarId: null,
        sport: SPORT_LABEL[spec.sport],
        league: 'Unbekannt',
        home: e.home,
        away: e.away,
        startTime: e.startTime,
        isLive: new Date(e.startTime).getTime() <= Date.now(),
        url: `${HOST}${e.path}`,
        outcomes: e.outcomes,
        fetchedAt: now,
        })
      }
    }
    return out
  },
}
