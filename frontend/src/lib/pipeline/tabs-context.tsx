'use client'

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { fetchFlow, fetchFlows, saveFlowToDisk, type FlowEntry } from '@/lib/api'
import type { FlowImportOutcome, SavedFlow } from './flow-io'
import { migrateSavedFlow, type FlowImportReport } from './flow-migrations'
import { mergeImportReports, notifyFlowImport, notifyFlowImportFailure } from './flow-import-notice'
import { LOOP_OFF, loopIteration, needsRestart, transitionLoop, type LoopEvent, type LoopState } from './loop-mode'
import type { PublishedTabRun, RunOutcome, TabRunState } from './run-phase'
import { FlowNameRequiredError } from './flow-errors'

export type { TabRunState } from './run-phase'

// ---- Types ----

export interface PipelineTab {
  id: string
  label: string
  flowName?: string
  /** SavedFlow JSON to import on first mount. Consumed once. */
  flowJson?: string
}

export interface TabActions {
  runPipeline: (opts?: { continueFromExisting?: boolean }) => Promise<{ hadError: boolean }>
  cancelPipeline: () => void
  exportFlowJson: (name?: string) => string
  importFlowJson: (json: string) => FlowImportOutcome
  hasHitlBlocks: () => boolean
}

/** Live runtime info pushed up from each PipelineProvider for the job manager. */
export interface TabRuntimeInfo {
  runningBlockLabel?: string
  statusMessage?: string
}

interface PipelineTabsContextValue {
  tabs: PipelineTab[]
  activeTabId: string
  /** Published by each tab's PipelineProvider from its run phase; nothing else writes it. */
  tabRunStates: Record<string, TabRunState>
  /** How each tab's last run ended (`cancelled` while a cancelled run unwinds). */
  tabRunOutcomes: Record<string, RunOutcome | null>
  isAnyRunning: boolean
  availableFlows: FlowEntry[]
  setActiveTabId: (id: string) => void
  addTab: (label?: string, flowJson?: string, flowName?: string) => string
  removeTab: (id: string) => void
  renameTab: (id: string, label: string) => void
  duplicateTab: (id: string) => string
  registerTabActions: (tabId: string, actions: TabActions) => void
  unregisterTabActions: (tabId: string) => void
  /** The one writer of `tabRunStates`: a tab's PipelineProvider publishing its run phase. */
  publishTabRun: (tabId: string, run: PublishedTabRun) => void
  tabRuntimeInfos: Record<string, TabRuntimeInfo>
  setTabRuntimeInfo: (tabId: string, info: TabRuntimeInfo) => void
  cancelTabPipeline: (tabId: string) => void
  loopStates: Record<string, LoopState>
  /** Derived from `loopStates`: true for each looping tab. */
  loopingTabs: Record<string, boolean>
  /** Derived from `loopStates`: the current iteration of each looping tab. */
  loopIterations: Record<string, number>
  startLoop: () => void
  stopLoop: (tabId?: string) => void
  runActivePipeline: () => void
  continueActivePipeline: () => void
  cancelActivePipeline: () => void
  refreshAvailableFlows: () => Promise<void>
  saveActiveFlow: (name?: string) => Promise<void>
  openFlowInActiveTab: (name: string) => Promise<void>
  openFlowInNewTab: (name: string) => Promise<void>
  /** Open a saved flow object (e.g. a run's flow snapshot) in a new active tab.
   *  Returns the new tab id, or null when the snapshot cannot be opened (the
   *  error is shown to the user). */
  restoreFlowSnapshot: (label: string, snapshot: unknown) => string | null
  saveWorkspace: (name: string) => Promise<void>
  loadWorkspace: (name: string) => Promise<void>
}

// ---- Persistence ----

const TABS_KEY = 'pipeline_tabs_v2'
const PIPELINE_PREFIX = 'pipeline_v2_'
const PIPELINE_RUNTIME_PREFIX = 'pipeline_runtime_v2_'
const DEFAULT_TAB_LABEL = 'New Pipeline'

function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// Stable placeholder used for both SSR and initial client render to avoid hydration mismatch.
// Real tabs are loaded from sessionStorage in a useEffect after mount.
const SSR_TAB_ID = '__ssr__'
const SSR_STATE = {
  tabs: [{ id: SSR_TAB_ID, label: DEFAULT_TAB_LABEL }] as PipelineTab[],
  activeTabId: SSR_TAB_ID,
}

function loadTabsFromStorage(): { tabs: PipelineTab[]; activeTabId: string } | null {
  try {
    const raw = sessionStorage.getItem(TABS_KEY)
    if (raw) {
      const data = JSON.parse(raw) as { tabs?: unknown[]; activeTabId?: unknown }
      if (Array.isArray(data.tabs) && typeof data.activeTabId === 'string' && data.tabs.length > 0) {
        const tabs = data.tabs
          .map((tab): PipelineTab | null => {
            if (!tab || typeof tab !== 'object') return null
            const t = tab as { id?: unknown; label?: unknown; flowName?: unknown }
            if (typeof t.id !== 'string') return null
            const flowName = typeof t.flowName === 'string' && t.flowName.trim() ? t.flowName.trim() : undefined
            const label =
              typeof t.label === 'string' && t.label.trim()
                ? t.label.trim()
                : flowName || DEFAULT_TAB_LABEL
            return { id: t.id, label, flowName }
          })
          .filter((tab): tab is PipelineTab => tab !== null)

        if (tabs.length > 0) {
          const hasActive = tabs.some((tab) => tab.id === data.activeTabId)
          return {
            tabs,
            activeTabId: hasActive ? data.activeTabId : tabs[0].id,
          }
        }
      }
    }
  } catch {
    // ignore malformed storage
  }
  return null
}

function createDefaultTabs(): { tabs: PipelineTab[]; activeTabId: string } {
  const id = generateTabId()
  const tabs: PipelineTab[] = [{ id, label: DEFAULT_TAB_LABEL }]
  return { tabs, activeTabId: id }
}

function saveTabs(tabs: PipelineTab[], activeTabId: string) {
  try {
    // Strip transient field (flowJson) before persisting
    const cleaned = tabs.map(({ id, label, flowName }) => ({ id, label, flowName }))
    sessionStorage.setItem(TABS_KEY, JSON.stringify({ tabs: cleaned, activeTabId }))
  } catch {
    // quota exceeded
  }
}

// ---- Context ----

const PipelineTabsCtx = createContext<PipelineTabsContextValue | null>(null)

export function usePipelineTabs() {
  const ctx = useContext(PipelineTabsCtx)
  if (!ctx) throw new Error('usePipelineTabs must be used within PipelineTabsProvider')
  return ctx
}

// ---- Provider ----

export function PipelineTabsProvider({ children }: { children: ReactNode }) {
  const [{ tabs, activeTabId }, setTabState] = useState(SSR_STATE)
  const [tabRunStates, setTabRunStates] = useState<Record<string, TabRunState>>({
    [SSR_TAB_ID]: 'idle',
  })
  const [availableFlows, setAvailableFlows] = useState<FlowEntry[]>([])
  const [tabRuntimeInfos, setTabRuntimeInfos] = useState<Record<string, TabRuntimeInfo>>({})
  const [tabRunOutcomes, setTabRunOutcomes] = useState<Record<string, RunOutcome | null>>({})
  const [loopStates, setLoopStates] = useState<Record<string, LoopState>>({})
  const loopStatesRef = useRef<Record<string, LoopState>>({})
  /** Tabs closed in this session: a run that unwinds after its tab closed publishes nothing. */
  const removedTabsRef = useRef<Set<string>>(new Set())
  const tabActionsRef = useRef<Map<string, TabActions>>(new Map())

  /** Apply a loop event to one tab; returns whether the tab's loop state changed. */
  const dispatchLoop = useCallback((tabId: string, event: LoopEvent): boolean => {
    const prev = loopStatesRef.current[tabId] ?? LOOP_OFF
    const next = transitionLoop(prev, event)
    if (next === prev) return false
    const all = { ...loopStatesRef.current }
    if (next.kind === 'off') delete all[tabId]
    else all[tabId] = next
    loopStatesRef.current = all
    setLoopStates(all)
    return true
  }, [])

  const loopingTabs = useMemo(() => {
    const out: Record<string, boolean> = {}
    for (const [id, state] of Object.entries(loopStates)) if (state.kind === 'looping') out[id] = true
    return out
  }, [loopStates])
  const loopIterations = useMemo(() => {
    const out: Record<string, number> = {}
    for (const [id, state] of Object.entries(loopStates)) {
      const iteration = loopIteration(state)
      if (iteration !== null) out[id] = iteration
    }
    return out
  }, [loopStates])
  const hydrated = useRef(false)

  const refreshAvailableFlows = useCallback(async () => {
    const response = await fetchFlows()
    if (!response?.ok || !Array.isArray(response.flows)) {
      throw new Error(response?.error || 'Failed to list flows')
    }

    const next: FlowEntry[] = response.flows
      .filter((flow: unknown): flow is FlowEntry => {
        if (!flow || typeof flow !== 'object') return false
        const f = flow as Partial<FlowEntry>
        return typeof f.name === 'string' && typeof f.filename === 'string'
      })
      .sort((a: FlowEntry, b: FlowEntry) => a.name.localeCompare(b.name))

    setAvailableFlows(next)
  }, [])

  // Hydrate from sessionStorage after mount (avoids SSR mismatch from random IDs)
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true
    const stored = loadTabsFromStorage()
    const state = stored ?? createDefaultTabs()
    saveTabs(state.tabs, state.activeTabId)
    // Fills in a default only: a tab's provider may already have published its run state.
    setTabRunStates((prev) => {
      const next: Record<string, TabRunState> = {}
      for (const tab of state.tabs) next[tab.id] = prev[tab.id] ?? 'idle'
      return next
    })
    setTabState(state)

    refreshAvailableFlows().catch(() => {
      setAvailableFlows([])
    })
  }, [refreshAvailableFlows])

  const setTabs = useCallback((updater: (prev: PipelineTab[]) => PipelineTab[], newActiveId?: string) => {
    setTabState((prev) => {
      const nextTabs = updater(prev.tabs)
      const nextActive = newActiveId ?? prev.activeTabId
      saveTabs(nextTabs, nextActive)
      return { tabs: nextTabs, activeTabId: nextActive }
    })
  }, [])

  const setActiveTabId = useCallback((id: string) => {
    setTabState((prev) => {
      saveTabs(prev.tabs, id)
      return { ...prev, activeTabId: id }
    })
  }, [])

  const addTab = useCallback((label?: string, flowJson?: string, flowName?: string): string => {
    const id = generateTabId()
    const trimmedFlowName = flowName?.trim() || undefined
    const tabLabel = label?.trim() || trimmedFlowName || DEFAULT_TAB_LABEL
    const newTab: PipelineTab = { id, label: tabLabel, flowName: trimmedFlowName, flowJson }

    // When no flowJson, write an empty pipeline so PipelineProvider starts blank
    if (!flowJson) {
      try {
        sessionStorage.setItem(`${PIPELINE_PREFIX}${id}`, JSON.stringify({ id: 'default', blocks: [] }))
      } catch {
        // quota exceeded
      }
    }

    setTabRunStates((prev) => ({ ...prev, [id]: 'idle' }))
    setTabs((prev) => [...prev, newTab])
    return id
  }, [setTabs])

  const removeTab = useCallback((id: string) => {
    // Cancel running pipeline before removing the tab
    if (tabs.length > 1) dispatchLoop(id, { type: 'stop' })
    const actions = tabActionsRef.current.get(id)
    if (actions && (tabRunStates[id] === 'running')) {
      actions.cancelPipeline()
    }

    setTabState((prev) => {
      if (prev.tabs.length <= 1) return prev // can't remove last tab
      const nextTabs = prev.tabs.filter((t) => t.id !== id)
      let nextActive = prev.activeTabId
      if (nextActive === id) {
        // Switch to adjacent tab
        const removedIdx = prev.tabs.findIndex((t) => t.id === id)
        nextActive = nextTabs[Math.min(removedIdx, nextTabs.length - 1)].id
      }

      // Clean up sessionStorage for removed tab
      try {
        sessionStorage.removeItem(`${PIPELINE_PREFIX}${id}`)
        sessionStorage.removeItem(`${PIPELINE_RUNTIME_PREFIX}${id}`)
      } catch {
        // ignore
      }

      saveTabs(nextTabs, nextActive)
      tabActionsRef.current.delete(id)
      removedTabsRef.current.add(id)
      setTabRunStates((prevStates) => {
        const nextStates = { ...prevStates }
        delete nextStates[id]
        return nextStates
      })
      setTabRunOutcomes((prevOutcomes) => {
        if (!(id in prevOutcomes)) return prevOutcomes
        const nextOutcomes = { ...prevOutcomes }
        delete nextOutcomes[id]
        return nextOutcomes
      })
      setTabRuntimeInfos((prevInfos) => {
        const nextInfos = { ...prevInfos }
        delete nextInfos[id]
        return nextInfos
      })
      return { tabs: nextTabs, activeTabId: nextActive }
    })
  }, [dispatchLoop, tabRunStates, tabs.length])

  const renameTab = useCallback((id: string, label: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, label } : t)))
  }, [setTabs])

  const duplicateTab = useCallback((id: string) => {
    const tab = tabs.find((t) => t.id === id)
    if (!tab) return ''
    const actions = tabActionsRef.current.get(id)
    const flowJson = actions?.exportFlowJson(`${tab.label} (copy)`) ?? ''
    const newId = addTab(`${tab.label} (copy)`, flowJson || undefined)
    return newId
  }, [tabs, addTab])

  const registerTabActions = useCallback((tabId: string, actions: TabActions) => {
    tabActionsRef.current.set(tabId, actions)
  }, [])

  const unregisterTabActions = useCallback((tabId: string) => {
    tabActionsRef.current.delete(tabId)
  }, [])

  const publishTabRun = useCallback((tabId: string, run: PublishedTabRun) => {
    if (removedTabsRef.current.has(tabId)) return
    setTabRunStates((prev) => (prev[tabId] === run.state ? prev : { ...prev, [tabId]: run.state }))
    setTabRunOutcomes((prev) => (prev[tabId] === run.outcome ? prev : { ...prev, [tabId]: run.outcome }))
    // Whoever cancelled the run (Stop, the job manager, closing the tab), the loop stops.
    if (run.outcome === 'cancelled') dispatchLoop(tabId, { type: 'runCancelled' })
  }, [dispatchLoop])

  const setTabRuntimeInfo = useCallback((tabId: string, info: TabRuntimeInfo) => {
    setTabRuntimeInfos((prev) => {
      const existing = prev[tabId]
      if (existing?.runningBlockLabel === info.runningBlockLabel && existing?.statusMessage === info.statusMessage) return prev
      return { ...prev, [tabId]: info }
    })
  }, [])

  const cancelTabPipeline = useCallback((tabId: string) => {
    dispatchLoop(tabId, { type: 'stop' })
    const actions = tabActionsRef.current.get(tabId)
    if (!actions) return
    actions.cancelPipeline()
  }, [dispatchLoop])

  const isAnyRunning = Object.values(tabRunStates).some((state) => state === 'running')

  const stopLoop = useCallback((tabId?: string) => {
    dispatchLoop(tabId ?? activeTabId, { type: 'stop' })
  }, [activeTabId, dispatchLoop])

  /** Run one loop iteration and report how it ended; an error stops the loop. */
  const runLoopIteration = useCallback(async (tabId: string, actions: TabActions) => {
    const result = await actions.runPipeline()
    dispatchLoop(tabId, { type: 'runEnded', hadError: result.hadError })
  }, [dispatchLoop])

  const startLoop = useCallback(async () => {
    const actions = tabActionsRef.current.get(activeTabId)
    if (!actions) return
    if (actions.hasHitlBlocks()) return // HITL pipelines can't loop
    if ((tabRunStates[activeTabId] ?? 'idle') === 'running') return
    if (!dispatchLoop(activeTabId, { type: 'start' })) return
    await runLoopIteration(activeTabId, actions)
  }, [activeTabId, dispatchLoop, runLoopIteration, tabRunStates])

  // Auto-restart: start the next iteration of every looping tab whose run has
  // ended, unless another run occupies the tab.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const [tabId, state] of Object.entries(loopStates)) {
      if (!needsRestart(state)) continue
      if (tabRunStates[tabId] === 'running') continue
      const actions = tabActionsRef.current.get(tabId)
      if (!actions) continue
      // Outside render; the transition guards against a restart scheduled twice.
      timers.push(setTimeout(() => {
        if (!dispatchLoop(tabId, { type: 'restart' })) return
        void runLoopIteration(tabId, actions)
      }, 0))
    }
    return () => timers.forEach(clearTimeout)
  }, [dispatchLoop, loopStates, runLoopIteration, tabRunStates])

  const runActivePipeline = useCallback(async () => {
    if ((tabRunStates[activeTabId] ?? 'idle') === 'running') return

    const actions = tabActionsRef.current.get(activeTabId)
    if (!actions) return

    await actions.runPipeline()
  }, [activeTabId, tabRunStates])

  const continueActivePipeline = useCallback(async () => {
    if ((tabRunStates[activeTabId] ?? 'idle') === 'running') return

    const actions = tabActionsRef.current.get(activeTabId)
    if (!actions) return

    await actions.runPipeline({ continueFromExisting: true })
  }, [activeTabId, tabRunStates])

  const cancelActivePipeline = useCallback(() => {
    dispatchLoop(activeTabId, { type: 'stop' })
    const actions = tabActionsRef.current.get(activeTabId)
    if (!actions) return
    actions.cancelPipeline()
  }, [activeTabId, dispatchLoop])

  const saveActiveFlow = useCallback(async (name?: string) => {
    const actions = tabActionsRef.current.get(activeTabId)
    if (!actions) return

    const currentTab = tabs.find((tab) => tab.id === activeTabId)
    const resolvedName = (name?.trim() || currentTab?.flowName || '').trim()
    if (!resolvedName) {
      throw new FlowNameRequiredError()
    }

    const flowJson = actions.exportFlowJson(resolvedName)
    const parsed = JSON.parse(flowJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid flow payload')
    }

    const response = await saveFlowToDisk(resolvedName, parsed as Record<string, unknown>)
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to save flow')
    }

    const savedName = String(response.name || resolvedName)
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId) return tab
      return {
        ...tab,
        label: savedName,
        flowName: savedName,
      }
    }))

    await refreshAvailableFlows().catch(() => {})
  }, [activeTabId, refreshAvailableFlows, setTabs, tabs])

  const openFlowInActiveTab = useCallback(async (name: string) => {
    const actions = tabActionsRef.current.get(activeTabId)
    if (!actions) return

    const response = await fetchFlow(name)
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to load flow')
    }
    if (!response.flow || typeof response.flow !== 'object' || Array.isArray(response.flow)) {
      throw new Error('Invalid flow file')
    }

    const loadedName = String(response.name || name)
    const outcome = actions.importFlowJson(JSON.stringify(response.flow))
    if (!outcome.ok) {
      notifyFlowImportFailure(outcome.error)
      throw new Error(outcome.error)
    }
    void notifyFlowImport(outcome.report, 'flow', [outcome.flow])
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== activeTabId) return tab
      return {
        ...tab,
        label: loadedName,
        flowName: loadedName,
      }
    }))
  }, [activeTabId, setTabs])

  const openFlowInNewTab = useCallback(async (name: string) => {
    const response = await fetchFlow(name)
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to load flow')
    }
    if (!response.flow || typeof response.flow !== 'object' || Array.isArray(response.flow)) {
      throw new Error('Invalid flow file')
    }

    const loadedName = String(response.name || name)
    // Validate before creating the tab so a refused flow opens nothing.
    const migrated = migrateSavedFlow(response.flow)
    if (!migrated.ok) {
      notifyFlowImportFailure(migrated.error)
      throw new Error(migrated.error)
    }
    const id = addTab(loadedName, JSON.stringify(migrated.flow), loadedName)
    setActiveTabId(id)
    void notifyFlowImport(migrated.report, 'flow', [migrated.flow])
  }, [addTab, setActiveTabId])

  const restoreFlowSnapshot = useCallback((label: string, snapshot: unknown): string | null => {
    const migrated = migrateSavedFlow(snapshot)
    if (!migrated.ok) {
      notifyFlowImportFailure(migrated.error, 'run')
      return null
    }
    const id = addTab(label, JSON.stringify(migrated.flow))
    setActiveTabId(id)
    void notifyFlowImport(migrated.report, 'run', [migrated.flow])
    return id
  }, [addTab, setActiveTabId])

  const saveWorkspace = useCallback(async (name: string) => {
    const workspace: { tabs: Array<{ label: string; flow: unknown }> } = { tabs: [] }
    for (const tab of tabs) {
      const actions = tabActionsRef.current.get(tab.id)
      if (!actions) continue
      try {
        const flowJson = actions.exportFlowJson(tab.label)
        workspace.tabs.push({ label: tab.label, flow: JSON.parse(flowJson) })
      } catch {
        // skip tabs that can't be exported
      }
    }
    await saveFlowToDisk(`_workspace_${name}`, workspace as unknown as Record<string, unknown>)
    await refreshAvailableFlows().catch(() => {})
  }, [tabs, refreshAvailableFlows])

  const loadWorkspace = useCallback(async (name: string) => {
    const response = await fetchFlow(`_workspace_${name}`)
    if (!response?.ok) throw new Error(response?.error || 'Failed to load workspace')
    const fail = (message: string): never => {
      notifyFlowImportFailure(message, 'workspace')
      throw new Error(message)
    }
    const workspace = response.flow as { tabs?: unknown } | null | undefined
    const rawTabs = workspace && typeof workspace === 'object' ? workspace.tabs : undefined
    if (!Array.isArray(rawTabs) || rawTabs.length === 0) fail('Invalid workspace file')

    // Migrate every tab before touching the open tabs, so a refused tab leaves
    // the current workspace exactly as it was.
    const loaded: Array<{ label: string; flowJson: string }> = []
    const flows: SavedFlow[] = []
    const reports: FlowImportReport[] = []
    ;(rawTabs as unknown[]).forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('Invalid workspace file')
      const wt = entry as { label?: unknown; flow?: unknown }
      const label = typeof wt.label === 'string' && wt.label.trim() ? wt.label.trim() : `Tab ${index + 1}`
      const migrated = migrateSavedFlow(wt.flow)
      if (!migrated.ok) return fail(`Tab "${label}": ${migrated.error}`)
      loaded.push({ label, flowJson: JSON.stringify(migrated.flow) })
      flows.push(migrated.flow)
      reports.push(migrated.report)
    })

    // Close all existing tabs except one, then load workspace tabs
    for (const tab of tabs.slice(1)) removeTab(tab.id)
    // Load first tab into existing tab
    const firstTab = loaded[0]
    const firstActions = tabActionsRef.current.get(tabs[0]?.id ?? '')
    if (firstActions && firstTab) {
      firstActions.importFlowJson(firstTab.flowJson)
      renameTab(tabs[0].id, firstTab.label)
    }
    // Create remaining tabs
    for (let i = 1; i < loaded.length; i++) {
      const newId = addTab(loaded[i].label, loaded[i].flowJson)
      setActiveTabId(newId)
    }
    // Switch to first tab
    if (tabs[0]) setActiveTabId(tabs[0].id)
    void notifyFlowImport(mergeImportReports(reports), 'workspace', flows)
  }, [tabs, addTab, removeTab, renameTab, setActiveTabId])

  return (
    <PipelineTabsCtx.Provider
      value={{
        tabs,
        activeTabId,
        tabRunStates,
        tabRunOutcomes,
        isAnyRunning,
        availableFlows,
        setActiveTabId,
        addTab,
        removeTab,
        renameTab,
        duplicateTab,
        registerTabActions,
        unregisterTabActions,
        publishTabRun,
        tabRuntimeInfos,
        setTabRuntimeInfo,
        cancelTabPipeline,
        loopStates,
        loopingTabs,
        loopIterations,
        startLoop,
        stopLoop,
        runActivePipeline,
        continueActivePipeline,
        cancelActivePipeline,
        refreshAvailableFlows,
        saveActiveFlow,
        openFlowInActiveTab,
        openFlowInNewTab,
        restoreFlowSnapshot,
        saveWorkspace,
        loadWorkspace,
      }}
    >
      {children}
    </PipelineTabsCtx.Provider>
  )
}
