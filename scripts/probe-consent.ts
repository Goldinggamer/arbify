/**
 * Prüft, welche der verbliebenen Anbieter hinter einem Zustimmungsdialog
 * hängen — und welche Bibliothek sie dafür einsetzen.
 *
 * Hintergrund: bei bet-at-home blockiert ein Cookie-Banner (z-index
 * 1999999999) das Booten der Wett-App vollständig. Wenn das bei mehreren so
 * ist, war meine Geo-Block-Annahme durchgehend falsch.
 */
import { Impit } from 'impit'

const impit = new Impit({ browser: 'chrome' })
const H = { 'accept-language': 'de-DE,de;q=0.9' }

const SITES: Record<string, string> = {
  betathome: 'https://www.bet-at-home.de/de/sports/i',
  merkurbets: 'https://www.merkurbets.de/sportwetten',
  admiralbet: 'https://www.admiralbet.de/de/sports/sportwetten/fussball',
  neobet: 'https://neobet.de/de/Sportwetten/Heute',
  daznbet: 'https://www.daznbet.de/sports/football',
  tipwin: 'https://www.tipwin.de/de/sports',
  tiptorro: 'https://tiptorro.de/sports/',
  intertops: 'https://www.intertops.de/',
  happybet: 'https://www.happybet.de/',
  '888sport': 'https://www.888sport.de/fussball/deutschland/bundesliga/',
  bet365: 'https://www.bet365.de/',
}

/** Verbreitete Zustimmungs-Bibliotheken an ihren Spuren im Markup erkennen. */
const CONSENT: [string, RegExp][] = [
  ['cookieconsent', /cc-window|cookieconsent/i],
  ['OneTrust', /onetrust|optanon/i],
  ['Cookiebot', /cookiebot/i],
  ['Usercentrics', /usercentrics/i],
  ['TrustArc', /trustarc|truste/i],
  ['Truendo', /truendo/i],
  ['Didomi', /didomi/i],
  ['eigene Lösung', /consent-?(banner|modal|overlay|dialog)|cookie-?(banner|popup|overlay)/i],
]

for (const [id, url] of Object.entries(SITES)) {
  try {
    const r = await impit.fetch(url, { headers: H })
    const body = await r.text()
    const hits = CONSENT.filter(([, re]) => re.test(body)).map(([n]) => n)
    const loading = /LoadingScreen|loading-screen|app-loader|splash/i.test(body)
    console.log(
      `${id.padEnd(12)} ${String(r.status).padEnd(4)} ${String(Math.round(body.length / 1024) + 'KB').padEnd(7)} ` +
        `${(hits.join(', ') || '—').padEnd(30)} ${loading ? 'Ladebildschirm' : ''}`,
    )
  } catch {
    console.log(`${id.padEnd(12)} nicht erreichbar`)
  }
}
