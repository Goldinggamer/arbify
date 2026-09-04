import { fetchText } from '../http.ts'
import type { CanonicalMarket, RawEvent, RawOutcome, Side, Sport } from '../types.ts'
import { SPORT_LABEL } from '../types.ts'
import type { AdapterContext, BookmakerAdapter } from './types.ts'

/**
 * Interwetten.
 *
 * Der SignalR-Hub der Seite (`sr5.gamesassists.com/lbfeventHub`) verbindet
 * sich zwar und nimmt Abos an, pusht aber nur sporadisch Änderungen für
 * laufende Spiele — als Bestandsquelle unbrauchbar. Der tragfähige Weg ist
 * schlichtes HTTP: `/de/sport/upcoming/{sportId}?hours={n}` rendert das
 * komplette Vorspiel-Programm serverseitig ins HTML, ohne Login und Cookie.
 *
 * Aufbau je Partie:
 *   <li class="s-event">
 *     <a href="/de/sportwetten/e/{eventId}/{slug}">
 *     <strong class="s-event-player">Heim</strong>
 *     <strong class="s-event-player">Auswärts</strong>
 *     <div class="js-gametime-{eventId}"><span>28.07. - 17:00</span>
 *     <div data-betting="[marktId, eventId, kurz, "Spiel", …]">
 *       <div data-betting="[outcomeId, "1"|"X"|"2", …]">
 *         <span class="s-outcome-odd">3.05</span>
 *
 * Zwei Eigenheiten: die Quote steht sowohl im `data-betting` (mit deutschem
 * Komma) als auch im Span (mit Punkt) — genutzt wird der Span. Und die
 * Anstoßzeit kommt **ohne Jahr**, das muss erschlossen werden.
 */

const HOST = 'https://www.interwetten.de'
const OPTS = { transport: 'impit' as const, minIntervalMs: 400 }
/** Sportkennung laut `data-kos-id` in der Navigation: 10 = Fußball, 11 = Tennis. */
const SPORT_FOOTBALL = 10

/**
 * Sportarten samt Kennung und Hauptmarkt.
 *
 * Tennis liegt auf 11 — nachgemessen, nicht fortgezählt: 40, 12 und 80
 * liefern null bzw. eine Partie, 11 liefert 84. Und der Hauptmarkt ist dort
 * **zweiseitig**: als `1X2` verbucht verlangte er über `SIDES` ein
 * Unentschieden, das es nie gibt, und wäre nie vollständig geworden.
 */
const SPORTS: { id: number; sport: Sport; label: string; market: CanonicalMarket }[] = [
  {
    id: SPORT_FOOTBALL,
    sport: 'FOOTBALL',
    label: 'Fußball',
    market: { type: '1X2', period: 'FT', line: null, subject: null },
  },
  {
    id: 11,
    sport: 'TENNIS',
    label: 'Tennis',
    market: { type: '2WAY', period: 'FT', line: null, subject: null },
  },
]

/**
 * Nur die Siegwette. Geprüft: `offergroupid=8` (Über/Unter) und `109`
 * (Beide Teams treffen) werden von `/de/sport/upcoming` ignoriert — der
 * Parameter greift dort nicht, die Seite liefert unverändert "Spiel".
 * Weitere Märkte gäbe es über `/de/sport/leaguelist?leagueIds=…`, das
 * bräuchte aber erst eine Liga-Liste. Zwei Abrufe ins Leere pro Durchlauf
 * sind das nicht wert.
 */

const decode = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()

/**
 * "28.07. - 17:00" → ISO-Zeitstempel.
 *
 * Ohne Jahresangabe: es gilt das laufende Jahr, außer das Datum läge damit
 * mehr als zwei Monate in der Vergangenheit — dann ist der Jahreswechsel
 * gemeint. Interwetten rechnet in deutscher Ortszeit.
 */
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

/** Zieht die Linie aus dem Marktnamen, z.B. "Über/Unter 2,5". */
function lineOf(marketName: string): number | null {
  const m = /(-?\d+[.,]\d+|\d+)/.exec(marketName)
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

type ParsedEvent = {
  eventId: string
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
    const idMatch = /\/de\/sportwetten\/e\/(\d+)\//.exec(block)
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
      // Der Marktname wird nicht mehr ausgewertet: die Seite liefert je
      // Sportart genau einen Hauptmarkt, und welcher das ist, steht schon in
      // `SPORTS`. `lineOf` bleibt für künftige Linienmärkte erhalten.
      void decode(mk[3])

      for (const oc of mk[4].matchAll(
        /data-betting="\[(\d+),&quot;([^&]*)&quot;[^"]*"[\s\S]{0,400}?class="js-outcome-odd s-outcome-odd">([\d.]+)</g,
      )) {
        const side = toSide(decode(oc[2]), market)
        const odds = Number(oc[3])
        if (side && Number.isFinite(odds) && odds > 1) outcomes.push({ market, side, odds })
      }
    }
    if (!outcomes.length) continue

    events.push({ eventId: idMatch[1], home: players[0], away: players[1], startTime, outcomes })
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
        url: `${HOST}/de/sportwetten/e/${e.eventId}`,
        outcomes: e.outcomes,
        fetchedAt: now,
        })
      }
    }
    return out
  },
}
