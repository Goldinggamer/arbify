import { marketKey, marketLabel, OVERTIME_SPORTS, SIDES, sideLabel, sportFromLabel } from './types.ts'
import { noteCollision } from './diagnostics.ts'
import type { CanonicalMarket, MatchedEvent, Side } from './types.ts'

/**
 * Sucht in zusammengeführten Events nach Arbitrage.
 *
 * Ein Markt kommt nur in Frage, wenn *alle* seine Seiten vorhanden sind und
 * die Bestquoten von mindestens zwei verschiedenen Buchmachern stammen.
 * Beides ist eine Sicherheitsschranke: ein fehlendes Bein würde die Summe
 * der impliziten Wahrscheinlichkeiten künstlich drücken und damit eine
 * Arbitrage vortäuschen, die gar nicht existiert.
 */

/**
 * Eine Quote ohne Einsatzgrenze.
 *
 * Limits wurden bewusst wieder ausgebaut: kein Anbieter liefert sie über seine
 * öffentlichen Endpunkte, geschätzte Werte waren also der Normalfall — und die
 * echte Grenze steht ohnehin erst im Wettschein der angemeldeten Sitzung, wo
 * sie sich von der ausgeloggten Ansicht unterscheiden kann. Eine Zahl, die
 * jeder Nutzer vor dem Setzen selbst prüfen muss, gehört nicht in die
 * Einsatzaufteilung.
 */
export type ScanQuote = {
  bookmakerId: string
  odds: number
}

export type ScanOutcome = {
  label: string
  best: ScanQuote
  all: ScanQuote[]
}

export type ScanOpportunity = {
  id: string
  sport: string
  league: string
  home: string
  away: string
  startTime: string
  isLive: boolean
  /** Anzeigename, z.B. "Über/Unter 2.5" */
  market: string
  /** Markt-Familie für den Filter, z.B. "OU" — siehe MarketType */
  marketFamily: string
  outcomes: ScanOutcome[]
  warnings: string[]
  /** Rendite in Prozent vom Gesamteinsatz, vor Rundung und Limits */
  arbPercent: number
  /** Direktlinks je Buchmacher */
  links: Record<string, string>
  updatedAt: string
}

const STALE_MS = 60_000

/**
 * Harte Untergrenze für die Summe der impliziten Wahrscheinlichkeiten.
 *
 * Entspricht rund 33 % Rendite. Ein Wert darunter ist kein guter Fund, sondern
 * mit an Sicherheit grenzender Wahrscheinlichkeit ein Datenfehler: verglichene
 * Märkte, die nicht dasselbe bedeuten (Restspielzeit statt Gesamtspiel,
 * Team-Tore statt Gesamttore, vertauschtes Heimrecht). Solche Fälle werden
 * verworfen und gezählt, damit sie in der Diagnose auffallen statt Geld zu
 * kosten.
 */
const MIN_PLAUSIBLE_IMPLIED = 0.75

/**
 * Ab hier gilt ein Fund als erklärungsbedürftig, aber nicht als falsch.
 *
 * Früher lag die harte Grenze bei 0,90 — das entspricht 11,1 % Rendite, und
 * damit war *jeder* Fund darüber unsichtbar. Genau die interessanten Fälle
 * fielen also stillschweigend heraus: ein Anbieter, der eine Quote zu spät
 * nachzieht, erzeugt durchaus 15 oder 20 %. Nur sind das eben auch die Werte,
 * die ein Mapping-Fehler erzeugt.
 *
 * Deshalb jetzt zweistufig: unter `MIN_PLAUSIBLE_IMPLIED` verwerfen, zwischen
 * beiden Schwellen anzeigen und mit `implausible-high` markieren. Die
 * Entscheidung, ob die Quote echt ist, trifft damit der Nutzer am Wettschein —
 * er sieht den Fund überhaupt erst, kann ihn aber nicht mit einer stillen
 * Annahme verwechseln.
 */
const SUSPICIOUS_IMPLIED = 0.9

/**
 * Obergrenze für die Quote eines einzelnen Beins.
 *
 * Bei Quote 71 entfallen auf dieses Bein 1,4 % des Einsatzes — der gesamte
 * rechnerische Gewinn hängt dann daran, dass ausgerechnet dieser eine,
 * offensichtlich veraltete Kurs noch angenommen wird. Solche Lottoschein-Beine
 * sind keine Arbitrage, sondern ein Ausführungsrisiko mit Renditeschild.
 */
const MAX_LEG_ODDS = 30

/**
 * Mindestvorlauf bis zum Anpfiff, in Minuten.
 *
 * Eine Arbitrage ist nur so viel wert wie die Zeit, sie zu platzieren. Wer
 * erst noch Geld beim zweiten Buchmacher einzahlen muss, braucht Vorlauf —
 * bei zu knapper Zeit droht dasselbe wie bei Live-Wetten: Einzahlung ist
 * durch, Quote ist weg, Geld sitzt hinter einer Umsatzbedingung fest.
 * Unterschreitet ein Fund diese Grenze, wird er markiert, nicht verworfen —
 * wer sein Kapital bereits verteilt hat, kann ihn trotzdem nutzen.
 */
const MIN_LEAD_MINUTES = 30

/**
 * Marktfamilien, die über Buchmacher hinweg verglichen werden dürfen.
 *
 * Team-Über/Unter war lange ausgeschlossen: die Familie erzeugte regelmäßig
 * Vergleiche mit impliziten Summen von 66–90 %, während 1X2, Über/Unter und
 * Handicap sauber blieben. Die Ursache lag nicht in der Familie, sondern in
 * einer einzigen Quelle — Sportwetten.de beschriftet die Halbzeit-Variante mit
 * „1. HZ" statt „1. Halbzeit". Der Adapter erkannte die Kurzform nicht, legte
 * 1.467 Halbzeit-Märkte als Ganzspiel ab, und im Bestand fielen sie auf
 * denselben Schlüssel wie die echten Ganzspiel-Märkte. Da je Seite die höchste
 * Quote gewinnt, setzte sich dort das Halbzeit-Über durch und wurde gegen ein
 * Ganzspiel-Unter gerechnet (siehe `periodOf` in `adapters/insic.ts`).
 *
 * Nach der Korrektur: von 491 buchmacherübergreifenden Vergleichen liegen noch
 * 3 unter 90 %, und alle drei hängen an einem Bein mit Quote 15–48 — dieselben
 * Ausreißer, die `MAX_LEG_ODDS` und `MIN_PLAUSIBLE_IMPLIED` in jeder anderen
 * Familie ebenfalls abfangen. Damit ist die Familie so belastbar wie die
 * übrigen und wird gegengerechnet.
 */
/**
 * `2WAY` und `AH` kommen aus dem Tennis: Matchsieger und Satzsieger sind
 * zweiseitig, ebenso beide Handicaps. Ohne sie hier fällt **jeder**
 * Tennis-Markt lautlos aus der Auswertung — gemessen an 62 über zwei Bücher
 * zusammengeführten Partien waren es null Vergleiche, obwohl die Quoten
 * vollständig im Bestand standen.
 */
const COMPARABLE: ReadonlySet<string> = new Set(['1X2', '2WAY', 'OU', 'BTTS', 'EH', 'AH', 'OE', 'TEAM_OU'])

/**
 * Ganzzahlige Torgrenze — "Über/Unter 2,0" statt "2,5".
 *
 * Solche Linien sind keine saubere Zweiteilung: fallen genau zwei Tore, wird
 * bei beiden Anbietern annulliert und der Einsatz kommt zurück. Lange waren sie
 * deshalb in drei Adaptern schlicht verworfen — und weil AdmiralBet sie behielt,
 * standen sich zwei Bestände gegenüber, die nie zueinander fanden: Über/Unter
 * 1,0 kam über alle sechzehn Bücher hinweg auf **null** Vergleiche, obwohl
 * AdmiralBet, VBET und Winamax den Markt alle drei führen.
 *
 * Verworfen gehören sie nicht. Liegen beide Beine auf **derselben** ganzen
 * Linie, ist der Push-Fall der einzige, in dem die Rendite entfällt — und er
 * kostet nichts, weil beide Einsätze zurückkommen. In jedem anderen Ausgang
 * gewinnt genau ein Bein, die Rechnung stimmt also unverändert. Der schlechteste
 * Fall ist die Null, nicht der Verlust.
 *
 * Der Nutzer muss davon trotzdem wissen: eine ausgewiesene Rendite von 3 %, die
 * mit gewisser Wahrscheinlichkeit 0 % wird, ist etwas anderes als eine, die es
 * nicht wird. Deshalb Warnung statt Filter.
 */
const isWholeLine = (line: number | null): boolean => line !== null && Math.abs(line * 2) % 2 === 0

/**
 * Muss der Nutzer die Verlängerungsregel selbst nachsehen?
 *
 * In Basketball, Eishockey und American Football gibt es zu jeder Linie zwei
 * Wetten: eine mit Verlängerung und eine ohne. Gemessen an bwin markieren die
 * Bücher die **reguläre** Spielzeit ausdrücklich („Drei Wege (Nur reguläre
 * Spielzeit)", „Gesamt (inkl. Verlängerung und Penalties)") — Schweigen heißt
 * also mit Verlängerung, und genau so ordnen die Adapter zu.
 *
 * Nur: das ist eine Regel über die Beschriftung, keine Garantie über die
 * Wettbedingungen. Schweigt ein Buch **und** wertet trotzdem nur die reguläre
 * Spielzeit, sind die beiden Beine nicht deckungsgleich, und der Fund verliert
 * genau dann, wenn es in die Verlängerung geht.
 *
 * Betroffen sind nur die Linienmärkte. Die 2-Weg-Siegwette braucht keine
 * Warnung: ohne Unentschieden **muss** sie die Verlängerung einschließen, sonst
 * bliebe ein Ausgang unbezahlt. Und `RT` ist ausdrücklich zugeordnet, da ist
 * nichts offen.
 */
function needsOvertimeCheck(sportLabel: string, m: CanonicalMarket): boolean {
  if (m.period !== 'FT') return false
  if (m.type !== 'OU' && m.type !== 'AH' && m.type !== 'TEAM_OU') return false
  const sport = sportFromLabel(sportLabel)
  return sport !== null && OVERTIME_SPORTS.has(sport)
}

let rejected: { event: string; market: string; impliedPercent: number; legs: string }[] = []

export const rejectedReport = () => rejected.slice(0, 40)

type Quote = {
  bookmakerId: string
  odds: number
  fetchedAt: string
  /** Beworbene Quote (Quotenboost) — siehe `RawOutcome.promo`. */
  promo?: boolean
}

const toScanQuote = (q: Quote): ScanQuote => ({ bookmakerId: q.bookmakerId, odds: q.odds })

/**
 * Wie nah die besten Quoten zweier Bücher an einer Arbitrage sind.
 *
 * Bei drei Anbietern ist eine echte Arbitrage selten — die Marge der Bücher
 * liegt bei 5–8 %. Diese Auswertung zeigt trotzdem, dass Matching und
 * Markt-Zuordnung greifen: sie listet die knappsten Vergleiche, unabhängig
 * davon ob sie profitabel sind. Ein Wert nahe 100 % heißt "fast eine Arb",
 * unter 100 % wäre eine.
 */
export type MarginRow = {
  event: string
  /** Sportart, damit die Oberfläche die Liste zum Sportfilter passend hält */
  sport: string
  league: string
  market: string
  impliedPercent: number
  legs: { label: string; odds: number; bookmakerId: string }[]
}

/**
 * "Hitze" eines Events: die niedrigste implizite Summe über alle vollständigen
 * Märkte. Je näher an 1, desto näher an einer Arbitrage.
 *
 * Damit entscheidet der Scheduler, welche Events im Sekundentakt nachgeladen
 * werden. Alle 500+ Events so oft abzufragen wäre weder nötig noch möglich —
 * interessant sind die, die kurz vor einer Arbitrage stehen.
 */
export function eventHeat(ev: MatchedEvent): number {
  if (ev.sources.length < 2) return Infinity

  const byMarket = new Map<string, Map<Side, number>>()
  for (const src of ev.sources) {
    for (const o of src.outcomes) {
      const key = marketKey(o.market)
      const sides = byMarket.get(key) ?? new Map<Side, number>()
      sides.set(o.side, Math.max(sides.get(o.side) ?? 0, o.odds))
      byMarket.set(key, sides)
    }
  }

  let best = Infinity
  for (const [key, sides] of byMarket) {
    const type = key.split('|')[0] as keyof typeof SIDES
    const required = SIDES[type]
    if (!required || required.some((s) => !sides.get(s))) continue
    const implied = required.reduce((sum, s) => sum + 1 / sides.get(s)!, 0)
    if (implied < best) best = implied
  }
  return best
}

export function scanForArbitrage(
  events: MatchedEvent[],
  minPercent = 0,
): { opportunities: ScanOpportunity[]; margins: MarginRow[] } {
  const found: ScanOpportunity[] = []
  const margins: MarginRow[] = []
  rejected = []

  for (const ev of events) {
    if (ev.sources.length < 2) continue

    // Laufende Spiele werden nicht bewertet — eine Produktentscheidung mit
    // betrieblichem, nicht technischem Grund: das Kapital liegt nicht schon
    // bei allen Buchmachern. Bis eingezahlt ist, hat sich die Live-Quote
    // bewegt, und wenn die Rendite dann weg ist, sitzt das Geld fest, weil
    // Auszahlungen in der Regel eine Umsatzbedingung haben. Das Risiko ist
    // einseitig. Live-Daten werden weiter erfasst (Kontext, Diagnose), führen
    // aber zu keiner ausgewiesenen Arbitrage.
    if (ev.isLive) continue

    // marketKey → side → Quoten aller Buchmacher
    const byMarket = new Map<string, { market: CanonicalMarket; sides: Map<Side, Quote[]> }>()

    for (const src of ev.sources) {
      for (const o of src.outcomes) {
        const key = marketKey(o.market)
        let entry = byMarket.get(key)
        if (!entry) {
          entry = { market: o.market, sides: new Map() }
          byMarket.set(key, entry)
        }
        const quotes = entry.sides.get(o.side) ?? []
        quotes.push({
          bookmakerId: src.bookmakerId,
          odds: o.odds,
          fetchedAt: src.fetchedAt,
          promo: o.promo,
        })
        entry.sides.set(o.side, quotes)
      }
    }

    for (const [key, { market, sides }] of byMarket) {
      if (!COMPARABLE.has(market.type)) continue
      const required = SIDES[market.type]
      if (required.some((s) => !sides.get(s)?.length)) continue

      /**
       * Fällt bei einem Buch dieselbe Seite mehrfach an, sind zwei
       * verschiedene Märkte auf einen Schlüssel gefallen — immer ein
       * Zuordnungsfehler in einem Adapter, denn dieselbe Wette gibt es bei
       * einem Anbieter nur einmal.
       *
       * Gerechnet wird trotzdem mit der **besten** Quote. Hier stand
       * zwischenzeitlich die schlechteste, um eine Verwechslung nicht zu einer
       * erfundenen Arbitrage werden zu lassen. Das ist die falsche Abwägung:
       * es unterdrückt auch **echte** Funde, und zwar unsichtbar — eine
       * Arbitrage, die nie angezeigt wird, beschwert sich nicht. Ein falscher
       * Fund fällt beim Gegenprüfen im Wettschein sofort auf, ein
       * verschluckter nie.
       *
       * Stattdessen wird der Fund markiert (`market-collision`). Damit ist er
       * sichtbar, prüfbar und meldbar — und die Ursache gehört in den Adapter,
       * nicht in eine Abfederung an dieser Stelle.
       */
      let collided = false
      let boosted = false
      const best = required.map((side) => {
        const quotes = sides.get(side)!

        // Mehrere Quoten eines Buchs auf derselben Seite haben genau **zwei**
        // Ursachen, und die müssen auseinandergehalten werden:
        //
        //   Quotenboost   Betano führt "Endergebnis SuperQuoten" neben
        //                 "Endergebnis" — dieselbe Wette, bessere Quote. Das
        //                 ist erwartet und kein Fehler.
        //   Verwechslung  zwei verschiedene Märkte auf einem Schlüssel, etwa
        //                 "4. Viertel" und "1. Halbzeit". Das ist ein
        //                 Zuordnungsfehler im Adapter.
        //
        // Ohne die Unterscheidung würde jeder beworbene Fund fälschlich als
        // "Marktzuordnung unklar" markiert — und die Markierung damit wertlos.
        const perBook = new Map<string, Quote[]>()
        for (const q of quotes) {
          const list = perBook.get(q.bookmakerId)
          if (list) list.push(q)
          else perBook.set(q.bookmakerId, [q])
        }
        for (const [book, list] of perBook) {
          if (list.length > 1 && !list.some((q) => q.promo)) {
            noteCollision(book, key, `${ev.sport}: ${ev.home} — ${ev.away}`)
            collided = true
          }
        }

        const quote = quotes.reduce((a, b) => (b.odds > a.odds ? b : a))
        if (quote.promo) boosted = true
        return { side, quote, all: quotes }
      })

      // Zwei Beine beim selben Buchmacher sind keine Arbitrage, sondern nur
      // eine Marge unter null — die gibt es in der Praxis nicht.
      if (new Set(best.map((b) => b.quote.bookmakerId)).size < 2) continue

      const implied = best.reduce((s, b) => s + 1 / b.quote.odds, 0)

      // Für die Vergleichsliste nur Märkte, die praktisch spielbar wären.
      // Paare wie 31,00 gegen 1,01 stehen rechnerisch nah an einer Arbitrage,
      // sind aber wegen Limits und Rundung nie eine — sie würden die Liste
      // fluten und die wirklich interessanten Fälle verdecken.
      // Zusätzlich zur Spielbarkeit auch die Plausibilität verlangen: ein
      // Vergleich unter der Schranke beruht auf einem Datenfehler und gehört
      // in die Ablehnungsliste, nicht in die Übersicht der knappsten Fälle.
      // Für diese Liste bleibt die alte, strengere Schwelle stehen: sie soll
      // zeigen, wie nah die Bücher beieinanderliegen. Ein Vergleich unter
      // 90 % ist dafür kein Beleg, sondern ein Ausreißer — der gehört in die
      // Trefferliste (mit Warnung) oder in die Ablehnungsliste, nicht hierher.
      const playable =
        best.every((b) => b.quote.odds >= 1.1 && b.quote.odds <= 15) &&
        implied >= SUSPICIOUS_IMPLIED
      if (playable) {
        margins.push({
          event: `${ev.home} vs ${ev.away}`,
          sport: ev.sport,
          league: ev.league,
          market: marketLabel(market, ev.home, ev.away),
          impliedPercent: implied * 100,
          legs: best.map((b) => ({
            label: sideLabel(b.side, ev.home, ev.away, market),
            odds: b.quote.odds,
            bookmakerId: b.quote.bookmakerId,
          })),
        })
      }

      if (!(implied < 1)) continue

      // Ein einzelnes Bein mit absurd hoher Quote trägt kaum Einsatz, aber
      // das ganze Ausführungsrisiko.
      if (best.some((b) => b.quote.odds > MAX_LEG_ODDS)) {
        rejected.push({
          event: `${ev.home} vs ${ev.away}`,
          market: marketLabel(market, ev.home, ev.away),
          impliedPercent: implied * 100,
          legs: `Bein über Quote ${MAX_LEG_ODDS}: ` + best.map((b) => `${b.side} ${b.quote.odds}@${b.quote.bookmakerId}`).join(' | '),
        })
        continue
      }

      // Unter der harten Grenze: verwerfen. Zwischen den Schwellen bleibt der
      // Fund erhalten und bekommt weiter unten `implausible-high`.
      if (implied < MIN_PLAUSIBLE_IMPLIED) {
        rejected.push({
          event: `${ev.home} vs ${ev.away}`,
          market: marketLabel(market, ev.home, ev.away),
          impliedPercent: implied * 100,
          legs: best.map((b) => `${b.side} ${b.quote.odds}@${b.quote.bookmakerId}`).join(' | '),
        })
        continue
      }

      const arbPercent = (1 / implied - 1) * 100
      if (arbPercent < minPercent) continue

      const now = Date.now()
      const warnings: string[] = []
      const leadMinutes = (new Date(ev.startTime).getTime() - now) / 60_000
      if (leadMinutes < MIN_LEAD_MINUTES) warnings.push('short-notice')
      if (best.some((b) => now - new Date(b.quote.fetchedAt).getTime() > STALE_MS))
        warnings.push('stale-odds')
      if (implied < SUSPICIOUS_IMPLIED) warnings.push('implausible-high')
      if ((market.type === 'OU' || market.type === 'TEAM_OU') && isWholeLine(market.line))
        warnings.push('push-line')
      if (needsOvertimeCheck(ev.sport, market)) warnings.push('overtime')
      if (collided) warnings.push('market-collision')
      // Beworbene Quoten sind in der Regel einsatzbegrenzt und nicht für jedes
      // Konto verfügbar — die Rendite steht also, der Einsatz womöglich nicht.
      if (boosted) warnings.push('promo-odds')

      const links: Record<string, string> = {}
      for (const src of ev.sources) links[src.bookmakerId] = src.url

      found.push({
        id: `${ev.key}::${key}`,
        sport: ev.sport,
        league: ev.league,
        home: ev.home,
        away: ev.away,
        startTime: ev.startTime,
        isLive: ev.isLive,
        market: marketLabel(market, ev.home, ev.away),
        marketFamily: market.type,
        outcomes: best.map((b) => ({
          label: sideLabel(b.side, ev.home, ev.away, market),
          best: toScanQuote(b.quote),
          all: b.all.map(toScanQuote).sort((x, y) => y.odds - x.odds),
        })),
        warnings,
        arbPercent,
        links,
        updatedAt: new Date().toISOString(),
      })
    }
  }

  return {
    opportunities: found.sort((a, b) => b.arbPercent - a.arbPercent),
    margins: margins.sort((a, b) => a.impliedPercent - b.impliedPercent).slice(0, 40),
  }
}
