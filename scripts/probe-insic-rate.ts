import { Impit } from 'impit'

/**
 * Prüft, ob eventservice.sportwetten.de überhaupt ratenbegrenzt.
 *
 * `rows=1` hält die Antworten klein (~2 KB statt 5,8 MB), damit allein die
 * Abrufrate gemessen wird und nicht die Bandbreite.
 */

const impit = new Impit({ browser: 'chrome' })
const HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
}

const url = (i: number) =>
  `https://eventservice.sportwetten.de/de/v1/events?sportsbook_id=0&offset=${i % 5 * 200}&rows=1&sort=sportsStandard`

async function hit(i: number): Promise<number> {
  try {
    const res = await impit.fetch(url(i), { headers: HEADERS })
    await res.text()
    return res.status
  } catch {
    return -1
  }
}

function report(tag: string, codes: number[], ms: number) {
  const counts = new Map<number, number>()
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1)
  const summary = [...counts].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(' ')
  console.log(`${tag.padEnd(34)} n=${codes.length} ${(ms / 1000).toFixed(1)}s  ${summary}`)
}

const N = Number(process.env.N ?? 150)

// A — so schnell wie möglich, sequentiell, kein Abstand
{
  const t0 = Date.now()
  const codes: number[] = []
  for (let i = 0; i < N; i++) codes.push(await hit(i))
  report('A sequentiell, 0 ms Abstand', codes, Date.now() - t0)
}

// B — 10 gleichzeitig
{
  const t0 = Date.now()
  const codes: number[] = []
  let cursor = 0
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      while (cursor < N) codes.push(await hit(cursor++))
    }),
  )
  report('B parallel, 10 gleichzeitig', codes, Date.now() - t0)
}

// C — 40 gleichzeitig, harter Burst
{
  const t0 = Date.now()
  const codes = await Promise.all(Array.from({ length: 40 }, (_, i) => hit(i)))
  report('C Burst, 40 gleichzeitig', codes, Date.now() - t0)
}
