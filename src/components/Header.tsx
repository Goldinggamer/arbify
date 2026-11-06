import { useEffect, useRef, useState } from 'react'
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

/** Randloses Feld wie in macOS: getönte Fläche, beim Fokus weiß mit blauem Ring. */
const FIELD =
  'rounded-[10px] bg-black/[0.05] transition-[background-color,box-shadow] hover:bg-black/[0.07] focus-within:bg-white focus-within:shadow-[0_0_0_0.5px_oklch(0_0_0/0.1),0_0_0_4px_oklch(0.48_0.2_264/0.16)]'

const TOOL =
  'grid h-9 min-w-9 place-items-center rounded-[10px] text-dim hover:bg-black/[0.05] hover:text-fg'

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
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(String(bankroll)), [bankroll])

  // „/“ springt in die Suche, wie in den meisten Werkzeugen mit Liste.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const commit = () => {
    const v = Number(draft.replace(',', '.').replace(/[^\d.]/g, ''))
    onBankrollChange(Number.isFinite(v) && v > 0 ? Math.min(v, 10_000_000) : bankroll)
  }

  return (
    <header className="material sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line-soft px-3 sm:gap-3 sm:px-5">
      <div className="flex items-center gap-2.5">
        <div className="grid h-8 w-8 place-items-center rounded-[9px] bg-gradient-to-b from-[#3a6bf0] to-accent text-white shadow-[inset_0_0.5px_0_oklch(1_0_0/0.4),0_1px_3px_oklch(0.48_0.2_264/0.35)]">
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 17 9 9l4 5 3-4 4 7" />
          </svg>
        </div>
        <span className="hidden text-[17px] font-semibold tracking-[-0.022em] sm:inline">Arbify</span>
      </div>

      {/* Kein Live-Umschalter mehr: laufende Spiele sind bewusst kein
          Produkt. Die Kennzahl bleibt als Orientierung stehen. */}
      <div className="ml-1 hidden h-7 items-center gap-1.5 rounded-full bg-black/[0.05] pl-3 pr-1 sm:flex">
        <span className="text-[12px] font-medium text-dim">Vorspiel</span>
        <span className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">
          {count}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
        <div className={`group relative hidden md:block ${FIELD}`}>
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onSearchChange('')
                e.currentTarget.blur()
              }
            }}
            placeholder="Suchen"
            className="h-9 w-56 bg-transparent pl-8 pr-8 text-[13px] outline-none placeholder:text-muted lg:w-72"
          />
          {!search && (
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-[5px] bg-white px-1.5 py-px font-sans text-[10px] font-medium text-muted shadow-[0_0_0_0.5px_oklch(0_0_0/0.12),0_1px_1px_oklch(0_0_0/0.06)] group-focus-within:hidden">
              /
            </kbd>
          )}
        </div>

        {/* Bankroll */}
        <div className="relative">
          <label className={`flex h-9 cursor-text items-center gap-2 px-2.5 ${FIELD}`}>
            <IconWallet className="h-4 w-4 shrink-0 text-accent" />
            <span className="text-[12px] font-medium text-muted">Bankroll</span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => {
                setOpen(true)
                e.currentTarget.select()
              }}
              onBlur={() => {
                commit()
                setOpen(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
              inputMode="decimal"
              className="tabular w-14 bg-transparent text-right text-[16px] font-semibold outline-none sm:w-16 sm:text-[14px]"
            />
            <span className="text-[13px] font-medium text-muted">€</span>
          </label>
          {open && (
            <div className="absolute right-0 top-11 z-40 w-60 origin-top-right animate-pop-in rounded-2xl bg-white p-2 shadow-pop">
              <p className="px-2 pb-2 pt-1 text-[12px] font-medium text-muted">Schnellauswahl</p>
              <div className="grid grid-cols-3 gap-1">
                {QUICK_BANKROLLS.map((v) => (
                  <button
                    key={v}
                    // `mousedown` statt `click`: der Klick käme erst nach dem
                    // `blur` des Eingabefelds, und dann ist die Auswahl schon zu.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      onBankrollChange(v)
                      setDraft(String(v))
                    }}
                    className={`tabular h-8 rounded-lg text-[13px] font-medium ${
                      bankroll === v ? 'bg-accent text-white' : 'text-fg hover:bg-black/[0.05]'
                    }`}
                  >
                    {moneyShort(v)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <span className="mx-1 hidden h-5 w-px bg-line sm:block" aria-hidden />

        <button onClick={onOpenFilters} className={`${TOOL} gap-1.5 px-2.5 text-[13px] font-medium`}>
          <span className="flex items-center gap-1.5">
            <IconFilter />
            <span className="hidden sm:inline">Filter</span>
            {activeFilterCount > 0 && (
              <span className="tabular grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[10.5px] font-semibold text-white">
                {activeFilterCount}
              </span>
            )}
          </span>
        </button>

        <button onClick={onOpenSettings} title="Einstellungen" aria-label="Einstellungen" className={TOOL}>
          <IconSliders />
        </button>

        <button
          onClick={onRefresh}
          disabled={refreshing}
          title={`Neu scannen · zuletzt ${lastUpdate.toLocaleTimeString('de-DE')}`}
          aria-label="Neu scannen"
          className={`${TOOL} disabled:text-accent`}
        >
          <IconRefresh className={refreshing ? 'h-4 w-4 animate-spin [animation-duration:700ms]' : 'h-4 w-4'} />
        </button>
      </div>
    </header>
  )
}
