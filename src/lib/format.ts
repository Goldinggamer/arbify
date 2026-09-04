const eurFmt = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const eurCompact = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

export const money = (v: number) => eurFmt.format(v)
export const moneyShort = (v: number) =>
  Number.isInteger(v) ? eurCompact.format(v) : eurFmt.format(v)

export const signedMoney = (v: number) => (v >= 0 ? '+' : '−') + money(Math.abs(v))

export const pct = (v: number, digits = 2) =>
  v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + '%'

export const odds = (v: number) =>
  v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function relativeTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMin = Math.round((d.getTime() - now.getTime()) / 60000)
  if (diffMin < 0) return 'läuft'
  if (diffMin < 60) return `in ${diffMin} Min`
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `Heute, ${time}`
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `Morgen, ${time}`
  return d.toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}
