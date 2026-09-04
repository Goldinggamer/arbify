import type { Opportunity, Settings } from '../types'
import { BOOKMAKER_BY_ID } from '../data/bookmakers'
import { WARNING_BY_ID } from '../data/warnings'
import { arbFor } from '../lib/arbitrage'
import { money, moneyShort, odds as fmtOdds, pct, relativeTime } from '../lib/format'
import { BookLogo } from './BookLogo'
import { IconArrowUpRight, IconWarn } from './icons'

export function OpportunityCard({
  opp,
  settings,
  selected,
  onSelect,
}: {
  opp: Opportunity
  settings: Settings
  selected: boolean
  onSelect: () => void
}) {
  const arb = arbFor(opp, settings)

  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-2xl border p-3 text-left transition ${
        selected
          ? 'border-accent/40 bg-surface-2'
          : 'border-line-soft bg-surface hover:border-line hover:bg-surface-2'
      }`}
    >
      <div className="flex items-stretch gap-3">
        {/* Kennzahlen */}
        <div className="flex w-[104px] shrink-0 flex-col justify-center gap-0.5 pl-1">
          <span className="text-[22px] font-bold leading-none text-accent">{pct(arb.arbPercent)}</span>
          <span className="text-[12px] font-semibold text-muted">
            {arb.guaranteedProfit >= 0 ? '+' : ''}
            {money(arb.guaranteedProfit)}
          </span>
          {arb.legs.some((l) => l.taxed) && (
            <span
              title="Mindestens ein Anbieter gibt die 5,3 % Wettsteuer an den Kunden weiter. Die Rendite links enthält diesen Abzug nicht."
              className="mt-1 w-fit rounded bg-warn/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-warn"
            >
              Wettsteuer
            </span>
          )}
        </div>

        {/* Partie */}
        <div className="flex w-[190px] shrink-0 flex-col justify-center gap-1 border-l border-line-soft pl-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
            {relativeTime(opp.startTime)}
          </div>
          <div className="text-[13px] font-semibold leading-tight">
            {opp.home}
            <span className="text-muted"> vs </span>
            {opp.away}
          </div>
          <div className="truncate text-[11px] text-muted">{opp.league}</div>
        </div>

        {/* Markt */}
        <div className="flex w-[150px] shrink-0 flex-col justify-center border-l border-line-soft pl-3">
          <span className="text-[10px] uppercase tracking-wider text-muted">{opp.sport}</span>
          <span className="text-[14px] font-bold leading-tight">{opp.market}</span>
          {opp.warnings.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {opp.warnings.map((w) => (
                <span
                  key={w}
                  title={WARNING_BY_ID[w].detail}
                  className="flex items-center gap-1 rounded bg-warn/10 px-1.5 py-0.5 text-[9px] font-semibold text-warn"
                >
                  <IconWarn className="h-2.5 w-2.5" />
                  {WARNING_BY_ID[w].label}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Beine */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 border-l border-line-soft pl-3">
          {arb.legs.map((leg) => {
            const book = BOOKMAKER_BY_ID[leg.bookmakerId]
            return (
              <div
                key={leg.index}
                className="flex items-center gap-2 rounded-xl bg-surface-2/70 px-2.5 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{leg.label}</span>
                <span className="rounded-lg bg-ink px-2.5 py-1 text-[13px] font-bold tabular-nums">
                  {moneyShort(leg.stake)}
                </span>
                <BookLogo id={leg.bookmakerId} size="sm" />
                <span
                  className={`w-12 text-right text-[13px] font-semibold tabular-nums ${
                    leg.taxed ? 'text-warn' : 'text-dim'
                  }`}
                  title={leg.taxed ? 'Auf dieses Bein kommt die Wettsteuer noch drauf' : undefined}
                >
                  {fmtOdds(leg.odds)}
                </span>
                <a
                  href={opp.links?.[leg.bookmakerId] ?? book?.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-3 text-muted transition hover:bg-accent hover:text-ink"
                  title={`Bei ${book?.name} öffnen`}
                >
                  <IconArrowUpRight className="h-3.5 w-3.5" />
                </a>
              </div>
            )
          })}
        </div>
      </div>
    </button>
  )
}
