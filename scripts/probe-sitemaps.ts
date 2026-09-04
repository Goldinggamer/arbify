/**
 * Liest Sitemaps und robots.txt der verbliebenen Anbieter.
 *
 * Bisher habe ich Sport-Pfade geraten und meist 404 bekommen. Sitemaps
 * verraten die tatsächliche URL-Struktur — und ob es überhaupt öffentlich
 * indexierte Wettseiten gibt.
 */
import { Impit } from 'impit'

const impit = new Impit({ browser: 'chrome' })
const H = { 'accept-language': 'de-DE,de;q=0.9' }

const HOSTS: Record<string, string> = {
  betathome: 'https://www.bet-at-home.de',
  neobet: 'https://neobet.de',
  daznbet: 'https://www.daznbet.de',
  tipwin: 'https://www.tipwin.de',
  tiptorro: 'https://www.tiptorro.com',
  intertops: 'https://www.intertops.de',
  happybet: 'https://www.happybet.de',
  merkurbets: 'https://www.merkurbets.de',
  admiralbet: 'https://www.admiralbet.de',
}

const SPORT_RE = /sport|wett|fussball|football|betting|quoten/i

for (const [id, host] of Object.entries(HOSTS)) {
  const found = new Set<string>()
  let note = ''

  // robots.txt nennt oft die Sitemaps
  const sitemaps: string[] = [`${host}/sitemap.xml`, `${host}/sitemap_index.xml`]
  try {
    const r = await impit.fetch(`${host}/robots.txt`, { headers: H })
    if (r.status === 200) {
      const txt = await r.text()
      for (const m of txt.matchAll(/Sitemap:\s*(\S+)/gi)) sitemaps.unshift(m[1])
    }
  } catch {
    note = 'robots nicht erreichbar'
  }

  for (const sm of [...new Set(sitemaps)].slice(0, 4)) {
    try {
      const r = await impit.fetch(sm, { headers: H })
      if (r.status !== 200) continue
      const xml = await r.text()
      // Verschachtelte Sitemaps einmal auflösen
      const children = [...xml.matchAll(/<loc>([^<]+\.xml[^<]*)<\/loc>/g)].map((m) => m[1]).slice(0, 3)
      for (const c of children) {
        try {
          const cr = await impit.fetch(c, { headers: H })
          if (cr.status !== 200) continue
          const cx = await cr.text()
          for (const m of cx.matchAll(/<loc>([^<]+)<\/loc>/g)) if (SPORT_RE.test(m[1])) found.add(m[1])
        } catch {
          /* weiter */
        }
      }
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) if (SPORT_RE.test(m[1])) found.add(m[1])
    } catch {
      /* weiter */
    }
  }

  const list = [...found].filter((u) => !u.endsWith('.xml')).slice(0, 4)
  console.log(`${id.padEnd(12)} ${String(found.size).padStart(4)} Sport-URLs  ${note}`)
  for (const u of list) console.log(`             ${u.slice(0, 96)}`)
}
