import { useMemo, useState, type ReactNode } from 'react'
import type { BetWarningId, Filters, PushConfig, Settings, SortKey } from '../types'
import { BOOKMAKERS } from '../data/bookmakers'
import { ALL_SPORT_IDS, MARKET_FAMILIES, SPORTS, familiesForSports } from '../data/markets'
import { BET_WARNINGS } from '../data/warnings'
import { BookLogo } from './BookLogo'
import { IconBolt, IconCheck, IconLive, IconSearch, IconStar, IconX } from './icons'
import { money } from '../lib/format'
import { windowLabel } from '../lib/window'
import { testPush, type PushStatus } from '../lib/api'
import {
  notificationState,
  playChime,
  requestNotifications,
  unlockAudio,
  type NotificationState,
} from '../lib/alerts'

type Section =
  | 'sportsbook'
  | 'sport'
  | 'odds'
  | 'percentage'
  | 'market'
  | 'warnings'
  | 'settings'
  | 'phone'
  | 'sorting'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'sportsbook', label: 'Buchmacher' },
  { id: 'sport', label: 'Sportart' },
  { id: 'odds', label: 'Min/Max Quote' },
  { id: 'percentage', label: 'Arbitrage %' },
  { id: 'market', label: 'Märkte' },
  { id: 'warnings', label: 'Warnhinweise' },
  { id: 'settings', label: 'Einstellungen' },
  { id: 'phone', label: 'Telefon' },
  { id: 'sorting', label: 'Sortierung' },
]

const SORTS: { id: SortKey; label: string; hint: string }[] = [
  { id: 'percentage-desc', label: 'Arbitrage % — absteigend', hint: 'Höchste Rendite zuerst' },
  { id: 'percentage-asc', label: 'Arbitrage % — aufsteigend', hint: 'Niedrigste Rendite zuerst' },
  { id: 'profit-desc', label: 'Gewinn in € — absteigend', hint: 'Größter Eurobetrag zuerst' },
  { id: 'time-asc', label: 'Anstoß — bald zuerst', hint: 'Spiele, die gleich starten' },
  { id: 'time-desc', label: 'Anstoß — spät zuerst', hint: 'Mehr Zeit zum Platzieren' },
]

export function FilterOverlay({
  open,
  initialSection,
  filters,
  settings,
  sort,
  resultCount,
  onChangeFilters,
  onChangeSettings,
  onChangeSort,
  onReset,
  onClose,
  push,
  pushConfig,
  onChangePushConfig,
  windowHours,
}: {
  open: boolean
  initialSection?: Section
  filters: Filters
  settings: Settings
  sort: SortKey
  resultCount: number
  onChangeFilters: (f: Partial<Filters>) => void
  onChangeSettings: (s: Partial<Settings>) => void
  onChangeSort: (s: SortKey) => void
  onReset: () => void
  onClose: () => void
  /** Einrichtungsstand des Telefon-Meldewegs; `null`, solange unbekannt. */
  push: PushStatus | null
  /** Zugangsdaten des Meldedienstes — Inhalt des Reiters „Telefon". */
  pushConfig: PushConfig
  onChangePushConfig: (p: Partial<PushConfig>) => void
  /** Zeitfenster des Scanners in Stunden — nur zur Beschriftung. */
  windowHours: number
}) {
  const [section, setSection] = useState<Section>(initialSection ?? 'sportsbook')

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="animate-in-up m-auto flex h-[86vh] w-[min(1100px,94vw)] overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Linke Leiste */}
        <div className="flex w-64 shrink-0 flex-col border-r border-line bg-surface p-3">
          <div className="flex items-center justify-between px-2 pb-3">
            <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">Anpassen</span>
            <button onClick={onReset} className="text-[11px] font-semibold text-muted hover:text-danger">
              Zurücksetzen
            </button>
          </div>
          <nav className="flex flex-col gap-1">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] font-semibold transition ${
                  section === s.id ? 'bg-surface-3 text-white' : 'text-dim hover:bg-surface-2'
                }`}
              >
                {s.label}
                <span className="text-[11px] font-medium text-muted">{summaryFor(s.id, filters, settings, sort, push)}</span>
              </button>
            ))}
          </nav>
          <p className="mt-auto px-3 text-[11px] leading-relaxed text-muted">
            Zeitraum ist fest auf die <b className="text-dim">nächsten {windowLabel(windowHours)}</b>{' '}
            gesetzt. Partien weiter in der Zukunft werden nicht gescannt: dort sind auffällige
            Quoten meist Fehler, die der Anbieter noch storniert.
          </p>
        </div>

        {/* Inhalt */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="text-[15px] font-bold">{SECTIONS.find((s) => s.id === section)?.label}</h2>
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-white">
              <IconX />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {section === 'sportsbook' && <SportsbookSection filters={filters} onChange={onChangeFilters} />}
            {section === 'sport' && <SportSection filters={filters} onChange={onChangeFilters} />}
            {section === 'odds' && <OddsSection filters={filters} onChange={onChangeFilters} />}
            {section === 'percentage' && <PercentageSection filters={filters} onChange={onChangeFilters} />}
            {section === 'market' && <MarketSection filters={filters} onChange={onChangeFilters} />}
            {section === 'warnings' && <WarningsSection filters={filters} onChange={onChangeFilters} />}
            {section === 'settings' && (
              <SettingsSection settings={settings} onChange={onChangeSettings} push={push} />
            )}
            {section === 'phone' && (
              <PhoneSection config={pushConfig} onChange={onChangePushConfig} push={push} />
            )}
            {section === 'sorting' && <SortingSection sort={sort} onChange={onChangeSort} />}
          </div>

          <div className="flex items-center gap-3 border-t border-line px-5 py-3">
            <button
              onClick={onClose}
              className="rounded-xl border border-line px-4 py-2.5 text-[13px] font-semibold text-dim hover:text-white"
            >
              Abbrechen
            </button>
            <button
              onClick={onClose}
              className="ml-auto rounded-xl bg-accent px-6 py-2.5 text-[13px] font-bold text-ink transition hover:brightness-110"
            >
              {resultCount} {resultCount === 1 ? 'Ergebnis' : 'Ergebnisse'} anzeigen
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function summaryFor(
  id: Section,
  f: Filters,
  s: Settings,
  sort: SortKey,
  push: PushStatus | null,
): string {
  switch (id) {
    case 'sportsbook':
      return `${f.bookmakers.length}/${BOOKMAKERS.length}`
    case 'sport':
      return f.sports.length === SPORTS.length
        ? 'alle'
        : SPORTS.filter((s) => f.sports.includes(s.id))
            .map((s) => s.label)
            .join(', ') || 'keine'
    case 'odds':
      return `${f.minOdds.toFixed(2)}–${f.maxOdds.toFixed(2)}`
    case 'percentage':
      return `${f.minPercentage}–${f.maxPercentage}%`
    case 'market':
      return f.markets.length === MARKET_FAMILIES.length ? 'alle' : String(f.markets.length)
    case 'warnings':
      return f.warnings.length ? `${f.warnings.length} aus` : 'keine'
    case 'settings':
      return money(s.bankroll)
    case 'phone':
      return push?.ready ? 'bereit' : 'aus'
    case 'sorting':
      return sort.startsWith('percentage') ? '%' : sort.startsWith('profit') ? '€' : 'Zeit'
  }
}

/* ---------------------------------------------------------------- Buchmacher */

function SportsbookSection({ filters, onChange }: { filters: Filters; onChange: (f: Partial<Filters>) => void }) {
  const [q, setQ] = useState('')
  const [tag, setTag] = useState<'all' | 'popular' | 'live' | 'oneclick'>('all')

  const list = useMemo(() => {
    return BOOKMAKERS.filter((b) => {
      if (q && !b.name.toLowerCase().includes(q.toLowerCase())) return false
      if (tag === 'popular') return !!b.popular
      if (tag === 'live') return !!b.bestForLive
      if (tag === 'oneclick') return !!b.oneClick
      return true
    })
  }, [q, tag])

  const toggle = (id: string) =>
    onChange({
      bookmakers: filters.bookmakers.includes(id)
        ? filters.bookmakers.filter((x) => x !== id)
        : [...filters.bookmakers, id],
    })

  return (
    <div>
      <div className="mb-3 flex items-center gap-3 text-[12px]">
        <span className="font-semibold text-dim">
          {filters.bookmakers.length}/{BOOKMAKERS.length} ausgewählt
        </span>
        <button onClick={() => onChange({ bookmakers: BOOKMAKERS.map((b) => b.id) })} className="text-muted hover:text-accent">
          Alle auswählen
        </button>
        <button onClick={() => onChange({ bookmakers: [] })} className="text-muted hover:text-danger">
          Leeren
        </button>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <Chip active={tag === 'all'} onClick={() => setTag('all')}>
          Alle DE-Buchmacher
        </Chip>
        <Chip active={tag === 'popular'} onClick={() => setTag('popular')}>
          <IconStar className="h-3.5 w-3.5" /> Beliebt
        </Chip>
        <Chip active={tag === 'live'} onClick={() => setTag('live')}>
          <IconLive className="h-3.5 w-3.5" /> Gut für Live
        </Chip>
        <Chip active={tag === 'oneclick'} onClick={() => setTag('oneclick')}>
          <IconBolt className="h-3.5 w-3.5" /> 1-Klick
        </Chip>
      </div>

      <div className="relative mb-4">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buchmacher suchen…"
          className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-[13px] outline-none placeholder:text-muted focus:border-accent/50"
        />
      </div>

      <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">
        In Deutschland lizenziert (GGL-Whitelist)
      </p>
      <div className="grid grid-cols-2 gap-2">
        {list.map((b) => {
          const on = filters.bookmakers.includes(b.id)
          return (
            <button
              key={b.id}
              onClick={() => toggle(b.id)}
              className={`flex items-center gap-3 rounded-xl border p-2.5 text-left transition ${
                on ? 'border-accent/50 bg-accent/8' : 'border-line bg-surface hover:border-line-soft hover:bg-surface-2'
              }`}
            >
              <BookLogo id={b.id} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold">{b.name}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px] text-muted">
                  {b.oneClick && <Tag>1-Klick</Tag>}
                  {b.bestForLive && <Tag>Live</Tag>}
                  {b.popular && <Tag>Beliebt</Tag>}
                  {b.licensedSince && <span>seit {new Date(b.licensedSince).toLocaleDateString('de-DE')}</span>}
                </div>
              </div>
              <span
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${
                  on ? 'border-accent bg-accent text-ink' : 'border-line'
                }`}
              >
                {on && <IconCheck className="h-3 w-3" />}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- Quoten */

function OddsSection({ filters, onChange }: { filters: Filters; onChange: (f: Partial<Filters>) => void }) {
  return (
    <div className="max-w-lg space-y-6">
      <p className="text-[13px] leading-relaxed text-muted">
        Blendet Wettmöglichkeiten aus, bei denen ein Bein außerhalb dieses Quotenbereichs liegt.
      </p>
      <NumberField
        label="Minimale Quote"
        value={filters.minOdds}
        step={0.05}
        min={1}
        max={filters.maxOdds}
        onChange={(v) => onChange({ minOdds: v })}
      />
      <NumberField
        label="Maximale Quote"
        value={filters.maxOdds}
        step={0.5}
        min={filters.minOdds}
        max={100}
        onChange={(v) => onChange({ maxOdds: v })}
      />
      <div className="flex gap-2">
        {[
          { l: 'Alle', min: 1, max: 100 },
          { l: 'Favoriten (1.0–2.5)', min: 1, max: 2.5 },
          { l: 'Ausgeglichen (1.5–4)', min: 1.5, max: 4 },
          { l: 'Außenseiter (3+)', min: 3, max: 100 },
        ].map((p) => (
          <Chip
            key={p.l}
            active={filters.minOdds === p.min && filters.maxOdds === p.max}
            onClick={() => onChange({ minOdds: p.min, maxOdds: p.max })}
          >
            {p.l}
          </Chip>
        ))}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- Prozentsatz */

function PercentageSection({ filters, onChange }: { filters: Filters; onChange: (f: Partial<Filters>) => void }) {
  return (
    <div className="max-w-lg space-y-6">
      <p className="text-[13px] leading-relaxed text-muted">
        Arbitrage in Prozent des Gesamteinsatzes, aus den reinen Quoten gerechnet. Werte über 11 %
        sind möglich, wenn ein Anbieter eine Quote zu spät nachzieht; sie werden als „auffällig
        hoch" markiert, weil dasselbe Bild auch ein Datenfehler erzeugt.
      </p>
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-semibold">Minimum</span>
          <span className="text-[13px] font-bold text-accent">{filters.minPercentage.toFixed(1)} %</span>
        </div>
        <input
          type="range"
          min={0}
          max={10}
          step={0.1}
          value={filters.minPercentage}
          onChange={(e) => onChange({ minPercentage: Math.min(Number(e.target.value), filters.maxPercentage) })}
          className="w-full"
        />
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-semibold">Maximum</span>
          <span className="text-[13px] font-bold text-accent">{filters.maxPercentage.toFixed(1)} %</span>
        </div>
        <input
          type="range"
          min={0}
          max={30}
          step={0.5}
          value={filters.maxPercentage}
          onChange={(e) => onChange({ maxPercentage: Math.max(Number(e.target.value), filters.minPercentage) })}
          className="w-full"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {[
          { l: 'Ab 0,5 %', min: 0.5 },
          { l: 'Ab 1 %', min: 1 },
          { l: 'Ab 2 %', min: 2 },
          { l: 'Ab 3 %', min: 3 },
          { l: 'Ab 5 %', min: 5 },
        ].map((p) => (
          <Chip key={p.l} active={filters.minPercentage === p.min} onClick={() => onChange({ minPercentage: p.min })}>
            {p.l}
          </Chip>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- Märkte */

/**
 * Sportart-Auswahl.
 *
 * Ohne sie standen Fußball und Tennis in einer Liste, und die einzige
 * Möglichkeit sie zu trennen war die Volltextsuche.
 */
function SportSection({ filters, onChange }: { filters: Filters; onChange: (f: Partial<Filters>) => void }) {
  const toggle = (id: string) =>
    onChange({
      sports: filters.sports.includes(id)
        ? filters.sports.filter((x) => x !== id)
        : [...filters.sports, id],
    })

  return (
    <div>
      <div className="mb-3 flex items-center gap-3 text-[12px]">
        <span className="font-semibold text-dim">
          {filters.sports.length}/{SPORTS.length} ausgewählt
        </span>
        <button onClick={() => onChange({ sports: [...ALL_SPORT_IDS] })} className="text-muted hover:text-accent">
          Alle auswählen
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {SPORTS.map((s) => {
          const on = filters.sports.includes(s.id)
          return (
            <button
              key={s.id}
              onClick={() => toggle(s.id)}
              className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-[13px] font-semibold transition ${
                on ? 'border-accent/50 bg-accent/8' : 'border-line bg-surface hover:bg-surface-2'
              }`}
            >
              {s.label}
              <span
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${
                  on ? 'border-accent bg-accent text-ink' : 'border-line'
                }`}
              >
                {on && <IconCheck className="h-3 w-3" />}
              </span>
            </button>
          )
        })}
      </div>
      <p className="mt-4 text-[12px] leading-relaxed text-muted">
        Die Marktauswahl richtet sich danach: „Beide Teams treffen" gibt es im Tennis nicht,
        die zweiwegige Siegwette nicht im Fußball.
      </p>
    </div>
  )
}

function MarketSection({ filters, onChange }: { filters: Filters; onChange: (f: Partial<Filters>) => void }) {
  // Nur die Familien zeigen, die bei den gewählten Sportarten überhaupt
  // vorkommen können — sonst stehen dort dauerhaft Optionen ohne Wirkung.
  const visible = familiesForSports(filters.sports)
  const visibleIds: string[] = visible.map((m) => m.id)
  const selected = filters.markets.filter((id) => visibleIds.includes(id))

  const toggle = (id: string) =>
    onChange({
      markets: filters.markets.includes(id)
        ? filters.markets.filter((x) => x !== id)
        : [...filters.markets, id],
    })

  return (
    <div>
      <div className="mb-3 flex items-center gap-3 text-[12px]">
        <span className="font-semibold text-dim">
          {selected.length}/{visible.length} ausgewählt
        </span>
        <button
          onClick={() => onChange({ markets: [...new Set([...filters.markets, ...visibleIds])] })}
          className="text-muted hover:text-accent"
        >
          Alle auswählen
        </button>
        <button
          onClick={() => onChange({ markets: filters.markets.filter((id) => !visibleIds.includes(id)) })}
          className="text-muted hover:text-danger"
        >
          Leeren
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {visible.map((m) => {
          const on = filters.markets.includes(m.id)
          return (
            <button
              key={m.id}
              onClick={() => toggle(m.id)}
              className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-[13px] font-semibold transition ${
                on ? 'border-accent/50 bg-accent/8' : 'border-line bg-surface hover:bg-surface-2'
              }`}
            >
              {m.label}
              <span
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${
                  on ? 'border-accent bg-accent text-ink' : 'border-line'
                }`}
              >
                {on && <IconCheck className="h-3 w-3" />}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- Warnhinweise */

/**
 * Meldungen bei Funden über einer Schwelle.
 *
 * Zwei Wege, beide abschaltbar: ein Zweiklang im Browser und die Systemmeldung
 * (auf macOS oben rechts). Für die Systemmeldung braucht der Browser eine
 * Erlaubnis, und die darf er nur aus einer **Nutzergeste** heraus erfragen —
 * deshalb der Knopf. Derselbe Klick weckt den Audio-Kontext, den Browser ohne
 * Geste angehalten lassen.
 */
function AlertBlock({
  settings,
  onChange,
  push,
}: {
  settings: Settings
  onChange: (s: Partial<Settings>) => void
  push: PushStatus | null
}) {
  const [perm, setPerm] = useState<NotificationState>(() => notificationState())
  const on = settings.alertMinPercent > 0

  const enable = async () => {
    unlockAudio()
    setPerm(await requestNotifications())
  }

  return (
    <div>
      <p className="mb-2 text-[13px] font-semibold">Melden ab Rendite</p>
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2, 3, 5, 10].map((v) => (
          <Chip
            key={v}
            active={settings.alertMinPercent === v}
            onClick={() => onChange({ alertMinPercent: v })}
          >
            {v === 0 ? 'aus' : `${v} %`}
          </Chip>
        ))}
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
        Gemeldet wird nur, was auch in der Liste stünde — die Buchmacher-, Markt- und
        Sportauswahl gilt also mit. Jeder Fund meldet sich einmal; fällt er unter die Schwelle
        und steigt wieder darüber, meldet er sich erneut.
      </p>

      {on && (
        <div className="mt-3 space-y-2">
          <button
            onClick={() => onChange({ alertSound: !settings.alertSound })}
            className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
              settings.alertSound ? 'border-accent/50 bg-accent/8' : 'border-line bg-surface hover:bg-surface-2'
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold">Ton</p>
              <p className="text-[11.5px] leading-relaxed text-muted">
                Kurzer Zweiklang. Funktioniert nur, solange der Tab offen ist.
              </p>
            </div>
            <Switch on={settings.alertSound} />
          </button>

          <button
            onClick={() => onChange({ alertDesktop: !settings.alertDesktop })}
            className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
              settings.alertDesktop ? 'border-accent/50 bg-accent/8' : 'border-line bg-surface hover:bg-surface-2'
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold">Systemmeldung</p>
              <p className="text-[11.5px] leading-relaxed text-muted">
                Erscheint auf macOS oben rechts, auch wenn der Browser im Hintergrund ist. Ein
                Klick darauf holt das Fenster nach vorn.
              </p>
            </div>
            <Switch on={settings.alertDesktop} />
          </button>

          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold">
                {perm === 'granted'
                  ? 'Systemmeldungen erlaubt'
                  : perm === 'denied'
                    ? 'Systemmeldungen blockiert'
                    : perm === 'unsupported'
                      ? 'Systemmeldungen nicht verfügbar'
                      : 'Erlaubnis noch nicht erteilt'}
              </p>
              <p className="text-[11.5px] leading-relaxed text-muted">
                {perm === 'denied'
                  ? 'In den Browser-Einstellungen für diese Seite wieder freigeben — nachfragen darf die Seite nicht mehr.'
                  : perm === 'granted'
                    ? 'Zum Prüfen einmal auslösen.'
                    : 'Der Browser fragt nur auf Knopfdruck. Derselbe Klick gibt auch den Ton frei.'}
              </p>
            </div>
            {perm === 'default' && (
              <button
                onClick={() => void enable()}
                className="shrink-0 rounded-lg bg-accent px-3 py-2 text-[12px] font-bold text-ink hover:brightness-110"
              >
                Erlauben
              </button>
            )}
            {perm === 'granted' && (
              <button
                onClick={() => {
                  unlockAudio()
                  playChime()
                }}
                className="shrink-0 rounded-lg border border-line px-3 py-2 text-[12px] font-semibold text-dim hover:text-white"
              >
                Testen
              </button>
            )}
          </div>

          <PushBlock settings={settings} onChange={onChange} push={push} />
        </div>
      )}
    </div>
  )
}

/**
 * Meldung aufs Telefon.
 *
 * Der eine Unterschied zu Ton und Systemmeldung, der alles ändert: hier
 * verschickt **der Server**, nicht der Browser. Der Tab darf zu sein, der
 * Rechner darf gesperrt sein — nur laufen muss der Scanner.
 *
 * Der Meldeweg selbst wird über Umgebungsvariablen eingerichtet und nicht
 * hier: Thema bzw. Schlüssel sind Geheimnisse, die einmal gesetzt werden und
 * sich nie ändern. Diese Fläche zeigt nur, ob es geklappt hat.
 */
function PushBlock({
  settings,
  onChange,
  push,
}: {
  settings: Settings
  onChange: (s: Partial<Settings>) => void
  push: PushStatus | null
}) {
  const [probe, setProbe] = useState<{ state: 'idle' | 'laeuft' | 'ok' | 'fehler'; msg?: string }>({
    state: 'idle',
  })

  const test = async () => {
    setProbe({ state: 'laeuft' })
    const r = await testPush()
    setProbe(r.ok ? { state: 'ok' } : { state: 'fehler', msg: r.error })
  }

  return (
    <>
      <button
        onClick={() => onChange({ alertPush: !settings.alertPush })}
        disabled={!push?.ready}
        className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
          !push?.ready
            ? 'cursor-not-allowed border-line bg-surface opacity-60'
            : settings.alertPush
              ? 'border-accent/50 bg-accent/8'
              : 'border-line bg-surface hover:bg-surface-2'
        }`}
      >
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">Aufs Telefon</p>
          <p className="text-[11.5px] leading-relaxed text-muted">
            {push?.ready ? (
              <>
                Verschickt der Scanner selbst — der Browser darf zu sein. Läuft über{' '}
                <span className="text-dim">{push.via}</span>.
              </>
            ) : (
              <>
                Kein Meldeweg eingerichtet. Im README steht, wie du ntfy oder Pushover in zwei
                Minuten einrichtest.
              </>
            )}
          </p>
        </div>
        <Switch on={Boolean(push?.ready && settings.alertPush)} />
      </button>

      {push?.ready && settings.alertPush && (
        <>
          <button
            onClick={() => onChange({ alertQuiet: !settings.alertQuiet })}
            className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
              settings.alertQuiet ? 'border-accent/50 bg-accent/8' : 'border-line bg-surface hover:bg-surface-2'
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold">Nachtruhe</p>
              <p className="text-[11.5px] leading-relaxed text-muted">
                Zwischen diesen Stunden bleibt das Telefon still. Nachgeholt wird nichts — was
                morgens noch steht, meldet sich morgens.
              </p>
            </div>
            <Switch on={settings.alertQuiet} />
          </button>

          {settings.alertQuiet && (
            <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
              <p className="text-[12px] text-muted">von</p>
              <HourPicker value={settings.quietFrom} onChange={(v) => onChange({ quietFrom: v })} />
              <p className="text-[12px] text-muted">bis</p>
              <HourPicker value={settings.quietTo} onChange={(v) => onChange({ quietTo: v })} />
            </div>
          )}

          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold">
                {probe.state === 'ok'
                  ? 'Probemeldung verschickt'
                  : probe.state === 'fehler'
                    ? 'Versand fehlgeschlagen'
                    : 'Ankunft prüfen'}
              </p>
              <p className="text-[11.5px] leading-relaxed text-muted">
                {probe.state === 'fehler'
                  ? probe.msg
                  : probe.state === 'ok'
                    ? 'Kommt sie auf dem Telefon nicht an, stimmt das Thema in der App nicht mit dem auf dem Server überein.'
                    : 'Schickt eine Testnachricht über den eingerichteten Weg.'}
              </p>
            </div>
            <button
              onClick={() => void test()}
              disabled={probe.state === 'laeuft'}
              className="shrink-0 rounded-lg border border-line px-3 py-2 text-[12px] font-semibold text-dim hover:text-white disabled:opacity-50"
            >
              {probe.state === 'laeuft' ? '…' : 'Senden'}
            </button>
          </div>
        </>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ Telefon */

const SERVICES: { id: PushConfig['service']; label: string; hint: string }[] = [
  { id: 'off', label: 'Aus', hint: 'Kein Versand aufs Telefon' },
  { id: 'ntfy', label: 'ntfy', hint: 'Kostenlos, quelloffen, kein Konto' },
  { id: 'pushover', label: 'Pushover', hint: 'Einmalig 5 $, sehr zuverlässig' },
  { id: 'webhook', label: 'Webhook', hint: 'Eigener Dienst, Shortcuts, Home Assistant' },
]

/**
 * Zugangsdaten für den Meldedienst.
 *
 * Sie liegen hier und nicht in einer Umgebungsvariablen, damit sie einmal
 * eingetragen werden und danach stehen bleiben — über `npm run dev` hinweg.
 * Der Server legt sie in `.arbify-alerts.json` ab, die in `.gitignore` steht.
 *
 * Das ntfy-Thema ist standardmäßig verdeckt: es ist das Passwort des Kanals,
 * und ein Screenshot oder eine geteilte Bildschirmsitzung gibt es sonst
 * ungefragt preis.
 */
function PhoneSection({
  config,
  onChange,
  push,
}: {
  config: PushConfig
  onChange: (p: Partial<PushConfig>) => void
  push: PushStatus | null
}) {
  const [zeigen, setZeigen] = useState(false)
  const [probe, setProbe] = useState<{ state: 'idle' | 'laeuft' | 'ok' | 'fehler'; msg?: string }>({
    state: 'idle',
  })

  const test = async () => {
    setProbe({ state: 'laeuft' })
    const r = await testPush()
    setProbe(r.ok ? { state: 'ok' } : { state: 'fehler', msg: r.error })
  }

  const feld = 'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] outline-none focus:border-accent/60'

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-[13px] font-semibold">Meldedienst</p>
        <div className="grid grid-cols-2 gap-2">
          {SERVICES.map((s) => (
            <button
              key={s.id}
              onClick={() => onChange({ service: s.id })}
              className={`rounded-xl border p-3 text-left transition ${
                config.service === s.id
                  ? 'border-accent/50 bg-accent/8'
                  : 'border-line bg-surface hover:bg-surface-2'
              }`}
            >
              <p className="text-[13px] font-semibold">{s.label}</p>
              <p className="text-[11.5px] leading-relaxed text-muted">{s.hint}</p>
            </button>
          ))}
        </div>
      </div>

      {config.service === 'ntfy' && (
        <div className="space-y-3 rounded-xl border border-line bg-surface p-3">
          <div>
            <label className="mb-1 block text-[12px] font-semibold">Thema</label>
            <div className="flex gap-2">
              <input
                type={zeigen ? 'text' : 'password'}
                value={config.ntfyTopic}
                onChange={(e) => onChange({ ntfyTopic: e.target.value.trim() })}
                placeholder="lange Zufallszeichenkette"
                autoComplete="off"
                spellCheck={false}
                className={feld}
              />
              <button
                onClick={() => setZeigen((v) => !v)}
                className="shrink-0 rounded-lg border border-line px-3 text-[12px] font-semibold text-dim hover:text-white"
              >
                {zeigen ? 'Verbergen' : 'Zeigen'}
              </button>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
              Genau das, was in der ntfy-App unter „Subscribe to topic" steht. Es ist der{' '}
              <b className="text-dim">einzige Schutz</b> des Kanals — wer es kennt, liest jeden Fund
              mit und kann dir selbst Meldungen schicken. Deshalb gehört es weder in die
              Dokumentation noch ins Repository.
            </p>
          </div>

          <details className="text-[12px]">
            <summary className="cursor-pointer text-muted hover:text-dim">Eigener Server</summary>
            <div className="mt-2 space-y-2">
              <input
                value={config.ntfyServer}
                onChange={(e) => onChange({ ntfyServer: e.target.value.trim() })}
                placeholder="https://ntfy.sh"
                className={feld}
              />
              <input
                type="password"
                value={config.ntfyToken}
                onChange={(e) => onChange({ ntfyToken: e.target.value.trim() })}
                placeholder="Zugangstoken (nur bei geschützten Themen)"
                autoComplete="off"
                className={feld}
              />
            </div>
          </details>
        </div>
      )}

      {config.service === 'pushover' && (
        <div className="space-y-3 rounded-xl border border-line bg-surface p-3">
          <div>
            <label className="mb-1 block text-[12px] font-semibold">User Key</label>
            <input
              type="password"
              value={config.pushoverUser}
              onChange={(e) => onChange({ pushoverUser: e.target.value.trim() })}
              autoComplete="off"
              className={feld}
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-semibold">API-Token</label>
            <input
              type="password"
              value={config.pushoverToken}
              onChange={(e) => onChange({ pushoverToken: e.target.value.trim() })}
              autoComplete="off"
              className={feld}
            />
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
              Beides steht im Pushover-Konto: der User Key auf der Startseite, das Token bei der
              selbst angelegten Anwendung.
            </p>
          </div>
        </div>
      )}

      {config.service === 'webhook' && (
        <div className="rounded-xl border border-line bg-surface p-3">
          <label className="mb-1 block text-[12px] font-semibold">Adresse</label>
          <input
            value={config.webhookUrl}
            onChange={(e) => onChange({ webhookUrl: e.target.value.trim() })}
            placeholder="https://…"
            className={feld}
          />
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
            Bekommt je Fund ein JSON mit Titel, Text, Dringlichkeit und den Links zu beiden
            Buchmachern.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">
            {probe.state === 'ok'
              ? 'Probemeldung verschickt'
              : probe.state === 'fehler'
                ? 'Versand fehlgeschlagen'
                : push?.ready
                  ? 'Eingerichtet'
                  : 'Noch nicht eingerichtet'}
          </p>
          <p className="text-[11.5px] leading-relaxed text-muted">
            {probe.state === 'fehler'
              ? probe.msg
              : probe.state === 'ok'
                ? 'Kommt sie nicht an, stimmt das Thema in der App nicht mit dem hier überein.'
                : push?.ready
                  ? push.via
                  : 'Dienst wählen und die Zugangsdaten eintragen.'}
          </p>
        </div>
        <button
          onClick={() => void test()}
          disabled={!push?.ready || probe.state === 'laeuft'}
          className="shrink-0 rounded-lg border border-line px-3 py-2 text-[12px] font-semibold text-dim hover:text-white disabled:opacity-40"
        >
          {probe.state === 'laeuft' ? '…' : 'Testen'}
        </button>
      </div>

      <p className="text-[11.5px] leading-relaxed text-muted">
        Was gemeldet wird — Schwelle, Nachtruhe, Ton — steht unter{' '}
        <b className="text-dim">Einstellungen</b>. Gemeldet wird immer nur, was mit dem
        eingestellten Filter auch in der Liste stünde.
      </p>
    </div>
  )
}

function HourPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-[12px] font-semibold"
    >
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>
          {String(h).padStart(2, '0')}:00
        </option>
      ))}
    </select>
  )
}

function WarningsSection({ filters, onChange }: { filters: Filters; onChange: (f: Partial<Filters>) => void }) {
  const toggle = (id: BetWarningId) =>
    onChange({
      warnings: filters.warnings.includes(id)
        ? filters.warnings.filter((x) => x !== id)
        : [...filters.warnings, id],
    })

  return (
    <div className="max-w-2xl">
      <p className="mb-4 text-[13px] leading-relaxed text-muted">
        Aktivierte Warnhinweise werden aus der Liste <b className="text-dim">ausgeblendet</b>.
      </p>
      <div className="space-y-2">
        {BET_WARNINGS.map((w) => {
          const on = filters.warnings.includes(w.id)
          return (
            <button
              key={w.id}
              onClick={() => toggle(w.id)}
              className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                on ? 'border-danger/50 bg-danger/8' : 'border-line bg-surface hover:bg-surface-2'
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold">{w.label}</p>
                <p className="text-[11.5px] leading-relaxed text-muted">{w.detail}</p>
              </div>
              <Switch on={on} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- Einstellungen */

function SettingsSection({
  settings,
  onChange,
  push,
}: {
  settings: Settings
  onChange: (s: Partial<Settings>) => void
  push: PushStatus | null
}) {
  return (
    <div className="max-w-lg space-y-6">
      <NumberField
        label="Bankroll"
        suffix="€"
        value={settings.bankroll}
        step={50}
        min={1}
        max={1_000_000}
        onChange={(v) => onChange({ bankroll: v })}
        hint="Der Betrag, der über alle Beine einer Wette aufgeteilt wird."
      />

      <div>
        <p className="mb-2 text-[13px] font-semibold">Einsätze runden auf</p>
        <div className="flex flex-wrap gap-2">
          {[0, 0.5, 1, 5, 10].map((r) => (
            <Chip key={r} active={settings.roundTo === r} onClick={() => onChange({ roundTo: r })}>
              {r === 0 ? 'Cent-genau' : `${r} €`}
            </Chip>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
          Gerundete Einsätze sehen für Buchmacher unauffälliger aus, kosten aber ein paar Zehntel
          Prozent Rendite.
        </p>
      </div>

      <AlertBlock settings={settings} onChange={onChange} push={push} />

      <div className="rounded-xl border border-line bg-surface p-3">
        <p className="text-[13px] font-semibold">Wettsteuer</p>
        <p className="text-[11.5px] leading-relaxed text-muted">
          Die Renditen sind reine Quotenwerte, ohne Steuerabzug. Anbieter wie Betano oder bwin geben
          die 5,3 % an den Kunden weiter, Winamax, Tipico und Interwetten nicht. Betroffene Wetten
          tragen den Hinweis „Wettsteuer"; welcher Anbieter wie abrechnet, steht im Detailbereich
          der jeweiligen Wette.
        </p>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- Sortierung */

function SortingSection({ sort, onChange }: { sort: SortKey; onChange: (s: SortKey) => void }) {
  return (
    <div className="max-w-lg space-y-2">
      {SORTS.map((s) => (
        <button
          key={s.id}
          onClick={() => onChange(s.id)}
          className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
            sort === s.id ? 'border-accent/50 bg-accent/8' : 'border-line bg-surface hover:bg-surface-2'
          }`}
        >
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold">{s.label}</p>
            <p className="text-[11.5px] text-muted">{s.hint}</p>
          </div>
          <span
            className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
              sort === s.id ? 'border-accent bg-accent text-ink' : 'border-line'
            }`}
          >
            {sort === s.id && <IconCheck className="h-3 w-3" />}
          </span>
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ Bausteine */

function Chip({
  active,
  onClick,
  children,
}: {
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition ${
        active ? 'border-accent bg-accent/12 text-accent' : 'border-line text-dim hover:bg-surface-2'
      }`}
    >
      {children}
    </button>
  )
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded bg-surface-3 px-1 py-px text-[9px] font-semibold text-dim">{children}</span>
}

function Switch({ on }: { on: boolean }) {
  return (
    <span
      className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-surface-3'}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? 'left-4.5' : 'left-0.5'}`}
      />
    </span>
  )
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
  hint,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  suffix?: string
  hint?: string
}) {
  return (
    <div>
      <label className="mb-2 block text-[13px] font-semibold">{label}</label>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onChange(clamp(round(value - step, step), min, max))}
          className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-surface text-[18px] font-bold text-dim hover:text-white"
        >
          −
        </button>
        <div className="flex h-10 flex-1 items-center rounded-xl border border-line bg-surface px-3">
          <input
            type="number"
            value={value}
            step={step}
            onChange={(e) => onChange(clamp(Number(e.target.value), min, max))}
            className="w-full bg-transparent text-[14px] font-bold outline-none"
          />
          {suffix && <span className="text-[13px] font-bold text-muted">{suffix}</span>}
        </div>
        <button
          onClick={() => onChange(clamp(round(value + step, step), min, max))}
          className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-surface text-[18px] font-bold text-dim hover:text-white"
        >
          +
        </button>
      </div>
      {hint && <p className="mt-2 text-[11.5px] leading-relaxed text-muted">{hint}</p>}
    </div>
  )
}

const clamp = (v: number, min?: number, max?: number) =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Number.isFinite(v) ? v : 0))

const round = (v: number, step: number) => Math.round(v / step) * step
