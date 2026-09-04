/**
 * Erkundet OpenBets „LiveDoc" bei DAZN Bet über die neue Transportschicht.
 *
 * Aus dem Bündel (`0bw92k~.i2a_o.js`) stammen die Zieladressen:
 *   eventmap/{typ}{sportId}   z.B. `eventmap/upcomingFBL`  → Kupon
 *   events/{eventId}                                        → Partie-Kopf
 *   markets/{eventId}                                       → Quoten
 *
 * Diese Sonde beantwortet, was daraus für den Adapter zu holen ist: wie viele
 * Partien der Kupon hergibt, wo Teamnamen und Anstoßzeit stehen, ob eine
 * Sportradar-Kennung dabei ist und wie die Märkte aufgebaut sind.
 */
import { LiveDocClient } from '../server/livedoc.ts'

const HOST = 'sb-pp-defe.daznbet.de'
const LANG = 'de'

const eventmap = new LiveDocClient({ host: HOST, service: '/eventmaplivedocl1/livedoc' })
const events = new LiveDocClient({ host: HOST, service: '/eventlivedocl1/livedoc' })
const markets = new LiveDocClient({ host: HOST, service: '/marketlivedocl1/livedoc' })

const short = (v: unknown, n = 700) => JSON.stringify(v).slice(0, n)

// 1. Kupon — wie groß darf X-Size sein?
for (const size of [50, 200, 1000]) {
  const doc = await eventmap.document<{ events?: Record<string, unknown> }>('eventmap/upcomingFBL', {
    'X-Lang': LANG,
    'X-Size': size,
    'X-Sort': 'date',
    'X-Order': 'asc',
    'X-IncludeComp': false,
    sendEmpty: true,
  })
  console.log(`X-Size ${String(size).padStart(4)} → ${Object.keys(doc.events ?? {}).length} Partien`)
}

const coupon = await eventmap.document<{ events?: Record<string, any> }>('eventmap/upcomingFBL', {
  'X-Lang': LANG,
  'X-Size': 1000,
  'X-Sort': 'date',
  'X-Order': 'asc',
  'X-IncludeComp': false,
  sendEmpty: true,
})
const ids = Object.keys(coupon.events ?? {})
console.log(`\nKupon-Eintrag: ${short(Object.values(coupon.events ?? {})[0], 500)}`)

// 2. Partie-Kopf — Teamnamen, Anstoß, evtl. Fremdkennungen
const id = ids[0]
console.log(`\n== events/${id}`)
const ev = await events.document<any>(`events/${id}`, { 'X-Lang': LANG, sendEmpty: true })
console.log(`Schlüssel: ${Object.keys(ev).join(', ')}`)
console.log(short(ev, 1400))

// 3. Märkte. `markets/{param}` nimmt eine **Markt**-Kennung, keine
//    Event-Kennung — die Kennungen stehen in `miniCoupons` des Partie-Kopfs.
//    Daneben gibt es `eventmarketsmap/{eventId}`, das alle Märkte einer Partie
//    auf einmal liefern könnte; genau das ist hier die Frage.
console.log(`\n== eventmarketsmap/${id}`)
try {
  const map = await markets.document<any>(`eventmarketsmap/${id}`, { 'X-Lang': LANG, sendEmpty: true })
  console.log(`Schlüssel: ${Object.keys(map).join(', ')}`)
  console.log(short(map, 900))
} catch (e) {
  console.log(`  ${e instanceof Error ? e.message : e}`)
}

const marketId: string | undefined = ev.miniCoupons?.MAIN?.[0]
if (marketId) {
  console.log(`\n== markets/${marketId}  (MAIN aus miniCoupons)`)
  const mk = await markets.document<any>(`markets/${marketId}`, { 'X-Lang': LANG, sendEmpty: true })
  console.log(`Schlüssel: ${Object.keys(mk).join(', ')}`)
  console.log(short(mk, 1200))
}

eventmap.close()
events.close()
markets.close()
process.exit(0)
