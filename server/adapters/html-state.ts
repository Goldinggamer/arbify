/**
 * Extrahiert serverseitig ins HTML gerenderte Zustandsdaten.
 *
 * Mehrere Anbieter liefern gar keinen JSON-Endpunkt für ihre Quoten, sondern
 * betten den kompletten Zustand als JavaScript-Objekt in die Seite ein —
 * Betano über die Hydration-Payload, Winamax als `PRELOADED_STATE`. Beides
 * ist auswertbar, man muss das Objekt nur sauber aus dem Fließtext schneiden.
 *
 * Ein simples `indexOf('}')` genügt dafür nicht: die Objekte enthalten
 * geschweifte Klammern in Zeichenketten. Der Scanner zählt deshalb die Tiefe
 * und ignoriert alles, was in Anführungszeichen steht.
 */

/** Schneidet ab `start` das balancierte JSON-Objekt aus, String-sicher. */
export function sliceJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/**
 * Liest das Objekt hinter einem Marker, z.B. `PRELOADED_STATE = {…}`.
 * Gibt `null` zurück, wenn der Marker fehlt oder das Objekt unvollständig ist.
 */
export function readStateAfter<T = unknown>(html: string, marker: string): T | null {
  const at = html.indexOf(marker)
  if (at < 0) return null
  const start = html.indexOf('{', at)
  if (start < 0) return null
  const raw = sliceJsonObject(html, start)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
