import type { CSSProperties } from 'react'
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
  index = 0,
}: {
  opp: Opportunity
  settings: Settings
  selected: boolean
  onSelect: () => void
  /** Position in der Liste — nur für die gestaffelte Einblendung. */
  index?: number
}) {
  const arb = arbFor(opp, settings)

  // Ein `div` statt `button`: in der Karte stecken Links zu den Buchmachern,
  // und ein `<a>` in einem `<button>` ist ungültiges HTML.
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` } as CSSProperties}
      className={`press-soft w-full animate-row-in rounded-[18px] bg-white p-4 text-left transition-[box-shadow,scale] ${
        selected ? 'shadow-selected' : 'shadow-card hover:shadow-raised'
      }`}
    >
      <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3.5 md:grid-cols-[92px_minmax(150px,1fr)_minmax(130px,200px)_minmax(300px,480px)] md:items-center">
        {/* Kennzahlen */}
        <div className="flex flex-col gap-1">
          <span className="figure text-[24px] font-semibold leading-none text-accent">{pct(arb.arbPercent)}</span>
          <span className="tabular text-[12.5px] font-medium text-muted">
            {arb.guaranteedProfit >= 0 ? '+' : ''}
            {money(arb.guaranteedProfit)}
          </span>
          {arb.legs.some((l) => l.taxed) && (
            <span
              title="Mindestens ein Anbieter gibt die 5,3 % Wettsteuer an den Kunden weiter. Die Rendite links enthält diesen Abzug nicht."
              className="mt-1 w-fit rounded-full bg-warn/10 px-2 py-0.5 text-[10.5px] font-medium text-warn"
            >
              Wettsteuer
            </span>
          )}
        </div>

        {/* Partie */}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[12px] text-muted">{relativeTime(opp.startTime)}</span>
          <span className="text-[15px] font-semibold leading-snug tracking-[-0.015em]">
            {opp.home}
            <span className="font-normal text-muted"> – </span>
            {opp.away}
          </span>
          <span className="truncate text-[12px] text-muted">{opp.league}</span>
        </div>

        {/* Markt */}
        <div className="col-span-2 flex min-w-0 flex-col gap-0.5 md:col-span-1">
          <span className="text-[12px] text-muted">{opp.sport}</span>
          <span className="text-[14px] font-medium leading-snug">{opp.market}</span>
          {opp.warnings.some((w) => w !== 'betting-tax') && (
            <div className="mt-1 flex flex-wrap gap-1">
              {opp.warnings
                .filter((w) => w !== 'betting-tax')
                .map((w) => (
                  <span
                    key={w}
                    title={WARNING_BY_ID[w].detail}
                    className="flex items-center gap-1 rounded-full bg-warn/10 px-2 py-0.5 text-[10.5px] font-medium text-warn"
                  >
                    <IconWarn className="h-2.5 w-2.5" />
                    {WARNING_BY_ID[w].label}
                  </span>
                ))}
            </div>
          )}
        </div>

        {/* Beine: Anbieter · Ausgang · Quote · Einsatz · Link */}
        <div className="col-span-2 flex min-w-0 flex-col gap-1.5 md:col-span-1">
          {arb.legs.map((leg) => {
            const book = BOOKMAKER_BY_ID[leg.bookmakerId]
            return (
              <div key={leg.index} className="flex h-11 items-center gap-3 rounded-xl bg-surface-2 pl-2.5 pr-1.5">
                <BookLogo id={leg.bookmakerId} size="sm" />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{leg.label}</span>
                <span
                  className={`tabular w-11 text-right text-[13.5px] font-semibold ${leg.taxed ? 'text-warn' : 'text-fg'}`}
                  title={leg.taxed ? `Quote bei ${book?.name} — hier kommt die Wettsteuer noch drauf` : `Quote bei ${book?.name}`}
                >
                  {fmtOdds(leg.odds)}
                </span>
                <span className="tabular min-w-[78px] rounded-lg bg-white px-2.5 py-1 text-right text-[13.5px] font-semibold shadow-[0_0_0_0.5px_oklch(0_0_0/0.08),0_1px_2px_oklch(0_0_0/0.05)]">
                  {moneyShort(leg.stake)}
                </span>
                <a
                  href={opp.links?.[leg.bookmakerId] ?? book?.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-accent hover:bg-accent hover:text-white"
                  title={`Bei ${book?.name} öffnen`}
                  aria-label={`Bei ${book?.name} öffnen`}
                >
                  <IconArrowUpRight className="h-3.5 w-3.5" />
                </a>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
