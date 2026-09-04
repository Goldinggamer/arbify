/**
 * Zweite Runde LiveDoc: die Kostenfrage.
 *
 * `markets/{marktId}` liefert genau **einen** Markt. Eine Partie hat leicht
 * 50 davon — bei 500 Partien wären das Zehntausende Abos je Durchlauf. Bevor
 * daraus ein Adapter wird, muss klar sein, ob es einen Sammelabruf gibt.
 *
 * Geprüft wird:
 *   1. Steht in `events/{id}` eine Fremdkennung (Sportradar/Betradar)? Das
 *      entscheidet, ob die Zuordnung über einen ID-Join läuft oder über Namen.
 *   2. Gibt es `eventmarketsmap/{eventId}` — und auf welchem Dienst?
 *   3. Nimmt `markets/` mehrere Kennungen auf einmal?
 */
import { LiveDocClient } from '../server/livedoc.ts'

const HOST = 'sb-pp-defe.daznbet.de'
const LANG = 'de'

const eventmap = new LiveDocClient({ host: HOST, service: '/eventmaplivedocl1/livedoc' })
const events = new LiveDocClient({ host: HOST, service: '/eventlivedocl1/livedoc' })
const markets = new LiveDocClient({ host: HOST, service: '/marketlivedocl1/livedoc' })

const coupon = await eventmap.document<{ events?: Record<string, any> }>('eventmap/upcomingFBL', {
  'X-Lang': LANG,
  'X-Size': 20,
  'X-Sort': 'date',
  'X-Order': 'asc',
  sendEmpty: true,
})
const id = Object.keys(coupon.events ?? {})[0]
const ev = await events.document<any>(`events/${id}`, { 'X-Lang': LANG, sendEmpty: true })

console.log('1. Fremdkennungen')
console.log(`   externalId:   ${JSON.stringify(ev.externalId)}`)
console.log(`   feedId:       ${JSON.stringify(ev.feedId)}`)
console.log(`   properties:   ${JSON.stringify(ev.properties).slice(0, 400)}`)
console.log(`   marketsCount: ${ev.marketsCount}`)

console.log('\n2. Sammelabruf je Partie')
const ids: string[] = [...new Set(Object.values(ev.miniCoupons ?? {}).flat() as string[])].filter(Boolean)
console.log(`   miniCoupons nennen ${ids.length} verschiedene Märkte`)
for (const [service, client] of [
  ['marketlivedoc', markets],
  ['eventlivedoc', events],
] as const) {
  for (const dest of [`eventmarketsmap/${id}`, `marketscountperevent/${id}`]) {
    try {
      const d = await client.document<any>(dest, { 'X-Lang': LANG, sendEmpty: true })
      console.log(`   ${service.padEnd(14)} ${dest.padEnd(40)} → ${Object.keys(d).slice(0, 8).join(', ') || 'leer'}`)
    } catch (e) {
      console.log(`   ${service.padEnd(14)} ${dest.padEnd(40)} → ${e instanceof Error ? e.message.replace('LiveDoc: ', '') : e}`)
    }
  }
}

console.log('\n3. Mehrere Märkte in einem Abo')
for (const sep of [',', '_', '|']) {
  const dest = `markets/${ids.slice(0, 3).join(sep)}`
  try {
    const d = await markets.document<any>(dest, { 'X-Lang': LANG, sendEmpty: true })
    const n = Array.isArray(d) ? d.length : d.selections ? 1 : Object.keys(d).length
    console.log(`   Trenner "${sep}" → ${n} (Schlüssel: ${Object.keys(d).slice(0, 8).join(', ')})`)
  } catch (e) {
    console.log(`   Trenner "${sep}" → ${e instanceof Error ? e.message.replace('LiveDoc: ', '') : e}`)
  }
}

console.log('\n4. Taxonomie der Märkte dieser Partie')
for (const mid of ids.slice(0, 14)) {
  try {
    const m = await markets.document<any>(`markets/${mid}`, { 'X-Lang': LANG, sendEmpty: true })
    const sels = (m.selections?.[0] ?? []).map((s: any) => `${s.side ?? s.selTemplate}@${s.price?.dec}${s.line ? `/${s.line}` : ''}`)
    console.log(
      `   ${String(m.name).padEnd(34)} ${JSON.stringify(m.taxonomy)}  ${sels.slice(0, 4).join(' ')}`,
    )
  } catch (e) {
    console.log(`   ${mid} → ${e instanceof Error ? e.message.replace('LiveDoc: ', '') : e}`)
  }
}

eventmap.close()
events.close()
markets.close()
process.exit(0)
