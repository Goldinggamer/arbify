import { useEffect, useMemo, useRef, useState } from 'react'
import type { Filters, Opportunity, PushConfig, Settings, SortKey } from './types'
import { EMPTY_PUSH_CONFIG } from './types'
import { BOOKMAKERS } from './data/bookmakers'
import { ALL_MARKET_IDS, ALL_SPORT_IDS } from './data/markets'
import { generateOpportunities } from './data/mock'
import { applyFilters, countActiveFilters } from './lib/filter'
import { DEFAULT_WINDOW_HOURS, hoursToMs, windowLabel } from './lib/window'
import { playChime, selectAlerts, showAlert } from './lib/alerts'
import { arbFor, arbPercentOf } from './lib/arbitrage'
import { money, pct } from './lib/format'
import {
  fetchAlertConfig,
  fetchOpportunities,
  putAlertConfig,
  triggerScan,
  type PushStatus,
  type ScanStatus,
} from './lib/api'
import { BookLogo } from './components/BookLogo'
import { Header } from './components/Header'
import { OpportunityCard } from './components/OpportunityCard'
import { DetailPanel } from './components/DetailPanel'
import { FilterOverlay } from './components/FilterOverlay'
import { IconSearch, IconSort } from './components/icons'

/** Wie oft der Stand vom Backend geholt wird — liest nur den Speicher des Servers, kostet die Buchmacher nichts. */
const POLL_MS = 2_000
/** Solange der erste Durchlauf läuft, trudeln die Bücher im Sekundentakt ein — dann öfter nachsehen. */
const POLL_WARMING_MS = 400

const DEFAULT_FILTERS: Filters = {
  bookmakers: BOOKMAKERS.map((b) => b.id),
  sports: [...ALL_SPORT_IDS],
  minOdds: 1,
  maxOdds: 100,
  minPercentage: 0.5,
  maxPercentage: 30,
  markets: [...ALL_MARKET_IDS],
  warnings: [],
  search: '',
}

const DEFAULT_SETTINGS: Settings = {
  bankroll: 500,
  roundTo: 1,
  currency: '€',
  alertMinPercent: 3,
  alertSound: true,
  alertDesktop: true,
  // Der Versand aufs Telefon ist standardmäßig **an**: eingerichtet wird er
  // ohnehin erst über Umgebungsvariablen auf dem Server, und wer sich die
  // Mühe macht, will die Meldungen dann auch bekommen.
  alertPush: true,
  alertQuiet: false,
  quietFrom: 23,
  quietTo: 8,
}

/**
 * Version im Schlüssel: bei Formatänderungen (zuletzt neue Marktfamilien mit
 * Tennis) würde ein alter Stand sonst Einstellungen wiederherstellen, die
 * Neues unsichtbar wegfiltern.
 */
const STORAGE_KEY = 'arbify.state.v4'

/** Eigener Schlüssel für die Zugangsdaten des Meldedienstes — ein Geheimnis, das `Zurücksetzen` nicht anfasst. */
const PUSH_KEY = 'arbify.push.v1'

/** Liest einen JSON-Wert aus localStorage; fehlt er oder ist er kaputt: `undefined`. */
function readJson(key: string): any {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

const loadPushConfig = (): PushConfig => ({ ...EMPTY_PUSH_CONFIG, ...readJson(PUSH_KEY) })

/** Ist überhaupt nichts eingetragen? Dann darf der Server-Stand gewinnen. */
const isBlank = (p: PushConfig): boolean =>
  p.service === 'off' &&
  !p.ntfyTopic &&
  !p.pushoverToken &&
  !p.pushoverUser &&
  !p.webhookUrl

function loadStored<T extends object>(key: string, fallback: T): T {
  const stored = readJson(STORAGE_KEY)?.[key]
  return stored ? { ...fallback, ...stored } : fallback
}

/**
 * Welche Sportarten der gespeicherte Stand kannte. Nur so ist eine neue
 * Sportart von einer bewusst abgewählten zu unterscheiden; fehlt das Feld,
 * stammt der Stand aus der Zeit mit Fußball und Tennis.
 */
const SPORTS_BEFORE = ['Fußball', 'Tennis']

function loadSportsKnown(): string[] {
  const parsed = readJson(STORAGE_KEY)
  if (parsed === undefined) return [...ALL_SPORT_IDS]
  return Array.isArray(parsed?.sportsKnown) ? parsed.sportsKnown : SPORTS_BEFORE
}

/**
 * Entfernt Buchmacher und Märkte aus dem gespeicherten Stand, die es nicht
 * mehr gibt — sonst zählt ein entfernter Anbieter dauerhaft als „aktiver
 * Filter“, ohne dass eine Einstellung es erklärt.
 */
function sanitizeFilters(f: Filters): Filters {
  const knownBooks = new Set(BOOKMAKERS.map((b) => b.id))
  const knownMarkets = new Set(ALL_MARKET_IDS)
  const knownSports = new Set(ALL_SPORT_IDS)
  const stored = f.sports?.filter((id) => knownSports.has(id)) ?? []

  // Sportarten, die es beim Speichern noch nicht gab, können nicht abgewählt
  // worden sein — sie kommen dazu. Was der Nutzer damals abgewählt hat, bleibt
  // abgewählt.
  const wasKnown = new Set(loadSportsKnown())
  const added = ALL_SPORT_IDS.filter((id) => !wasKnown.has(id))
  const sports = [...new Set([...stored, ...added])]

  return {
    ...f,
    bookmakers: f.bookmakers.filter((id) => knownBooks.has(id)),
    markets: f.markets.filter((id) => knownMarkets.has(id)),
    // Eine leere Sportauswahl wäre ein Filter, der garantiert nichts findet
    // und für den es keine sichtbare Erklärung gäbe.
    sports: sports.length ? sports : [...ALL_SPORT_IDS],
  }
}

export default function App() {
  // Leer starten statt mit Demo-Daten: das Backend antwortet meist in
  // Millisekunden, und sonst blitzen kurz erfundene Wetten auf.
  const [pool, setPool] = useState<Opportunity[]>([])
  const [filters, setFilters] = useState<Filters>(() =>
    sanitizeFilters(loadStored('filters', DEFAULT_FILTERS)),
  )
  const [settings, setSettings] = useState<Settings>(() => loadStored('settings', DEFAULT_SETTINGS))
  const [sort, setSort] = useState<SortKey>('percentage-desc')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<{ open: boolean; section?: 'sportsbook' | 'settings' | 'sorting' }>({ open: false })
  const [lastUpdate, setLastUpdate] = useState(new Date())
  const [refreshing, setRefreshing] = useState(false)
  const [status, setStatus] = useState<ScanStatus | null>(null)
  const [pushConfig, setPushConfig] = useState<PushConfig>(loadPushConfig)
  /**
   * Erst spiegeln, wenn der Server-Stand abgeholt ist.
   *
   * Sonst überschreibt ein frisch geöffneter Browser mit leerem Zugang den,
   * der auf dem Server liegt — und die Meldungen brechen ab.
   */
  const [synced, setSynced] = useState(false)
  const [push, setPush] = useState<PushStatus | null>(null)

  // Zugang vom Server übernehmen, solange lokal nichts eingetragen ist.
  useEffect(() => {
    void fetchAlertConfig().then(({ push, status }) => {
      if (push && isBlank(loadPushConfig())) setPushConfig({ ...EMPTY_PUSH_CONFIG, ...push })
      if (status) setPush(status)
      setSynced(true)
    })
  }, [])

  useEffect(() => {
    localStorage.setItem(PUSH_KEY, JSON.stringify(pushConfig))
  }, [pushConfig])

  useEffect(() => {
    // `sportsKnown` mitschreiben, damit eine künftig ergänzte Sportart nicht
    // wie eine abgewählte aussieht — siehe `sanitizeFilters`.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ filters, settings, sportsKnown: ALL_SPORT_IDS }),
    )
  }, [filters, settings])

  // Echte Daten vom Scanner-Backend holen. Ist es beim ersten Versuch nicht
  // erreichbar, springt der Demo-Generator ein, damit die Oberfläche bedienbar
  // bleibt.
  useEffect(() => {
    let cancelled = false
    let timer = 0
    let everOnline = false
    const ctrl = new AbortController()

    const load = async () => {
      let warming = false
      try {
        const { opportunities, status } = await fetchOpportunities(ctrl.signal)
        if (cancelled) return
        everOnline = true
        warming = status.warming
        setStatus(status)
        setPool(opportunities)
        setLastUpdate(new Date())
      } catch {
        if (cancelled) return
        setStatus((s) => (s ? { ...s, online: false } : null))
        if (!everOnline) setPool((p) => (p.length ? p : generateOpportunities(48)))
      }
      // `setTimeout` statt `setInterval`: der Abstand hängt davon ab, ob der
      // Server noch aufwärmt.
      timer = window.setTimeout(load, warming ? POLL_WARMING_MS : POLL_MS)
    }

    void load()
    return () => {
      cancelled = true
      ctrl.abort()
      window.clearTimeout(timer)
    }
  }, [])

  /**
   * Das Fenster kommt vom Server, nicht aus einer eigenen Konstanten.
   *
   * Solange das Backend noch nicht geantwortet hat, gilt die gemeinsame
   * Vorgabe — dieselbe, die der Server ohne `WINDOW_HOURS` benutzt.
   */
  const windowHours = status?.windowHours ?? DEFAULT_WINDOW_HOURS

  const results = useMemo(
    () => applyFilters(pool, filters, settings, sort, hoursToMs(windowHours)),
    [pool, filters, settings, sort, windowHours],
  )

  /**
   * Meldung bei Funden über der Schwelle — nur aus der gefilterten Liste und
   * nur bei echten Daten, nicht bei Demo-Daten.
   */
  const alerted = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!status?.online || settings.alertMinPercent <= 0) {
      alerted.current = new Set()
      return
    }
    const { fresh, next } = selectAlerts(
      results.map((o) => ({
        id: o.id,
        percent: arbPercentOf(o),
        label: `${o.home} — ${o.away} · ${o.market}`,
      })),
      settings.alertMinPercent,
      alerted.current,
    )
    alerted.current = next
    if (!fresh.length) return
    if (settings.alertSound) playChime()
    if (settings.alertDesktop) showAlert(fresh)
  }, [results, status?.online, settings.alertMinPercent, settings.alertSound, settings.alertDesktop])

  /**
   * Filter und Einstellungen zum Server spiegeln, damit die Telefonmeldung
   * dasselbe `applyFilters` nutzt. Entprellt, weil Schieberegler bei jedem
   * Pixel ein neues `filters` erzeugen.
   */
  useEffect(() => {
    if (!synced) return
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => {
      void putAlertConfig(filters, settings, pushConfig, ctrl.signal).then((s) => {
        if (s) setPush(s)
      })
    }, 600)
    return () => {
      window.clearTimeout(timer)
      ctrl.abort()
    }
  }, [filters, settings, pushConfig, synced])

  const selected = results.find((o) => o.id === selectedId) ?? results[0] ?? null

  const totals = useMemo(() => {
    const profits = results.map((o) => arbFor(o, settings))
    return {
      best: profits.length ? Math.max(...profits.map((p) => p.arbPercent)) : 0,
      sum: profits.reduce((s, p) => s + p.guaranteedProfit, 0),
    }
  }, [results, settings])

  const setBankroll = (bankroll: number) => setSettings((s) => ({ ...s, bankroll }))

  const refresh = async () => {
    setRefreshing(true)
    try {
      await triggerScan()
      const { opportunities, status } = await fetchOpportunities()
      setStatus(status)
      setPool(opportunities)
    } catch {
      // Ohne Backend: neue Demo-Daten würfeln
      setPool(generateOpportunities(48, Math.floor(Math.random() * 1e9)))
      setStatus((s) => (s ? { ...s, online: false } : null))
    } finally {
      setLastUpdate(new Date())
      setRefreshing(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <Header
        count={results.length}
        bankroll={settings.bankroll}
        onBankrollChange={setBankroll}
        search={filters.search}
        onSearchChange={(search) => setFilters((f) => ({ ...f, search }))}
        activeFilterCount={countActiveFilters(filters, DEFAULT_FILTERS)}
        onOpenFilters={() => setOverlay({ open: true, section: 'sportsbook' })}
        onOpenSettings={() => setOverlay({ open: true, section: 'settings' })}
        onRefresh={refresh}
        lastUpdate={lastUpdate}
        refreshing={refreshing}
      />

      <div className="flex min-h-0 flex-1">
        {/* Titel und Liste scrollen gemeinsam — der große Titel weicht wie in iOS nach oben aus. */}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          <div className="mx-auto max-w-[1400px] px-4 pb-10 pt-6 sm:px-6 sm:pt-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-[28px] font-bold leading-tight tracking-[-0.025em] sm:text-[32px]">
                  Wettmöglichkeiten
                </h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted">
                  <span>Vorspiel · nächste {windowLabel(windowHours)}</span>
                  <DataSourceBadge status={status} />
                </div>
              </div>
              <SortControl sort={sort} onChange={setSort} onMore={() => setOverlay({ open: true, section: 'sorting' })} />
            </div>

            {/* Kennzahlen */}
            <div className="mt-6 grid grid-cols-3 gap-3">
              <Metric label={results.length === 1 ? 'Wettmöglichkeit' : 'Wettmöglichkeiten'} value={String(results.length)} />
              <Metric label="Beste Rendite" value={pct(totals.best)} accent />
              <Metric
                label="Ø Gewinn je Wette"
                value={money(results.length ? totals.sum / results.length : 0)}
                title={`Bei ${money(settings.bankroll)} Bankroll`}
              />
            </div>

          {/* Liste */}
          <div className="mt-6 space-y-3">
            {results.length === 0 ? (
              <EmptyState
                status={status}
                // Vor der ersten Antwort ist der Bestand leer — weder Backend- noch Demo-Daten.
                loading={(!status && !pool.length) || !!status?.warming}
                sports={filters.sports}
                onReset={() => setFilters(DEFAULT_FILTERS)}
              />
            ) : (
              results.map((opp, i) => (
                <OpportunityCard
                  key={opp.id}
                  opp={opp}
                  index={i}
                  settings={settings}
                  selected={selected?.id === opp.id}
                  onSelect={() => setSelectedId(opp.id)}
                />
              ))
            )}
          </div>
          </div>
        </main>

        <DetailPanel
          opp={selected}
          settings={settings}
          onBankrollChange={setBankroll}
        />
      </div>

      <FilterOverlay
        key={overlay.section}
        open={overlay.open}
        initialSection={overlay.section}
        filters={filters}
        settings={settings}
        sort={sort}
        resultCount={results.length}
        push={push}
        pushConfig={pushConfig}
        onChangePushConfig={(patch) => setPushConfig((p) => ({ ...p, ...patch }))}
        windowHours={windowHours}
        onChangeFilters={(patch) => setFilters((f) => ({ ...f, ...patch }))}
        onChangeSettings={(patch) => setSettings((s) => ({ ...s, ...patch }))}
        onChangeSort={setSort}
        onReset={() => {
          setFilters(DEFAULT_FILTERS)
          setSettings(DEFAULT_SETTINGS)
          setSort('percentage-desc')
        }}
        onClose={() => setOverlay({ open: false })}
      />
    </div>
  )
}

/**
 * Leerer Zustand. Keine Arbitrage ist der Normalfall; gezeigt werden dann
 * die knappsten Vergleiche als Beleg, dass Matching und Vergleich laufen.
 */
function EmptyState({
  status,
  loading,
  sports,
  onReset,
}: {
  status: ScanStatus | null
  loading: boolean
  sports: string[]
  onReset: () => void
}) {
  // Die Vergleichsliste muss demselben Sportfilter folgen wie die Trefferliste.
  // Sonst wählt jemand "nur Tennis" und bekommt darunter weiter Fußball
  // vorgeführt — dieselbe Verwirrung, gegen die der Filter gebaut wurde.
  const margins = (status?.margins ?? []).filter((m) => sports.includes(m.sport))

  // Noch keine Antwort oder erster Durchlauf: das ist „lädt“, nicht „nichts gefunden“.
  if (loading) return <LoadingState status={status} />

  return (
    <div className="mx-auto mt-14 max-w-2xl animate-fade-in px-1">
      <div className="text-center">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-white text-accent shadow-card">
          <IconSearch className="h-6 w-6" />
        </div>
        <p className="text-[19px] font-semibold tracking-[-0.02em]">Aktuell keine Arbitrage</p>
        <p className="mx-auto mt-1.5 max-w-sm text-[14px] leading-relaxed text-muted">
          {status?.online
            ? 'Der Scanner läuft. Mit mehr angebundenen Buchmachern steigt die Trefferquote deutlich.'
            : 'Lockere die Filter — z.B. mehr Buchmacher auswählen oder die minimale Arbitrage senken.'}
        </p>
        <button
          onClick={onReset}
          className="mt-5 h-9 rounded-full bg-accent px-5 text-[13px] font-medium text-white hover:bg-accent-strong"
        >
          Filter zurücksetzen
        </button>
      </div>

      {margins.length > 0 && (
        <div className="mt-10">
          <h3 className="mb-1 text-[17px] font-semibold tracking-[-0.02em]">
            Knappste Vergleiche
          </h3>
          <p className="mb-4 text-[13px] text-muted">
            Summe der impliziten Wahrscheinlichkeiten über die jeweils besten Quoten.
            Unter&nbsp;100&nbsp;% wäre eine Arbitrage.
          </p>
          <div className="divide-y divide-line-soft overflow-hidden rounded-[18px] bg-white shadow-card">
            {margins.slice(0, 8).map((m, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-4 py-3"
              >
                <span className="figure w-[74px] shrink-0 whitespace-nowrap text-[14px] font-semibold text-dim">
                  {m.impliedPercent.toFixed(2)} %
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">{m.event}</p>
                  <p className="truncate text-[12px] text-muted">
                    {m.market} · {m.league}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  {m.legs.map((l, j) => (
                    <span
                      key={j}
                      className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-1.5 py-1 text-[12px]"
                      title={l.label}
                    >
                      <BookLogo id={l.bookmakerId} size="sm" className="!h-4 !w-4 !text-[6px]" />
                      <span className="tabular font-semibold">{l.odds.toFixed(2)}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Erster Durchlauf: Fortschritt über die Bücher statt einer leeren Liste. */
function LoadingState({ status }: { status: ScanStatus | null }) {
  const done = status?.booksDone ?? 0
  const total = status?.booksTotal || 16
  const share = status ? Math.max(0.04, done / total) : 0.04
  return (
    <div className="mx-auto mt-14 max-w-sm animate-fade-in text-center">
      <p className="text-[19px] font-semibold tracking-[-0.02em]">Quoten werden geladen</p>
      <p className="mt-1.5 text-[14px] leading-relaxed text-muted">
        {done < total
          ? `${done} von ${total} Buchmachern geliefert. Jeder erscheint, sobald er fertig ist.`
          : 'Alle Buchmacher geliefert, die Zusatzmärkte folgen.'}
      </p>
      <div className="mx-auto mt-5 h-1.5 w-48 overflow-hidden rounded-full bg-black/[0.06]">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  )
}

/**
 * Zeigt an, woher die Daten kommen. Ohne diesen Hinweis wäre nicht
 * erkennbar, ob gerade echte Quoten oder Demo-Daten in der Liste stehen —
 * ein Unterschied, der bei echtem Geldeinsatz zählt.
 */
function DataSourceBadge({ status }: { status: ScanStatus | null }) {
  if (status?.online && status.warming) {
    return (
      <span
        title={
          status.restored
            ? 'Die Liste zeigt den gespeicherten Stand des letzten Laufs; die Bücher werden gerade neu abgefragt. Alte Quoten sind als veraltet markiert.'
            : 'Erster Durchlauf nach dem Start — die Bücher erscheinen, sobald sie geliefert haben.'
        }
        className="flex h-6 items-center gap-1.5 rounded-full bg-accent/10 px-2.5 text-[12px] font-medium text-accent"
      >
        <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-accent/25 border-t-accent [animation-duration:700ms]" />
        {status.booksDone < status.booksTotal ? (
          <>
            {status.restored ? 'Letzter Stand · ' : ''}Lädt{' '}
            <span className="tabular">
              {status.booksDone}/{status.booksTotal}
            </span>{' '}
            Buchmacher
          </>
        ) : (
          'Zusatzmärkte werden geladen'
        )}
      </span>
    )
  }
  if (!status?.online) {
    return (
      <span
        title="Backend nicht erreichbar — die Liste zeigt generierte Demo-Daten. Starte den Scanner mit: npm run scan"
        className="flex h-6 items-center gap-1.5 rounded-full bg-warn/10 px-2.5 text-[12px] font-medium text-warn"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-warn" />
        Demo-Daten
      </span>
    )
  }
  const failed = status.books.filter((b) => b.error)
  const ageSec = status.lastRefresh
    ? Math.max(0, Math.round((Date.now() - new Date(status.lastRefresh).getTime()) / 1000))
    : null
  // Quoten leben Sekunden. Ab einer halben Minute ist der Stand nicht mehr
  // verlässlich, also wird die Anzeige gelb statt grün.
  const stale = ageSec !== null && ageSec > 30

  return (
    <span
      title={
        `${status.eventCount} Events geladen, ${status.matchedCount} über mehrere Buchmacher gematcht ` +
        `(${Math.round(status.srMatchRate * 100)} % per Sportradar-ID). ` +
        `${status.hotCount} Events werden im Sekundentakt nachgeladen.` +
        (status.flippedSources
          ? ` ${status.flippedSources} Quellen mit vertauschtem Heimrecht korrigiert.`
          : '') +
        (status.droppedSources ? ` ${status.droppedSources} unklare Quellen verworfen.` : '') +
        (failed.length ? ` Fehler: ${failed.map((f) => f.bookmakerId).join(', ')}` : '')
      }
      className={`flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium ${
        stale ? 'bg-warn/10 text-warn' : 'bg-accent/10 text-accent'
      }`}
    >
      <span className={`live-dot h-1.5 w-1.5 rounded-full ${stale ? 'bg-warn' : 'bg-accent'}`} />
      Live-Quoten
      {ageSec !== null && <span className="tabular">· {ageSec} s alt</span>}
      <span className="hidden font-normal text-muted sm:inline">
        · <span className="tabular">{status.books.length - failed.length}/{status.books.length}</span> Buchmacher ·{' '}
        <span className="tabular">{status.hotCount}</span> beobachtet
      </span>
      {failed.length > 0 && <span className="text-warn">· {failed.length} Fehler</span>}
    </span>
  )
}

/** Kennzahl-Kachel unter dem Titel: Beschriftung oben, Wert groß darunter. */
function Metric({ label, value, accent, title }: { label: string; value: string; accent?: boolean; title?: string }) {
  return (
    <div className="min-w-0 rounded-[18px] bg-white px-4 py-3.5 shadow-card" title={title}>
      <p className="truncate text-[12px] font-medium text-muted">{label}</p>
      <p className={`figure mt-1 truncate text-[20px] font-semibold sm:text-[24px] ${accent ? 'text-accent' : 'text-fg'}`}>
        {value}
      </p>
    </div>
  )
}

const SORT_SEGMENTS: { id: SortKey; label: string }[] = [
  { id: 'percentage-desc', label: 'Rendite' },
  { id: 'profit-desc', label: 'Gewinn' },
  { id: 'time-asc', label: 'Anstoß' },
]

/**
 * Segmentierte Sortierung wie in macOS. Der weiße Schieber gleitet unter das
 * gewählte Segment; ist eine seltenere Sortierung aus dem Einstellungsfenster
 * aktiv, steht er nirgends.
 */
function SortControl({ sort, onChange, onMore }: { sort: SortKey; onChange: (s: SortKey) => void; onMore: () => void }) {
  const active = SORT_SEGMENTS.findIndex((s) => s.id === sort)
  return (
    <div className="flex items-center gap-2">
      <div className="relative grid grid-cols-3 rounded-[10px] bg-black/[0.06] p-0.5">
        <span
          aria-hidden
          className={`absolute bottom-0.5 left-0.5 top-0.5 w-[calc((100%-4px)/3)] rounded-lg bg-white shadow-[0_0_0_0.5px_oklch(0_0_0/0.06),0_2px_6px_oklch(0_0_0/0.1)] transition-[translate,opacity] duration-300 ${
            active < 0 ? 'opacity-0' : 'opacity-100'
          }`}
          style={{ translate: `${Math.max(active, 0) * 100}% 0` }}
        />
        {SORT_SEGMENTS.map((s) => (
          <button
            key={s.id}
            onClick={() => onChange(s.id)}
            aria-pressed={sort === s.id}
            className={`relative h-7 px-4 text-[13px] font-medium ${sort === s.id ? 'text-fg' : 'text-muted hover:text-dim'}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <button
        onClick={onMore}
        title="Weitere Sortierungen"
        aria-label="Weitere Sortierungen"
        className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-black/[0.05] hover:text-fg"
      >
        <IconSort className="h-4 w-4" />
      </button>
    </div>
  )
}
