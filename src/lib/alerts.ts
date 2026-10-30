/**
 * Benachrichtigung im Browser bei Funden über der Schwelle. Die Auswahl
 * (welcher Fund ist neu?) ist rein und getestet, nur die Ausgabe hängt am Browser.
 */

export type AlertCandidate = {
  id: string
  /** Rendite in Prozent — die **eingeschränkte**, nicht die rohe. */
  percent: number
  label: string
}

/**
 * Welche Funde neu über der Schwelle liegen. Fällt ein Fund darunter oder
 * verschwindet, fällt er aus `alerted` — kommt er wieder, ist das ein neuer Anlass.
 */
export function selectAlerts(
  candidates: AlertCandidate[],
  minPercent: number,
  alerted: ReadonlySet<string>,
): { fresh: AlertCandidate[]; next: Set<string> } {
  const over = candidates.filter((c) => c.percent >= minPercent)
  const next = new Set(over.map((c) => c.id))
  const fresh = over.filter((c) => !alerted.has(c.id))
  // Höchste Rendite zuerst — bei mehreren gleichzeitig ist das die, die zählt.
  fresh.sort((a, b) => b.percent - a.percent)
  return { fresh, next }
}

/* ------------------------------------------------------------------ Ausgabe */

/** Kurzer Zweiklang über Web Audio, ohne Audiodatei. Der Kontext wird einmal erzeugt und behalten. */
let audio: AudioContext | null = null

const context = (): AudioContext | null => {
  if (audio) return audio
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  audio = new Ctor()
  return audio
}

export function playChime(): void {
  const ctx = context()
  if (!ctx) return
  // Ohne vorherige Nutzergeste startet der Kontext angehalten. Das Fortsetzen
  // ist nach dem Klick auf „Benachrichtigungen erlauben" erlaubt.
  if (ctx.state === 'suspended') void ctx.resume()

  const now = ctx.currentTime
  for (const [i, hz] of [880, 1320].entries()) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = hz
    // Kurze Hüllkurve: ohne sie knackt der Ton beim Ein- und Ausschalten.
    const t = now + i * 0.14
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.22, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.14)
  }
}

/** Weckt den Audio-Kontext im Rahmen einer Nutzergeste. */
export function unlockAudio(): void {
  const ctx = context()
  if (ctx?.state === 'suspended') void ctx.resume()
}

export type NotificationState = 'default' | 'granted' | 'denied' | 'unsupported'

export const notificationState = (): NotificationState =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission

/** Fragt die Erlaubnis für Systemmeldungen — nur aus einer Nutzergeste heraus möglich. */
export async function requestNotifications(): Promise<NotificationState> {
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

/** Zeigt eine Systemmeldung für alle frischen Funde; `tag` ersetzt eine ältere statt zu stapeln. */
export function showAlert(fresh: AlertCandidate[]): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  if (!fresh.length) return

  const best = fresh[0]
  const title =
    fresh.length === 1
      ? `Arbitrage ${best.percent.toFixed(2)} %`
      : `${fresh.length} Arbitragen — beste ${best.percent.toFixed(2)} %`
  const body =
    fresh.length === 1
      ? best.label
      : fresh
          .slice(0, 4)
          .map((f) => `${f.percent.toFixed(2)} %  ${f.label}`)
          .join('\n')

  try {
    const n = new Notification(title, { body, tag: 'arbify-alert', silent: true })
    // Klick bringt das Fenster nach vorn — ohne das müsste der Nutzer die App
    // von Hand suchen, und dafür ist die Quote zu kurzlebig.
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    // Manche Browser werfen, wenn die Seite im Hintergrund keine Meldung darf.
  }
}
