import { teamTokens, tokenSimilarity } from '../match.ts'
import type { Period, Side } from '../types.ts'

/**
 * Halbzeit aus einer deutschen Beschriftung, `null` wenn keine genannt ist.
 * Kennt Lang- und Kurzform ("1. Halbzeit", "1. Hälfte", "1. HZ", "erste Halbzeit").
 */
export function halfOf(label: string): Period | null {
  const s = label.toLowerCase()
  if (/1\.\s*(halbzeit|hälfte|hz)\b|erste halbzeit/.test(s)) return 'H1'
  if (/2\.\s*(halbzeit|hälfte|hz)\b|zweite halbzeit/.test(s)) return 'H2'
  return null
}

/** Zahl aus einem Feld oder einer Beschriftung, Dezimalkomma erlaubt. Fehlt der Wert: `null`, nicht 0. */
export const num = (v: unknown): number | null => {
  const s = String(v ?? '').trim()
  if (!s) return null
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** Erste Zahl in einer Beschriftung ("Über 2,5" → 2.5). */
export const lineFromText = (text: string): number | null => {
  const m = text.match(/(-?\d+[.,]?\d*)/)
  return m ? num(m[1]) : null
}

/** Normalisiert für Namensvergleiche: Kleinschreibung, Umlaute, Satzzeichen weg. */
export const simplify = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '')

/** "Über 2,5" / "Mehr als 182,5" / "Under 3.5" → OVER / UNDER. */
export function ouSideFromText(label: string): Side | null {
  const n = label.trim().toLowerCase()
  if (n.startsWith('über') || n.startsWith('over') || n.startsWith('mehr')) return 'OVER'
  if (n.startsWith('unter') || n.startsWith('under') || n.startsWith('weniger')) return 'UNDER'
  return null
}

export const yesNoSide = (label: string): Side | null =>
  label === 'ja' ? 'YES' : label === 'nein' ? 'NO' : null

/** "ungerade" zuerst — "gerade" ist darin enthalten. */
export const oddEvenSide = (label: string): Side | null =>
  label.startsWith('ungerade') ? 'ODD' : label.startsWith('gerade') ? 'EVEN' : null

/**
 * Mindestähnlichkeit und Vorsprung vor der anderen Mannschaft. Der Vorsprung
 * ist die eigentliche Sicherung: "Manchester" passt zu United und City gleich
 * gut, und ein vertauschtes Team ist im Modell eine erfundene Wette.
 */
const TEAM_THRESHOLD = 0.5
const TEAM_MARGIN = 0.25

/**
 * Ordnet einen Namen einer der beiden Mannschaften zu — über Wortmengen statt
 * Zeichengleichheit, weil Bücher Exonyme ("Lech Posen" / "Lech Poznan") und
 * Kurzformen ("Panthers" / "Florida Panthers") mischen.
 */
export function teamSide(label: string, home: string, away: string): 'HOME' | 'AWAY' | null {
  const s = simplify(label)
  if (!s) return null
  if (s === simplify(home)) return 'HOME'
  if (s === simplify(away)) return 'AWAY'
  const tokens = teamTokens(label)
  if (!tokens.length) return null
  const h = tokenSimilarity(tokens, teamTokens(home))
  const a = tokenSimilarity(tokens, teamTokens(away))
  if (Math.max(h, a) < TEAM_THRESHOLD) return null
  if (Math.abs(h - a) < TEAM_MARGIN) return null
  return h > a ? 'HOME' : 'AWAY'
}
