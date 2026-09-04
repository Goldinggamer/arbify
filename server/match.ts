import type { CanonicalMarket, MatchedEvent, RawEvent, RawOutcome, Side } from './types.ts'
import { INDIVIDUAL_SPORTS, sportFromLabel } from './types.ts'
import { playerMatch } from './players.ts'

/**
 * Führt dasselbe Event über mehrere Buchmacher zusammen.
 *
 * Das ist die fehleranfälligste Stelle des ganzen Systems: wer hier zwei
 * verschiedene Partien zusammenwirft — oder dieselbe Partie falsch herum —
 * bekommt eine Arbitrage angezeigt, die es nicht gibt.
 *
 * Zwei Schritte:
 *
 *  1. Gruppieren. Bevorzugt über die Sportradar-Match-ID; alle drei
 *     Pilot-Anbieter liefern sie (Tipico `sportRadarMatchId`, Betano
 *     `betRadarId`, bwin `addons.betRadar`). Nur wenn sie fehlt, greift der
 *     Fallback über normalisierte Teamnamen plus Anstoßzeit (±20 Minuten).
 *
 *  2. Ausrichten. Buchmacher sind sich nicht einig, wer Heimmannschaft ist:
 *     bwin führt "Cusco FC – Universitario", Tipico dieselbe Partie als
 *     "Universitario – Cusco FC". HOME und AWAY sind also relativ zur
 *     jeweiligen Quelle. Ohne Korrektur wird die Heimquote des einen gegen
 *     die Heimquote des anderen gerechnet — und das ergibt Renditen von
 *     angeblich 45 %, die in Wahrheit nur ein Vorzeichenfehler sind.
 */

const STOPWORDS = new Set([
  'fc', 'sc', 'sv', 'vfl', 'vfb', 'tsv', 'fsv', 'bsc', 'spvgg', 'rb', 'ac', 'as', 'ss', 'ssc',
  'cf', 'cd', 'ca', 'afc', 'ufc', 'if', 'ik', 'bk', 'mks', 'ks', 'zks', 'lks', 'club', 'de',
  'the', 'ii',
])

/** "1. FC Köln" → ["koln"], "MKS Pogon Szczecin" → ["pogon","szczecin"] */
export function teamTokens(name: string): string[] {
  const base = name
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    // æ, ø, å, ð, þ, đ, ł sind eigenständige Buchstaben, keine Diakritika —
    // sie überleben das NFD unten und würden von der Zeichenklasse danach zu
    // Leerzeichen zerhackt. Aus "Stabæk" wurde so ["stab", "k"], und damit
    // fand Stabæk seinen eigenen Gegenpart "Stabaek IF" nie.
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/ð/g, 'd')
    .replace(/þ/g, 'th')
    .replace(/đ/g, 'd')
    .replace(/ł/g, 'l')
    .replace(/ı/g, 'i')
    .replace(/œ/g, 'oe')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')

  const tokens = base
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => !/^\d{1,4}$/.test(t))

  return tokens.length ? tokens : base.split(/\s+/).filter(Boolean)
}

export const normalizeTeam = (name: string): string => teamTokens(name).join('')

/**
 * Ähnlichkeit zweier Teamnamen, 0…1.
 *
 * Überlappung der Wortmengen relativ zur kleineren Menge, damit
 * "Pogon Szczecin" und "MKS Pogon Szczecin" als identisch gelten.
 */
function similarity(a: string, b: string): number {
  return tokenSimilarity(teamTokens(a), teamTokens(b))
}

/** Wie `similarity`, aber auf bereits zerlegten Namen — spart Arbeit in Schleifen. */
export function tokenSimilarity(a: string[], b: string[]): number {
  const ta = new Set(a)
  const tb = new Set(b)
  if (!ta.size || !tb.size) return 0
  let hits = 0
  for (const t of ta) if (tb.has(t)) hits++
  return hits / Math.min(ta.size, tb.size)
}

/** Spiegelt ein Outcome an der Heim/Auswärts-Achse. */
function flipOutcome(o: RawOutcome): RawOutcome {
  const m = o.market
  let market: CanonicalMarket = m
  let side: Side = o.side

  if (m.type === 'EH' || m.type === 'AH') {
    // Die Linie steht aus Heimsicht — beim Drehen kehrt sich ihr Vorzeichen um.
    //
    // `AH` fehlte hier lange, und es fiel nicht auf, solange zweiwegige
    // Handicaps praktisch nur im Tennis vorkamen. Im Basketball ist das
    // Handicap der Hauptmarkt, und dort wurde der Fehler sofort sichtbar:
    // "Portland Fire −6,5 zu 5,50" gegen "Indiana Fever +6,5 zu 1,75" ergab
    // angeblich 32,8 % Rendite. In Wahrheit hatte das eine Buch die Partie
    // andersherum geführt, die Seiten wurden gedreht — die Linie aber nicht.
    // Verglichen wurde damit ein Handicap auf Portland gegen eines auf
    // Indiana. Ein solcher Fund ist kein schwacher Fund, sondern ein falscher.
    market = { ...m, line: m.line === null ? null : -m.line }
  }
  if (m.type === 'TEAM_OU') {
    market = { ...m, subject: m.subject === 'HOME' ? 'AWAY' : m.subject === 'AWAY' ? 'HOME' : null }
  }
  if (side === 'HOME') side = 'AWAY'
  else if (side === 'AWAY') side = 'HOME'

  return { ...o, market, side }
}

/**
 * Wie zwei Bezeichnungen desselben Teilnehmers verglichen werden.
 *
 * Bei Vereinen zählt die Überlappung der Wortmengen. Bei **Einzelsportlern**
 * führt das in die Irre, weil die Bücher Vornamen abkürzen: "Alcaraz C." und
 * "Carlos Alcaraz" teilen genau ein Wort und kämen auf 0,50 — unter der
 * Andockschwelle. Und Geschwister wären überhaupt nicht auseinanderzuhalten.
 * Siehe `server/players.ts`.
 */
const isIndividual = (sport: string): boolean => {
  const s = sportFromLabel(sport)
  return s !== null && INDIVIDUAL_SPORTS.has(s)
}

/**
 * Sportart als Schlüsselbestandteil — Gruppen dürfen sich nie über Sportarten
 * hinweg mischen.
 *
 * Der Anzeigename selbst ist der Schlüssel, nicht eine Abkürzung daraus. Damit
 * bekommt auch eine Sportart, die `sportFromLabel` nicht kennt, ihren eigenen
 * Raum, statt mit allem Unbekannten in einen Topf zu fallen.
 */
const sportKey = (sport: string): string => sportFromLabel(sport) ?? `?${sport}`

const nameSimilarity = (sport: string, a: string, b: string): number =>
  isIndividual(sport) ? playerMatch(a, b) : similarity(a, b)

type Orientation = 'direct' | 'flipped' | 'unclear'

function orientationOf(src: RawEvent, home: string, away: string): Orientation {
  const direct = nameSimilarity(src.sport, src.home, home) + nameSimilarity(src.sport, src.away, away)
  const flipped = nameSimilarity(src.sport, src.home, away) + nameSimilarity(src.sport, src.away, home)
  if (direct === 0 && flipped === 0) return 'unclear'
  if (Math.abs(direct - flipped) < 0.35) return 'unclear'
  return direct > flipped ? 'direct' : 'flipped'
}

const MATCH_WINDOW_MS = 20 * 60 * 1000

/**
 * Schwelle für das tolerante Andocken.
 *
 * Gefordert wird sie von **beiden** Seiten einzeln, nicht von der Summe. Das
 * ist der ganze Trick: LeoVegas führt eSports-Partien als "Barcelona
 * (Int1liGenT) vs Real Madrid (Terry14)". Über die Summe zieht das eine
 * starke Seite ("barcelona") durch, obwohl die andere überhaupt nicht passt —
 * und schon rechnet der Scanner FIFA-Quoten gegen echten Fußball. Über das
 * Minimum fällt genau dieser Fall durch.
 */
const DOCK_THRESHOLD = 0.75

type IndexEntry = {
  sig: string
  sport: string
  /** Rohnamen — nur der Einzelsport-Abgleich braucht sie ungetrennt. */
  homeRaw: string
  awayRaw: string
  home: string[]
  away: string[]
  time: number
  groupKey: string
}

function bestTolerantMatch(index: IndexEntry[], ev: RawEvent, home: string[], away: string[], time: number) {
  const sport = sportKey(ev.sport)
  const individual = isIndividual(ev.sport)

  let best: IndexEntry | undefined
  let bestScore = 0
  for (const c of index) {
    // Eine Tennispartie darf niemals an einer Fußballgruppe andocken, auch
    // nicht bei zufällig passenden Namen und Anstoßzeiten.
    if (sportKey(c.sport) !== sport) continue
    if (Math.abs(c.time - time) > MATCH_WINDOW_MS) continue

    const direct = individual
      ? Math.min(playerMatch(ev.home, c.homeRaw), playerMatch(ev.away, c.awayRaw))
      : Math.min(tokenSimilarity(home, c.home), tokenSimilarity(away, c.away))
    const flipped = individual
      ? Math.min(playerMatch(ev.home, c.awayRaw), playerMatch(ev.away, c.homeRaw))
      : Math.min(tokenSimilarity(home, c.away), tokenSimilarity(away, c.home))

    const score = Math.max(direct, flipped)
    if (score >= DOCK_THRESHOLD && score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

export type MatchStats = {
  /** Quellen, deren Ausrichtung gedreht werden musste */
  flipped: number
  /** Quellen, die wegen unklarer Zuordnung verworfen wurden */
  dropped: number
}

/** Teampaar-Signatur, unabhängig von der Reihenfolge. */
const pairSignature = (ev: RawEvent): string =>
  [normalizeTeam(ev.home), normalizeTeam(ev.away)].sort().join('~')

export function matchEvents(events: RawEvent[]): { matched: MatchedEvent[]; stats: MatchStats } {
  const groups = new Map<string, RawEvent[]>()
  /** Signatur jeder Gruppe, damit Quellen ohne ID andocken können. */
  const index: IndexEntry[] = []

  const add = (groupKey: string, ev: RawEvent) => {
    const list = groups.get(groupKey)
    if (list) list.push(ev)
    else groups.set(groupKey, [ev])
  }

  const entry = (ev: RawEvent, groupKey: string): IndexEntry => ({
    sig: pairSignature(ev),
    sport: ev.sport,
    homeRaw: ev.home,
    awayRaw: ev.away,
    home: teamTokens(ev.home),
    away: teamTokens(ev.away),
    time: new Date(ev.startTime).getTime(),
    groupKey,
  })

  // --- Durchgang 1: alles mit Sportradar-ID ---------------------------
  // Das ist der exakte Join und hat immer Vorrang.
  const withoutId: RawEvent[] = []
  for (const ev of events) {
    if (ev.sportradarId == null) {
      withoutId.push(ev)
      continue
    }
    // Die Sportart gehört in den Schlüssel: die Kennungen sind zwar in der
    // Praxis über Sportarten hinweg eindeutig, aber darauf muss sich hier
    // nichts verlassen — eine Kollision würde Tennisquoten gegen
    // Fußballquoten rechnen.
    const groupKey = `sr:${sportKey(ev.sport)}:${ev.sportradarId}`
    if (!groups.has(groupKey)) index.push(entry(ev, groupKey))
    add(groupKey, ev)
  }

  // --- Durchgang 2: Quellen ohne ID an bestehende Gruppen andocken -----
  // Nicht jeder Buchmacher liefert eine Sportradar-ID — Kambi-Marken wie
  // LeoVegas zum Beispiel nicht. Würde man diese Events nur untereinander
  // über Namen gruppieren, blieben sie für immer von den ID-Gruppen
  // getrennt und wären damit wertlos: sie fänden nie einen Gegenpart.
  for (const ev of withoutId) {
    const sig = pairSignature(ev)
    const t = new Date(ev.startTime).getTime()
    const home = teamTokens(ev.home)
    const away = teamTokens(ev.away)
    const sport = sportKey(ev.sport)

    let hit = index.find(
      (c) => sportKey(c.sport) === sport && c.sig === sig && Math.abs(c.time - t) <= MATCH_WINDOW_MS,
    )

    // Die exakte Signatur ist zu streng für das, was Buchmacher tatsächlich
    // schreiben: "Deportes Concepción" gegen "Concepcion", "RFS Riga" gegen
    // "RFS", "CD Once Caldas" gegen "Once Caldas Manizales". Jeder Zusatz
    // verhindert das Andocken komplett — und die neun Anbieter ohne
    // Sportradar-ID hängen ausschließlich an diesem Durchgang.
    if (!hit) hit = bestTolerantMatch(index, ev, home, away, t)

    if (hit) {
      add(hit.groupKey, ev)
    } else {
      const groupKey = `pair:${sport}:${sig}:${t}`
      index.push(entry(ev, groupKey))
      add(groupKey, ev)
    }
  }

  const stats: MatchStats = { flipped: 0, dropped: 0 }
  const matched: MatchedEvent[] = []

  for (const [key, sources] of groups) {
    // Der Anker gibt die Ausrichtung vor. Gewählt wird die Quelle mit den
    // meisten Märkten — die hat typischerweise auch die saubersten Namen.
    const anchor = sources.reduce((a, b) => (b.outcomes.length > a.outcomes.length ? b : a))
    const aligned: RawEvent[] = []

    for (const src of sources) {
      if (src === anchor) {
        aligned.push(src)
        continue
      }
      const orientation = orientationOf(src, anchor.home, anchor.away)
      if (orientation === 'unclear') {
        // Lieber eine Quelle weniger als ein vertauschtes Bein.
        stats.dropped++
        continue
      }
      if (orientation === 'direct') {
        aligned.push(src)
      } else {
        stats.flipped++
        aligned.push({
          ...src,
          home: anchor.home,
          away: anchor.away,
          outcomes: src.outcomes.map(flipOutcome),
        })
      }
    }

    const earliest = aligned.reduce((a, b) => (new Date(a.startTime) <= new Date(b.startTime) ? a : b))
    // Live-Zustand aus der Anstoßzeit ableiten, nicht aus den Flags der
    // Buchmacher: Tipico markiert nahezu jedes Event als "running", Betano
    // liefert das Feld gar nicht. Die Anstoßzeit ist die einzige Angabe, auf
    // die sich alle Quellen verlassen lassen.
    const started = new Date(earliest.startTime).getTime() <= Date.now()
    matched.push({
      key,
      sportradarId: aligned.find((s) => s.sportradarId != null)?.sportradarId ?? null,
      sport: anchor.sport,
      league: anchor.league,
      home: anchor.home,
      away: anchor.away,
      startTime: earliest.startTime,
      isLive: started,
      sources: aligned,
    })
  }

  return { matched, stats }
}
