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
import { IconSort } from './components/icons'

/**
 * Wie oft der aktuelle Stand vom Backend geholt wird.
 *
 * Der Scanner aktualisiert die heißen Quoten im Sekundentakt; das Frontend
 * muss entsprechend oft nachfragen, sonst zeigt es Quoten an, die es längst
 * frischer gäbe. Der Aufruf geht gegen den Speicher des Servers und kostet
 * die Buchmacher nichts.
 */
const POLL_MS = 2_000

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
 * Version im Schlüssel, weil sich das Format mehrfach geändert hat: erst
 * standen in den Filtern Markt-Anzeigenamen statt Familien-IDs, dann fiel mit
 * den Einsatzlimits auch `respectLimits` weg. Ohne Bump würde ein alter Stand
 * aus dem Browser Einstellungen wiederherstellen, die es nicht mehr gibt.
 *
 * v4 kam mit Tennis. Der Grund ist hier nicht ein weggefallenes Feld, sondern
 * ein **hinzugekommenes**: ein gespeicherter Stand führt in `markets` nur die
 * damals bekannten Familien, also weder `2WAY` noch `AH`. Tennis wäre für
 * jeden bestehenden Nutzer unsichtbar geblieben — und zwar ohne Hinweis, denn
 * der Marktfilter hätte völlig unauffällig ausgesehen.
 */
const STORAGE_KEY = 'arbify.state.v4'

/**
 * Eigener Schlüssel für die Zugangsdaten des Meldedienstes.
 *
 * Getrennt vom übrigen Zustand, weil hier ein Geheimnis liegt: das
 * ntfy-Thema. Wer es löschen will, soll das können, ohne Bankroll und Filter
 * mit zu verlieren — und `Zurücksetzen` in der Oberfläche fasst es nicht an.
 */
const PUSH_KEY = 'arbify.push.v1'

function loadPushConfig(): PushConfig {
  try {
    const raw = localStorage.getItem(PUSH_KEY)
    return raw ? { ...EMPTY_PUSH_CONFIG, ...JSON.parse(raw) } : EMPTY_PUSH_CONFIG
  } catch {
    return EMPTY_PUSH_CONFIG
  }
}

/** Ist überhaupt nichts eingetragen? Dann darf der Server-Stand gewinnen. */
const isBlank = (p: PushConfig): boolean =>
  p.service === 'off' &&
  !p.ntfyTopic &&
  !p.pushoverToken &&
  !p.pushoverUser &&
  !p.webhookUrl

function loadStored<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return parsed[key] ? { ...fallback, ...parsed[key] } : fallback
  } catch {
    return fallback
  }
}

/**
 * Entfernt Buchmacher und Märkte aus dem gespeicherten Stand, die es nicht
 * mehr gibt.
 *
 * Ohne das würde ein Anbieter, der aus der Liste fliegt, dauerhaft als
 * "aktiver Filter" gezählt — der Nutzer sieht ein Filter-Abzeichen und
 * findet keine Einstellung, die es erklärt.
 */
/**
 * Welche Sportarten der gespeicherte Stand kannte.
 *
 * Ohne diese Angabe ist eine neu hinzugekommene Sportart von einer bewusst
 * abgewählten nicht zu unterscheiden — und dann bleibt sie für jeden
 * bestehenden Nutzer stumm weggefiltert. Genau das passierte beim Sprung von
 * zwei auf acht Sportarten: der Filter zeigte "2/8 ausgewählt", Basketball war
 * angebunden und lieferte Daten, und niemand hätte je etwas davon gesehen.
 *
 * Fehlt das Feld, stammt der Stand aus der Zeit vor den neuen Sportarten — und
 * damals gab es nur diese beiden.
 */
const SPORTS_BEFORE = ['Fußball', 'Tennis']

function loadSportsKnown(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return [...ALL_SPORT_IDS]
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.sportsKnown) ? parsed.sportsKnown : SPORTS_BEFORE
  } catch {
    return [...ALL_SPORT_IDS]
  }
}

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
  const [pool, setPool] = useState<Opportunity[]>(() => generateOpportunities(48))
  const [filters, setFilters] = useState<Filters>(() =>
    sanitizeFilters(loadStored('filters', DEFAULT_FILTERS)),
  )
  const [settings, setSettings] = useState<Settings>(() => loadStored('settings', DEFAULT_SETTINGS))
  const [sort, setSort] = useState<SortKey>('percentage-desc')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<{ open: boolean; section?: 'sportsbook' | 'settings' }>({ open: false })
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

  // Echte Daten vom Scanner-Backend holen. Ist es nicht erreichbar, bleibt
  // der Demo-Generator aktiv, damit die Oberfläche bedienbar bleibt.
  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()

    const load = async () => {
      try {
        const { opportunities, status } = await fetchOpportunities(ctrl.signal)
        if (cancelled) return
        setStatus(status)
        setPool(opportunities)
        setLastUpdate(new Date())
      } catch {
        if (!cancelled) setStatus((s) => (s ? { ...s, online: false } : null))
      }
    }

    void load()
    const timer = window.setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      ctrl.abort()
      window.clearInterval(timer)
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
   * Meldung bei Funden über der Schwelle.
   *
   * Hängt an `results`, also an der **gefilterten** Liste: gemeldet wird nur,
   * was der Nutzer auch sehen würde. Sonst klingelt es wegen eines Buchmachers,
   * den er abgewählt hat.
   *
   * Und nur bei echten Daten. Ist das Backend nicht erreichbar, füllt der
   * Demo-Generator die Liste mit gewürfelten Arbitragen — die würden im
   * Zwei-Sekunden-Takt Lärm machen und nichts bedeuten.
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
   * Filter und Einstellungen zum Server spiegeln.
   *
   * Damit meldet der Server aufs Telefon genau das, was hier auf dem Bildschirm
   * stünde — dieselbe `applyFilters` läuft dort noch einmal. Ohne diese
   * Spiegelung müsste der Server einen eigenen Filter führen, und zwei
   * Implementierungen driften auseinander: dann meldet das Telefon Funde, die
   * in der Liste gar nicht auftauchen, und man kann der Meldung nicht mehr
   * trauen.
   *
   * Entprellt, weil an den Schiebereglern jeder Pixel ein neues `filters`-
   * Objekt erzeugt — ungebremst wären das dutzende Anfragen je Handgriff.
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
        onBankrollChange={(bankroll) => setSettings((s) => ({ ...s, bankroll }))}
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
        <main className="flex min-w-0 flex-1 flex-col">
          {/* Statusleiste */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line-soft px-4 py-2.5 text-[12px]">
            <span className="font-semibold">
              <span className="text-accent">{results.length}</span>{' '}
              {results.length === 1 ? 'Wettmöglichkeit' : 'Wettmöglichkeiten'}
            </span>
            <span className="text-muted">
              Beste Rendite <b className="text-dim">{pct(totals.best)}</b>
            </span>
            <span className="text-muted">
              Bankroll <b className="text-dim">{money(settings.bankroll)}</b> · Gewinn je Wette Ø{' '}
              <b className="text-dim">{money(results.length ? totals.sum / results.length : 0)}</b>
            </span>
            <DataSourceBadge status={status} />
            <span className="ml-auto flex items-center gap-2 text-muted">
              Zeitfenster: <b className="text-dim">nächste {windowLabel(windowHours)}</b>
              <button
                onClick={() => setOverlay({ open: true, section: 'settings' })}
                className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 font-semibold text-dim transition hover:text-white"
              >
                <IconSort className="h-3.5 w-3.5" />
                {sortLabel(sort)}
              </button>
            </span>
          </div>

          {/* Liste */}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {results.length === 0 ? (
              <EmptyState status={status} sports={filters.sports} onReset={() => setFilters(DEFAULT_FILTERS)} />
            ) : (
              results.map((opp) => (
                <OpportunityCard
                  key={opp.id}
                  opp={opp}
                  settings={settings}
                  selected={selected?.id === opp.id}
                  onSelect={() => setSelectedId(opp.id)}
                />
              ))
            )}
          </div>
        </main>

        <DetailPanel
          opp={selected}
          settings={settings}
          onBankrollChange={(bankroll) => setSettings((s) => ({ ...s, bankroll }))}
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
 * Leerer Zustand.
 *
 * Bei nur drei angebundenen Buchmachern ist "keine Arbitrage" der Normalfall
 * — die Marge der Bücher liegt bei 5–8 %. Statt einer leeren Fläche werden
 * deshalb die knappsten Markt-Vergleiche gezeigt: sie belegen, dass Matching
 * und Quotenvergleich laufen, und machen sichtbar, wie weit es noch ist.
 */
function EmptyState({
  status,
  sports,
  onReset,
}: {
  status: ScanStatus | null
  sports: string[]
  onReset: () => void
}) {
  // Die Vergleichsliste muss demselben Sportfilter folgen wie die Trefferliste.
  // Sonst wählt jemand "nur Tennis" und bekommt darunter weiter Fußball
  // vorgeführt — dieselbe Verwirrung, gegen die der Filter gebaut wurde.
  const margins = (status?.margins ?? []).filter((m) => sports.includes(m.sport))

  return (
    <div className="mx-auto mt-12 max-w-2xl">
      <div className="text-center">
        <p className="text-[15px] font-semibold">Aktuell keine Arbitrage</p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-muted">
          {status?.online
            ? 'Der Scanner läuft. Mit mehr angebundenen Buchmachern steigt die Trefferquote deutlich.'
            : 'Lockere die Filter — z.B. mehr Buchmacher auswählen oder die minimale Arbitrage senken.'}
        </p>
        <button
          onClick={onReset}
          className="mt-4 rounded-xl bg-surface-2 px-4 py-2 text-[13px] font-semibold hover:bg-surface-3"
        >
          Filter zurücksetzen
        </button>
      </div>

      {margins.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-1 text-[11px] font-bold uppercase tracking-[0.16em] text-muted">
            Knappste Vergleiche
          </h3>
          <p className="mb-3 text-[11.5px] text-muted">
            Summe der impliziten Wahrscheinlichkeiten über die jeweils besten Quoten.
            Unter&nbsp;100&nbsp;% wäre eine Arbitrage.
          </p>
          <div className="space-y-1.5">
            {margins.slice(0, 8).map((m, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-xl border border-line-soft bg-surface px-3 py-2"
              >
                <span className="w-[74px] shrink-0 whitespace-nowrap text-[14px] font-bold tabular-nums text-dim">
                  {m.impliedPercent.toFixed(2)} %
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold">{m.event}</p>
                  <p className="truncate text-[11px] text-muted">
                    {m.market} · {m.league}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  {m.legs.map((l, j) => (
                    <span
                      key={j}
                      className="flex items-center gap-1 rounded-lg bg-surface-2 px-1.5 py-1 text-[11px]"
                      title={l.label}
                    >
                      <BookLogo id={l.bookmakerId} size="sm" className="!h-4 !w-4 !text-[6px]" />
                      <span className="font-semibold tabular-nums">{l.odds.toFixed(2)}</span>
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

/**
 * Zeigt an, woher die Daten kommen. Ohne diesen Hinweis wäre nicht
 * erkennbar, ob gerade echte Quoten oder Demo-Daten in der Liste stehen —
 * ein Unterschied, der bei echtem Geldeinsatz zählt.
 */
function DataSourceBadge({ status }: { status: ScanStatus | null }) {
  if (!status?.online) {
    return (
      <span
        title="Backend nicht erreichbar — die Liste zeigt generierte Demo-Daten. Starte den Scanner mit: npm run scan"
        className="flex items-center gap-1.5 rounded-lg bg-warn/12 px-2 py-1 font-semibold text-warn"
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
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1 font-semibold ${
        stale ? 'bg-warn/12 text-warn' : 'bg-accent/12 text-accent'
      }`}
    >
      <span className={`live-dot h-1.5 w-1.5 rounded-full ${stale ? 'bg-warn' : 'bg-accent'}`} />
      Live-Quoten
      {ageSec !== null && <span className="tabular-nums">· {ageSec} s alt</span>}
      <span className="font-normal text-muted">
        · {status.books.length - failed.length}/{status.books.length} Buchmacher · {status.hotCount} beobachtet
      </span>
      {failed.length > 0 && <span className="text-warn">· {failed.length} Fehler</span>}
    </span>
  )
}

function sortLabel(s: SortKey) {
  switch (s) {
    case 'percentage-asc':
      return 'Arb % ↑'
    case 'profit-desc':
      return 'Gewinn €'
    case 'time-asc':
      return 'Anstoß ↑'
    case 'time-desc':
      return 'Anstoß ↓'
    default:
      return 'Arb % ↓'
  }
}
