/** Prüft die beiden aus den Sitemaps gewonnenen Pfade auf Quoten. */
import { Impit } from 'impit'

const impit = new Impit({ browser: 'chrome' })
const H = { 'accept-language': 'de-DE,de;q=0.9' }

const TARGETS = [
  ['bet-at-home', 'https://www.bet-at-home.de/de/sports/i'],
  ['bet-at-home live', 'https://www.bet-at-home.de/de/live-sports/i/live-sports/'],
  ['tiptorro', 'https://tiptorro.de/sports/'],
  ['tiptorro root', 'https://tiptorro.de/'],
]

const SIGNALS: [string, RegExp][] = [
  ['Quoten im HTML', /"(?:odds|price|oddsDecimal|quote|OddValue)[A-Za-z_]*"\s*:\s*"?\d+[.,]\d/],
  ['data-Quoten', /data-(?:odd|betting|price)[^=]*="[^"]*\d[.,]\d/i],
  ['Kambi', /kambicdn/i],
  ['Altenar', /altenar|biahosted/i],
  ['BetConstruct', /betconstruct|swarm/i],
  ['Digitain', /digitain/i],
  ['Cashpoint', /cashpoint/i],
  ['SignalR', /signalr/i],
]

for (const [name, url] of TARGETS) {
  try {
    const r = await impit.fetch(url, { headers: H })
    const body = await r.text()
    const hits = SIGNALS.filter(([, re]) => re.test(body)).map(([n]) => n)
    console.log(`\n${name}  →  HTTP ${r.status}, ${Math.round(body.length / 1024)} KB`)
    console.log(`  Signale: ${hits.join(', ') || '—'}`)

    // Fremde Hosts im Markup: dort liegt meist die eigentliche API
    const hosts = [...new Set([...body.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1]))]
      .filter((h) => !/google|gstatic|facebook|doubleclick|cookiebot|onetrust|jquery|cloudflare|youtube|trustpilot/i.test(h))
      .filter((h) => !h.includes(new URL(url).hostname.replace('www.', '')))
    console.log(`  Fremde Hosts: ${hosts.slice(0, 6).join('  ') || '—'}`)

    // Skripte, die eine API-Basis enthalten könnten
    const scripts = [...new Set([...body.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi)].map((m) => m[1]))]
    console.log(`  Bundles: ${scripts.length}`)
  } catch (e) {
    console.log(`\n${name}  →  nicht erreichbar (${e instanceof Error ? e.message.slice(0, 50) : ''})`)
  }
}
