import { useEffect, useState } from 'react'
import { IconFilter, IconRefresh, IconSearch, IconSliders, IconWallet } from './icons'
import { moneyShort } from '../lib/format'

type Props = {
  /** Anzahl gefundener Vorspiel-Wettmöglichkeiten */
  count: number
  bankroll: number
  onBankrollChange: (v: number) => void
  search: string
  onSearchChange: (v: string) => void
  activeFilterCount: number
  onOpenFilters: () => void
  onOpenSettings: () => void
  onRefresh: () => void
  lastUpdate: Date
  refreshing: boolean
}

const QUICK_BANKROLLS = [100, 250, 500, 1000, 2500, 5000]

export function Header({
  count,
  bankroll,
  onBankrollChange,
  search,
  onSearchChange,
  activeFilterCount,
  onOpenFilters,
  onOpenSettings,
  onRefresh,
  lastUpdate,
  refreshing,
}: Props) {
  const [draft, setDraft] = useState(String(bankroll))
  const [open, setOpen] = useState(false)

  useEffect(() => setDraft(String(bankroll)), [bankroll])

  const commit = () => {
    const v = Number(draft.replace(',', '.').replace(/[^\d.]/g, ''))
    onBankrollChange(Number.isFinite(v) && v > 0 ? Math.min(v, 10_000_000) : bankroll)
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-bg/95 px-4 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-ink">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 17 9 9l4 5 3-4 4 7" />
          </svg>
        </div>
        <span className="text-[19px] font-extrabold tracking-tight">Arbify</span>
      </div>

      {/* Kein Live-Umschalter mehr: laufende Spiele sind bewusst kein
          Produkt. Die Kennzahl bleibt als Orientierung stehen. */}
      <div className="ml-2 flex items-center gap-2 rounded-xl bg-surface px-3.5 py-1.5">
        <span className="text-[13px] font-semibold text-white">Vorspiel</span>
        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-bold text-accent">
          {count}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className="relative hidden md:block">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Team, Liga oder Markt suchen"
            className="h-9 w-72 rounded-xl border border-line bg-surface pl-9 pr-3 text-[13px] outline-none placeholder:text-muted focus:border-accent/50"
          />
        </div>

        {/* Bankroll */}
        <div className="relative">
          <div
            className={`flex h-9 items-center gap-2 rounded-xl border bg-surface pl-3 pr-1.5 transition ${
              open ? 'border-accent/60' : 'border-line'
            }`}
          >
            <IconWallet className="h-4 w-4 text-accent" />
            <div className="flex flex-col leading-none">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-muted">Bankroll</span>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={() => setOpen(true)}
                onBlur={() => {
                  commit()
                  window.setTimeout(() => setOpen(false), 120)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                inputMode="decimal"
                className="w-20 bg-transparent text-[14px] font-bold outline-none"
              />
            </div>
            <span className="pr-1 text-[13px] font-bold text-dim">€</span>
          </div>
          {open && (
            <div className="animate-in-up absolute right-0 top-11 z-40 w-56 rounded-xl border border-line bg-surface p-2 shadow-2xl shadow-black/50">
              <p className="px-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                Schnellauswahl
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {QUICK_BANKROLLS.map((v) => (
                  <button
                    key={v}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      onBankrollChange(v)
                    }}
                    className={`rounded-lg px-2 py-1.5 text-[12px] font-semibold transition ${
                      bankroll === v ? 'bg-accent text-ink' : 'bg-surface-2 text-dim hover:bg-surface-3'
                    }`}
                  >
                    {moneyShort(v)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onOpenFilters}
          className="relative flex h-9 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[13px] font-semibold text-dim transition hover:border-accent/40 hover:text-white"
        >
          <IconFilter />
          Filter
          {activeFilterCount > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-ink">
              {activeFilterCount}
            </span>
          )}
        </button>

        <button
          onClick={onOpenSettings}
          title="Einstellungen"
          className="grid h-9 w-9 place-items-center rounded-xl border border-line bg-surface text-dim transition hover:text-white"
        >
          <IconSliders />
        </button>

        <button
          onClick={onRefresh}
          title={`Zuletzt aktualisiert ${lastUpdate.toLocaleTimeString('de-DE')}`}
          className="grid h-9 w-9 place-items-center rounded-xl border border-line bg-surface text-dim transition hover:text-white"
        >
          <IconRefresh className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
      </div>
    </header>
  )
}
