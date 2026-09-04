import { useEffect, useMemo, useRef, useState } from 'react'
import type { Opportunity, Settings } from '../types'
import { BOOKMAKER_BY_ID } from '../data/bookmakers'
import { WARNING_BY_ID } from '../data/warnings'
import { arbFor, taxedBooksOf } from '../lib/arbitrage'
import { taxLabel, taxOf } from '../data/tax'
import { money, moneyShort, odds as fmtOdds, pct, relativeTime, signedMoney } from '../lib/format'
import { BookLogo } from './BookLogo'
import { IconArrowUpRight, IconCheck, IconWarn } from './icons'

export function DetailPanel({
  opp,
  settings,
  onBankrollChange,
}: {
  opp: Opportunity | null
  settings: Settings
  onBankrollChange: (v: number) => void
}) {
  const scroller = useRef<HTMLElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [opp?.id])

  if (!opp) {
    return (
      <aside className="hidden w-[420px] shrink-0 flex-col items-center justify-center gap-3 border-l border-line px-8 text-center xl:flex">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-surface text-muted">
          <IconCheck className="h-6 w-6" />
        </div>
        <p className="text-[13px] text-muted">
          Wähle links eine Wettmöglichkeit aus, um die Einsatzaufteilung zu sehen.
        </p>
      </aside>
    )
  }

  return (
    <aside
      ref={scroller}
      className="hidden w-[420px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-line p-4 xl:flex"
    >
      <Summary opp={opp} settings={settings} onBankrollChange={onBankrollChange} />
      <Outcomes opp={opp} settings={settings} />
      <OddsTable opp={opp} />
    </aside>
  )
}

function Summary({
  opp,
  settings,
  onBankrollChange,
}: {
  opp: Opportunity
  settings: Settings
  onBankrollChange: (v: number) => void
}) {
  const arb = arbFor(opp, settings)

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-[26px] font-bold leading-none text-accent">{pct(arb.arbPercent)}</span>
            <span className="text-[13px] font-semibold text-muted">Rendite</span>
          </div>
          <p className="mt-1 text-[12px] text-muted">
            {relativeTime(opp.startTime)} · {opp.league}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-medium text-muted">Garantierter Gewinn</p>
          <p className="text-[20px] font-bold leading-tight text-accent">
            {signedMoney(arb.guaranteedProfit)}
          </p>
        </div>
      </div>

      <p className="mt-3 text-[14px] font-semibold leading-tight">
        {opp.home} <span className="text-muted">vs</span> {opp.away}
      </p>
      <p className="text-[12px] text-muted">{opp.market}</p>

      {/*
        Die Steuer-Warnung wird hier ausgelassen: sie steht weiter unten als
        `TaxNotice`, und zwar mit den konkreten Anbietern und dem Vergleich mit
        und ohne Steuer. Zweimal derselbe Hinweis im selben Bereich liest sich
        wie zwei verschiedene Probleme.
      */}
      {opp.warnings.some((w) => w !== 'betting-tax') && (
        <div className="mt-3 space-y-1.5">
          {opp.warnings.filter((w) => w !== 'betting-tax').map((w) => (
            <div key={w} className="flex gap-2 rounded-lg bg-warn/8 p-2 text-[11px] text-warn">
              <IconWarn className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <b className="font-semibold">{WARNING_BY_ID[w].label}:</b> {WARNING_BY_ID[w].detail}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Bankroll-Slider */}
      <div className="mt-4 border-t border-line-soft pt-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Eingesetzte Bankroll
          </span>
          <span className="text-[13px] font-bold tabular-nums">{money(arb.totalStake)}</span>
        </div>
        <input
          type="range"
          min={10}
          max={Math.max(5000, settings.bankroll)}
          step={10}
          value={settings.bankroll}
          onChange={(e) => onBankrollChange(Number(e.target.value))}
          className="w-full"
        />
        <p className="mt-2 text-[11px] text-muted">
          Einsatzlimits werden bewusst nicht angezeigt: der maßgebliche Wert steht erst im
          Wettschein der angemeldeten Sitzung und weicht dort regelmäßig von der ausgeloggten
          Ansicht ab. Vor dem Setzen selbst prüfen.
        </p>
      </div>

      <TaxNotice opp={opp} />

      {/* Einsätze */}
      <div className="mt-3 space-y-2">
        {arb.legs.map((leg) => {
          const book = BOOKMAKER_BY_ID[leg.bookmakerId]
          return (
            <div key={leg.index} className="flex items-center gap-2 rounded-xl bg-surface-2 px-2.5 py-2">
              <BookLogo id={leg.bookmakerId} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold leading-tight">{leg.label}</p>
                <p className="text-[10px] text-muted">
                  {book?.name} · Quote {fmtOdds(leg.odds)}
                  {leg.taxed && (
                    <span className="text-warn" title={taxLabel(taxOf(leg.bookmakerId).mode)}>
                      {' '}
                      · Wettsteuer
                    </span>
                  )}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[14px] font-bold tabular-nums">{moneyShort(leg.stake)}</p>
                <p className="text-[10px] text-muted tabular-nums">{(leg.share * 100).toFixed(1)} %</p>
              </div>
              <a
                href={opp.links?.[leg.bookmakerId] ?? book?.url}
                target="_blank"
                rel="noreferrer noopener"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-3 text-muted transition hover:bg-accent hover:text-ink"
              >
                <IconArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </div>
          )
        })}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line-soft pt-3 text-center">
        <Stat label="Gesamteinsatz" value={money(arb.totalStake)} />
        <Stat label="Auszahlung" value={money(arb.totalStake + arb.guaranteedProfit)} accent />
        <Stat label="Theoretisch" value={pct(arb.theoreticalPercent)} />
      </div>
    </section>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className={`text-[13px] font-bold tabular-nums ${accent ? 'text-accent' : ''}`}>{value}</p>
    </div>
  )
}

function Outcomes({ opp, settings }: { opp: Opportunity; settings: Settings }) {
  const arb = arbFor(opp, settings)
  const maxAbs = Math.max(1, ...arb.legs.map((l) => Math.max(l.payout - l.stake, l.stake)))

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h3 className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.18em] text-muted">
        Ergebnisse
      </h3>
      <div className={`grid gap-3 ${arb.legs.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {arb.legs.map((winner) => (
          <div key={winner.index} className="rounded-xl bg-surface-2 p-2.5">
            <p className="flex items-center justify-center gap-1 truncate text-center text-[12px] font-semibold">
              <IconCheck className="h-3 w-3 shrink-0 text-accent" />
              <span className="truncate">{winner.label}</span>
            </p>
            <p className="mb-2 text-center text-[15px] font-bold text-accent tabular-nums">
              {signedMoney(winner.profit)}
            </p>
            <div className="flex items-end justify-center gap-1.5">
              {arb.legs.map((leg) => {
                const value = leg.index === winner.index ? leg.payout - leg.stake : -leg.stake
                const h = Math.max(6, (Math.abs(value) / maxAbs) * 56)
                return (
                  <div key={leg.index} className="flex w-7 flex-col items-center gap-1">
                    <div className="flex h-14 w-full items-end">
                      <div
                        className={`w-full rounded-md ${value >= 0 ? 'bg-accent/80' : 'bg-danger/70'}`}
                        style={{ height: h }}
                      />
                    </div>
                    <BookLogo id={leg.bookmakerId} size="sm" className="!h-5 !w-5 !text-[7px]" />
                    <span className={`text-[9px] font-semibold tabular-nums ${value >= 0 ? 'text-accent' : 'text-danger'}`}>
                      {value >= 0 ? '+' : '−'}
                      {Math.abs(Math.round(value))}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function OddsTable({ opp }: { opp: Opportunity }) {
  const [sortDesc, setSortDesc] = useState(true)

  const rows = useMemo(() => {
    const ids = new Set<string>()
    opp.outcomes.forEach((o) => o.all.forEach((b) => ids.add(b.bookmakerId)))
    const list = [...ids].map((id) => ({
      id,
      cells: opp.outcomes.map((o) => o.all.find((b) => b.bookmakerId === id)),
    }))
    const score = (r: (typeof list)[number]) =>
      r.cells.reduce((s, c) => s + (c ? c.odds : 0), 0) / Math.max(1, r.cells.filter(Boolean).length)
    return list.sort((a, b) => (sortDesc ? score(b) - score(a) : score(a) - score(b)))
  }, [opp, sortDesc])

  const best = opp.outcomes.map((o) => Math.max(...o.all.map((b) => b.odds)))
  const avg = opp.outcomes.map((o) => o.all.reduce((s, b) => s + b.odds, 0) / o.all.length)

  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h3 className="mb-3 text-center text-[11px] font-bold uppercase tracking-[0.18em] text-muted">
        Quotenvergleich
      </h3>

      <div className="grid items-center gap-2" style={{ gridTemplateColumns: `1fr 64px ${'1fr '.repeat(opp.outcomes.length - 1)}` }}>
        <div className="text-center text-[12px] font-bold">{opp.outcomes[0].label}</div>
        <button
          onClick={() => setSortDesc((s) => !s)}
          className="mx-auto grid h-6 w-6 place-items-center rounded-md text-muted transition hover:bg-surface-2 hover:text-white"
          title="Sortierung umkehren"
        >
          {sortDesc ? '↓' : '↑'}
        </button>
        {opp.outcomes.slice(1).map((o) => (
          <div key={o.label} className="text-center text-[12px] font-bold">
            {o.label}
          </div>
        ))}

        {/* Bestquote */}
        <Cell value={fmtOdds(best[0])} highlight />
        <Label text="Beste Quote" />
        {best.slice(1).map((v, i) => (
          <Cell key={i} value={fmtOdds(v)} highlight />
        ))}

        {/* Durchschnitt */}
        <Cell value={fmtOdds(avg[0])} />
        <Label text="Ø Quote" />
        {avg.slice(1).map((v, i) => (
          <Cell key={i} value={fmtOdds(v)} />
        ))}
      </div>

      <div className="mt-2 space-y-1.5">
        {rows.map((row) => {
          const book = BOOKMAKER_BY_ID[row.id]
          return (
            <div
              key={row.id}
              className="grid items-center gap-2"
              style={{ gridTemplateColumns: `1fr 64px ${'1fr '.repeat(opp.outcomes.length - 1)}` }}
            >
              <OddsCell cell={row.cells[0]} isBest={row.cells[0]?.odds === best[0]} url={opp.links?.[row.id] ?? book?.url} />
              <div className="grid place-items-center">
                <BookLogo id={row.id} size="sm" />
              </div>
              {row.cells.slice(1).map((c, i) => (
                <OddsCell key={i} cell={c} isBest={c?.odds === best[i + 1]} url={opp.links?.[row.id] ?? book?.url} />
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Label({ text }: { text: string }) {
  return (
    <div className="text-center text-[9px] font-semibold uppercase leading-tight tracking-wider text-muted">
      {text}
    </div>
  )
}

function Cell({ value, highlight }: { value: string; highlight?: boolean }) {
  return (
    <div
      className={`rounded-lg py-1.5 text-center text-[13px] font-bold tabular-nums ${
        highlight ? 'bg-accent/12 text-accent' : 'bg-surface-2 text-dim'
      }`}
    >
      {value}
    </div>
  )
}

function OddsCell({
  cell,
  isBest,
  url,
}: {
  cell?: { odds: number }
  isBest?: boolean
  url?: string
}) {
  if (!cell) return <div className="rounded-lg bg-surface-2/40 py-1.5 text-center text-[12px] text-muted">—</div>
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className={`group flex items-center justify-between gap-1 rounded-lg px-2 py-1 transition ${
        isBest ? 'bg-accent/12 hover:bg-accent/20' : 'bg-surface-2 hover:bg-surface-3'
      }`}
    >
      <span className="flex flex-col leading-tight">
        <span className={`text-[13px] font-bold tabular-nums ${isBest ? 'text-accent' : ''}`}>
          {fmtOdds(cell.odds)}
        </span>
      </span>
      <IconArrowUpRight className="h-3 w-3 shrink-0 text-muted opacity-0 transition group-hover:opacity-100" />
    </a>
  )
}

/**
 * Der Steuer-Hinweis an der einzelnen Wette.
 *
 * Er steht bewusst direkt unter der Einsatzaufteilung: die 5,3 % entscheiden
 * bei einer typischen Arbitrage von 2–4 % über Gewinn und Verlust, und sie
 * fallen je nach Anbieter unterschiedlich an. Wer nur die Prozentzahl oben
 * liest, muss trotzdem sehen, welches der beiden Bücher ihm die Steuer
 * weiterreicht — sonst wundert er sich erst im Wettschein über eine Quote, die
 * nicht zur Anzeige passt.
 *
 * Bewusst ohne eigene Rechnung: die Renditen in dieser App sind reine
 * Quotenwerte. Was am Ende hängen bleibt, hängt am Konto — an Freiwetten, an
 * Aktionen, an der im Wettschein tatsächlich angezeigten Quote. Eine
 * „Rendite nach Steuer", die das nicht kennt, wäre eine Zahl mit falscher
 * Sicherheit.
 */
function TaxNotice({ opp }: { opp: Opportunity }) {
  const taxed = taxedBooksOf(opp)
  const free = [...new Set(opp.outcomes.map((o) => o.best.bookmakerId))].filter(
    (id) => !taxed.includes(id),
  )
  const name = (id: string) => BOOKMAKER_BY_ID[id]?.name ?? id

  if (!taxed.length) {
    return (
      <div className="mt-3 rounded-xl border border-line-soft bg-surface-2/50 p-2.5 text-[11px] leading-relaxed text-muted">
        <b className="font-semibold text-accent">Keine Wettsteuer.</b> {free.map(name).join(' und ')}{' '}
        {free.length > 1 ? 'übernehmen' : 'übernimmt'} die 5,3 % selbst — die Quoten oben sind die,
        die im Wettschein stehen.
      </div>
    )
  }

  const unverified = taxed.filter((id) => !taxOf(id).verified)
  const notes = taxed.map((id) => taxOf(id).note).filter(Boolean)

  return (
    <div className="mt-3 rounded-xl border border-warn/25 bg-warn/8 p-2.5 text-[11px] leading-relaxed text-warn">
      <div className="flex gap-2">
        <IconWarn className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="space-y-1.5">
          <p>
            <b className="font-semibold">Wettsteuer fällt an.</b>{' '}
            {taxed.map((id) => `${name(id)}: ${taxLabel(taxOf(id).mode)}`).join(' · ')}.
          </p>
          {notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
          <p>
            Die Rendite oben ist aus den reinen Quoten gerechnet und enthält diesen Abzug
            <b> nicht</b>.
            {free.length > 0 && ` Bei ${free.map(name).join(' und ')} fällt keine Steuer an.`}
          </p>
          {unverified.length > 0 && (
            <p className="text-[10.5px] opacity-90">
              Für {unverified.map(name).join(', ')} ließ sich die Handhabung nicht sicher belegen —
              hier ist der Hinweis eine Annahme, kein Beleg.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
