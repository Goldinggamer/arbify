/**
 * Namensabgleich für Einzelsportler.
 *
 * Der Vereinsabgleich in `match.ts` vergleicht Wortmengen. Bei Spielernamen
 * scheitert das schon am Normalfall: "Alcaraz C." und "Carlos Alcaraz" teilen
 * genau ein Wort, das ergibt 0,50 und liegt unter der Andockschwelle von 0,75.
 * Gemessen über vierzehn echte Namenspaare fiel **jedes einzelne** durch.
 *
 * Schlimmer als das Verfehlen ist die Verwechslung, und die trifft ausgerechnet
 * Geschwister — im Tennis keine Randerscheinung:
 *
 *   "Zverev A."      gegen Alexander Zverev   0,50
 *   "Zverev A."      gegen Mischa Zverev      0,50   ← nicht unterscheidbar
 *   "Cerundolo J.M." gegen Juan Manuel C.     0,33
 *   "Cerundolo J.M." gegen Francisco C.       0,50   ← falscher Bruder gewinnt
 *
 * Die Initiale, die den Unterschied macht, behandelt der Wortmengenvergleich
 * als beliebiges Wort — und weil sie nur ein Zeichen lang ist, zieht sie den
 * Nenner hoch statt den Treffer zu bestätigen.
 *
 * Deshalb ein eigenes Modell: ein Name zerfällt in **Namenswörter** und
 * **Initialen**. Zwei Namen bezeichnen dieselbe Person, wenn die Wörter des
 * kürzeren im längeren vorkommen und keine Initiale widerspricht. Eine
 * widersprechende Initiale schlägt den Treffer aus — das ist die eigentliche
 * Leistung, nicht das Finden.
 */

type ParsedName = {
  /** Namenswörter, klein und ohne Diakritika: ["bautista", "agut"] */
  words: string[]
  /** Einzelbuchstaben aus abgekürzten Vornamen: ["j", "m"] */
  initials: string[]
}

const fold = (s: string): string =>
  s
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
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

/**
 * Zerlegt einen Namen.
 *
 * Das angehängte Länderkürzel fliegt vorher raus: bwin schreibt "Alex
 * Hernandez (MEX)", Kambi denselben Spieler als "Alex Hernandez". Bliebe das
 * Kürzel stehen, wäre es ein Namenswort wie jedes andere — und "(MEX)" gegen
 * "(ESP)" würde zwei Schreibweisen derselben Person trennen.
 */
export function parseName(raw: string): ParsedName {
  const parts = fold(raw)
    .replace(/\((?:[a-z]{2,3})\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const words: string[] = []
  const initials: string[] = []
  for (const p of parts) {
    if (/^\d+$/.test(p)) continue
    if (p.length === 1) initials.push(p)
    else words.push(p)
  }
  return { words, initials }
}

/** Trennt eine Doppel-Paarung in ihre Spieler. */
const splitTeam = (raw: string): string[] =>
  raw
    .split(/\s*[/&+]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)

/**
 * Prüft die Initialen **einer** Seite gegen die übrigen Vornamen der anderen.
 *
 * Zurück kommt `null`, sobald eine Initiale widerspricht — sonst die Zahl der
 * Initialen, die tatsächlich bestätigt werden konnten. Nicht überprüfbar ist
 * nicht dasselbe wie falsch: trägt die Gegenseite gar keine ausgeschriebenen
 * Vornamen mehr, lässt sich "C." schlicht nicht widerlegen.
 */
function checkInitials(initials: string[], spare: string[], otherInitials: string[]): number | null {
  const rest = [...spare]
  let confirmed = 0
  for (const ini of initials) {
    const i = rest.findIndex((w) => w.startsWith(ini))
    if (i >= 0) {
      rest.splice(i, 1)
      confirmed++
      continue
    }
    // Kein ausgeschriebener Vorname mehr übrig, aber die Gegenseite kürzt
    // ebenfalls ab: dann müssen sich die Abkürzungen decken.
    if (!rest.length) {
      if (!otherInitials.length || otherInitials.includes(ini)) continue
      return null
    }
    return null
  }
  return confirmed
}

/**
 * Bezeichnen zwei Namen dieselbe Person? 0 heißt nein.
 *
 * Ein Treffer liegt bei 0,8; alle Initialen bestätigt ergibt 1,0. Die
 * Abstufung dient nur der Auswahl unter mehreren Kandidaten — die Schwelle
 * liegt darunter, ein Treffer ist ein Treffer.
 */
export function nameMatch(a: string, b: string): number {
  const pa = parseName(a)
  const pb = parseName(b)
  if (!pa.words.length || !pb.words.length) return 0

  // Der kürzere Name ist der abgekürzte; seine Wörter müssen im längeren
  // vorkommen. "Alcaraz" steckt in "Carlos Alcaraz", "Carlos" nicht in "Alcaraz C.".
  const [short, long] = pa.words.length <= pb.words.length ? [pa, pb] : [pb, pa]

  const spare = [...long.words]
  for (const w of short.words) {
    const i = spare.indexOf(w)
    if (i < 0) return 0 // ein Namenswort fehlt drüben — andere Person
    spare.splice(i, 1)
  }

  const fromShort = checkInitials(short.initials, spare, long.initials)
  if (fromShort === null) return 0
  // Die Gegenrichtung fängt den Fall ab, dass der längere Name selbst abkürzt.
  if (checkInitials(long.initials, [], short.initials) === null) return 0

  const total = short.initials.length
  return total ? 0.8 + 0.2 * (fromShort / total) : 0.8
}

/**
 * Wie `nameMatch`, aber auch für Doppel.
 *
 * Beide Seiten müssen gleich viele Spieler haben, und jeder braucht einen
 * eigenen Gegenpart — die Reihenfolge ist nicht zugesagt: bwin führt
 * "R. Ram/J. Salisbury", ein anderes Buch dieselbe Paarung umgekehrt.
 */
export function playerMatch(a: string, b: string): number {
  const ta = splitTeam(a)
  const tb = splitTeam(b)
  if (ta.length === 1 && tb.length === 1) return nameMatch(a, b)
  if (ta.length !== tb.length || !ta.length) return 0

  const open = [...tb]
  let sum = 0
  for (const one of ta) {
    let bestIdx = -1
    let best = 0
    for (let i = 0; i < open.length; i++) {
      const s = nameMatch(one, open[i])
      if (s > best) {
        best = s
        bestIdx = i
      }
    }
    if (bestIdx < 0) return 0
    open.splice(bestIdx, 1)
    sum += best
  }
  return sum / ta.length
}
