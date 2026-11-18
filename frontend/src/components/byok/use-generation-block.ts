'use client'

/**
 * State and execute logic shared by the five generation blocks. The layout
 * lives in `generation-block-shell.tsx`.
 *
 * Persisted per block (sessionStorage `block_<id>_<key>`, listed in the
 * blocks' `configKeys` so flow save/restore round-trips them):
 *   provider, model, prompt, use_upstream_prompt, params
 *
 * `use_upstream_prompt` turns on by itself when a text source becomes wired
 * upstream, and off when it is removed; see "Upstream prompt" below.
 *
 * References are not held here: they arrive from an upstream loader block
 * (Image Loader, Omni Reference Loader), which shows and repairs them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BlockComponentProps } from '@/lib/pipeline/registry'
import { toText } from '@/lib/pipeline/block-utils'
import { useSessionState } from '@/lib/use-session-state'
import {
  findModel,
  getModeSpec,
  modeName,
  modelAvailability,
  providerName,
  configuredProviders,
} from '@/lib/byok/catalog'
import { checkReferences, kindPlural } from '@/lib/byok/check-references'
import { EMPTY_PARAMS, buildRequestParams, reconcileParams, type ParamChange, type ParamState } from '@/lib/byok/params'
import {
  combineReferences,
  restoreReferences,
  toRequestReference,
  upstreamReferences,
  type GenerationReference,
} from '@/lib/byok/references'
import {
  GenerationRunError,
  cancelResumedGeneration,
  jobOutputValue,
  resumeGeneration,
  runGeneration,
  type RunStatus,
  type RunUpdate,
} from '@/lib/byok/run-generation'
import type { GenerationIssue, GenerationRequest, MediaKind, ModeSpec, ProviderCatalog } from '@/lib/byok/types'
import { useProviderCatalog } from '@/lib/byok/use-provider-catalog'
import { referenceBadges } from '@/lib/byok/mentions'
import { useCostEstimate } from '@/lib/byok/use-cost-estimate'
import { readJobCost } from '@/lib/byok/cost'
import { GENERATION_RUN_STATUS_LABEL } from '@/lib/status'
import type { JobSnapshot } from '@/lib/types'
import { useOptionalPipeline } from '@/lib/pipeline/pipeline-context'
import { loaderForReferences } from '@/lib/pipeline/migrate-references-to-loaders'
import { GENERATION_BLOCK_CONFIGS, resolveGenerationSelection, type GenerationBlockConfig } from '@/lib/byok/generation-blocks'

export const GENERATION_CONFIG_KEYS = ['provider', 'model', 'prompt', 'use_upstream_prompt', 'params'] as const

export type { GenerationBlockConfig }

export interface RunView {
  status: RunStatus | 'idle'
  jobId?: string
  progress?: number | null
  message?: string | null
  error?: string | null
  warnings?: GenerationIssue[]
}

/** When to look again for a charge the provider reports after the job finished. */
export const LATE_COST_CHECKS_MS = [1000, 5000, 15000, 45000]

/** What one input port will receive, for the block's read-only summary. */
export interface UpstreamSummary {
  kind: MediaKind
  count: number
  /** Labels of the blocks this port reads from. */
  sources: string[]
}

/** Issues that only say "add something": shown as a neutral hint until a run is attempted. */
const EMPTY_BLOCK_CODES: ReadonlySet<string> = new Set(['too_few_references', 'first_frame_required'])

function loaderFor(config: GenerationBlockConfig) {
  return config.mode === 'omni_reference_to_video'
    ? { type: 'omniReferenceLoader', label: 'Omni Reference Loader' }
    : { type: 'uploadImageToTmpfiles', label: 'Image Loader' }
}

/** The estimate's request: the prompt never affects the price, so it is not part of it. */
function withoutPrompt(request: GenerationRequest | null): GenerationRequest | null {
  if (!request) return null
  const params = { ...request.params }
  delete params.prompt
  return { ...request, params }
}

/** Drop the total-count message when a per-kind count message already says the same. */
function withoutRedundantCounts(issues: GenerationIssue[]): GenerationIssue[] {
  const perKind = issues.some((i) => i.code === 'too_few_references' && i.field !== 'references')
  return perKind ? issues.filter((i) => !(i.code === 'too_few_references' && i.field === 'references')) : issues
}

export function useGenerationBlock(
  props: BlockComponentProps,
  config: GenerationBlockConfig,
  pollIntervalMs?: number,
) {
  const { blockId, inputs, setOutput, registerExecute, setStatusMessage, setExecutionStatus, hasUpstreamProducer } = props
  const { mode, output } = config
  const blockType = Object.keys(GENERATION_BLOCK_CONFIGS).find((t) => GENERATION_BLOCK_CONFIGS[t].mode === mode) ?? ''
  const key = (name: string) => `block_${blockId}_${name}`

  const catalogState = useProviderCatalog()
  const { catalog } = catalogState

  const [storedProvider, setStoredProvider] = useSessionState<string | null>(key('provider'), null)
  const [storedModel, setStoredModel] = useSessionState<string | null>(key('model'), null)
  const [prompt, setPrompt] = useSessionState<string>(key('prompt'), '')
  // Read before useSessionState's first write: was a choice stored (reload, flow load)?
  const [hadStoredUpstreamChoice] = useState(() => {
    try {
      return sessionStorage.getItem(key('use_upstream_prompt')) !== null
    } catch {
      return true
    }
  })
  const [useUpstreamPrompt, setUseUpstreamPrompt] = useSessionState<boolean>(key('use_upstream_prompt'), false)
  const [storedParams, setStoredParams] = useSessionState<ParamState>(key('params'), EMPTY_PARAMS)
  // Not persisted: after a reload the resumed poll repopulates it.
  const [run, setRun] = useState<RunView>({ status: 'idle' })
  const [changes, setChanges] = useState<ParamChange[]>([])
  const [serverIssues, setServerIssues] = useState<GenerationIssue[]>([])
  // Until a run is attempted, "add a reference" issues are a neutral hint rather than an error.
  const [touchedState, setTouched] = useState(false)
  const pipeline = useOptionalPipeline()
  const touched = touchedState || Boolean(pipeline?.isRunning)

  const params: ParamState = useMemo(
    () => ({ ...EMPTY_PARAMS, ...(storedParams ?? {}), settings: { ...(storedParams?.settings ?? {}) } }),
    [storedParams],
  )
  // ---- Provider / model / spec ----
  const { provider, model } = useMemo(
    () => resolveGenerationSelection(catalog, mode, storedProvider, storedModel),
    [catalog, mode, storedProvider, storedModel],
  )

  const spec: ModeSpec | null = catalog && provider && model ? getModeSpec(catalog, provider, model, mode, params.settings) : null
  const availability = catalog && provider && model
    ? modelAvailability(catalog, model, provider, mode)
    : { available: false, reason: null }
  const modelEntry = findModel(catalog, model ?? '')
  const names = {
    model: modelEntry?.name ?? model ?? 'this model',
    provider: provider ? providerName(catalog, provider) : 'the provider',
    mode: modeName(catalog, mode),
  }
  const where = `${names.model} on ${names.provider}`
  const noKeys = Boolean(catalog) && configuredProviders(catalog as ProviderCatalog).length === 0

  const applySelection = useCallback((nextProvider: string, nextModel: string) => {
    const nextSpec = catalog ? getModeSpec(catalog, nextProvider, nextModel, mode, params.settings) : null
    if (nextSpec) {
      const nextWhere = `${findModel(catalog, nextModel)?.name ?? nextModel} on ${providerName(catalog, nextProvider)}`
      const result = reconcileParams(nextSpec, params, nextWhere)
      if (result.changes.length > 0) setStoredParams(result.params)
      setChanges(result.changes)
    } else {
      setChanges([])
    }
    setStoredProvider(nextProvider)
    setStoredModel(nextModel)
    setServerIssues([])
  }, [catalog, mode, params, setStoredParams, setStoredProvider, setStoredModel])

  const selectProvider = useCallback((next: string) => {
    if (model) applySelection(next, model)
    else setStoredProvider(next)
  }, [applySelection, model, setStoredProvider])

  const selectModel = useCallback((next: string) => {
    if (provider) applySelection(provider, next)
    else setStoredModel(next)
  }, [applySelection, provider, setStoredModel])

  const updateParams = useCallback((next: ParamState) => {
    // A variant setting (GPT Image tier) can change which fields exist.
    if (catalog && provider && model) {
      const nextSpec = getModeSpec(catalog, provider, model, mode, next.settings)
      if (nextSpec && nextSpec !== spec) {
        const result = reconcileParams(nextSpec, next, where)
        setStoredParams(result.params)
        setChanges(result.changes)
        return
      }
    }
    setStoredParams(next)
  }, [catalog, provider, model, mode, spec, where, setStoredParams])

  // ---- References: they all come from upstream loader blocks ----
  const inputKinds = config.referenceKinds
  const upstream = useMemo(() => upstreamReferences(inputs, inputKinds), [inputs, inputKinds])
  const entries = useMemo(
    () => (inputKinds.length === 0 ? [] : combineReferences(mode, upstream, [])),
    [inputKinds.length, mode, upstream],
  )
  const checkable = entries.map((e) => toRequestReference(e.ref, e.ref.role))
  const loader = loaderFor(config)
  const sourceLabels = (kind: MediaKind) => pipeline?.getPortSources(blockId, kind).map((p) => p.blockLabel) ?? []
  const summary: UpstreamSummary[] = inputKinds.map((kind) => ({
    kind,
    count: entries.filter((e) => e.ref.kind === kind).length,
    sources: sourceLabels(kind),
  }))
  const hasAnySource = summary.some((s) => s.sources.length > 0)

  const kindOfIssue = (issue: GenerationIssue): MediaKind | null => {
    const byKind = /^references\.(image|video|audio)$/.exec(issue.field)
    if (byKind) return byKind[1] as MediaKind
    const byIndex = /^references\[(\d+)\]/.exec(issue.field)
    if (byIndex) return entries[Number(byIndex[1])]?.ref.kind ?? null
    if (issue.field.startsWith('references.first_frame') || issue.field.startsWith('references.last_frame')) return 'image'
    return inputKinds.length === 1 && issue.field === 'references' ? inputKinds[0] : null
  }
  /** Point the message at the loader that holds the references, or say to add one. */
  const withWhereToFix = (issue: GenerationIssue): string => {
    if (!issue.field.startsWith('references')) return issue.message
    const kind = kindOfIssue(issue)
    const labels = kind ? sourceLabels(kind) : [...new Set(inputKinds.flatMap(sourceLabels))]
    const where = labels.map((l) => `"${l}"`).join(', ')
    if (labels.length > 0) {
      return EMPTY_BLOCK_CODES.has(issue.code)
        ? `${issue.message} Add ${kind ? kindPlural(kind) : 'references'} in ${where}.`
        : `${issue.message} Fix it in ${where}.`
    }
    return pipeline ? `${issue.message} Add an ${loader.label} before this block.` : issue.message
  }
  const clientIssues = spec && inputKinds.length > 0
    ? withoutRedundantCounts(checkReferences(spec, checkable, { modelName: names.model, providerName: names.provider, modeName: names.mode }))
    : []
  const allIssues = [...clientIssues, ...serverIssues.filter((s) => !clientIssues.some((c) => c.code === s.code && c.field === s.field))]
  const asHint = (issue: GenerationIssue) => !touched && entries.length === 0 && EMPTY_BLOCK_CODES.has(issue.code)
  const issues = allIssues.filter((i) => !asHint(i) && i.severity === 'error').map(withWhereToFix)
  const hints = [...new Set(allIssues.filter(asHint).map(withWhereToFix))]

  /** Insert the matching loader directly upstream (after the user removed the spawned one). */
  const addLoader = useCallback(() => {
    pipeline?.insertBlockAdjacent(blockId, 'before', loader.type)
  }, [pipeline, blockId, loader.type])

  // References saved inside this block by an older version (still in this tab's
  // session). Flow import moves them into a loader; this does the same here.
  const legacyKey = key('references')
  const [legacyReferences, setLegacyReferences] = useState<GenerationReference[]>(() => {
    if (inputKinds.length === 0 || typeof window === 'undefined') return []
    try {
      return restoreReferences(JSON.parse(sessionStorage.getItem(legacyKey) ?? '[]'))
    } catch {
      return []
    }
  })
  const moveLegacyReferences = useCallback(() => {
    const block = loaderForReferences(blockType, legacyReferences)
    if (!block || !pipeline) return
    if (pipeline.insertBlockAdjacent(blockId, 'before', block.type, block.config) === null) return
    try {
      sessionStorage.removeItem(legacyKey)
    } catch {
      // nothing to clean up
    }
    setLegacyReferences([])
  }, [pipeline, blockId, blockType, legacyReferences, legacyKey])

  // ---- Missing output block (a warning only; never blocks a run) ----
  const outputConsumers = pipeline ? pipeline.getDownstreamConsumers(blockId, output) : null
  const missingOutput = outputConsumers !== null && outputConsumers.length === 0
  const viewer = output === 'video' ? { type: 'videoViewer', label: 'Video Viewer' } : { type: 'imageViewer', label: 'Image Viewer' }
  const addViewer = useCallback(() => {
    pipeline?.insertBlockAdjacent(blockId, 'after', viewer.type)
  }, [pipeline, blockId, viewer.type])

  // ---- Upstream prompt ----
  // A block upstream that outputs text (Prompt Writer, Prompt From Txt, ...).
  const hasUpstreamText = Boolean(hasUpstreamProducer?.('text')) || Boolean(toText(inputs.text).trim())
  // The switch follows the transition "no prompt source" -> "a source" (on) and
  // back (off). A choice the user makes in between is kept, also across reloads
  // and in saved flows: a stored choice counts as already having seen the source.
  const seenUpstreamText = useRef(hadStoredUpstreamChoice ? hasUpstreamText : false)
  useEffect(() => {
    if (hasUpstreamText === seenUpstreamText.current) return
    seenUpstreamText.current = hasUpstreamText
    setUseUpstreamPrompt(hasUpstreamText)
  }, [hasUpstreamText, setUseUpstreamPrompt])
  const upstreamSources = pipeline?.getPortSources(blockId, 'text') ?? []
  /** Where the prompt comes from, e.g. "1 · Prompt Writer". */
  const upstreamSource = upstreamSources.length > 0
    ? upstreamSources.map((p) => `${p.blockIndex + 1} · ${p.blockLabel}`).join(', ')
    : null
  const promptFromUpstream = useUpstreamPrompt && hasUpstreamText

  // ---- Run ----
  /** True when this run takes its prompt from upstream. */
  const usesUpstream = (fresh: Record<string, unknown>) =>
    useUpstreamPrompt && (Boolean(hasUpstreamProducer?.('text')) || Boolean(toText(fresh.text).trim()))
  const effectivePrompt = (fresh: Record<string, unknown>) =>
    usesUpstream(fresh) ? toText(fresh.text).trim() : prompt

  /** The request a run would submit for these inputs (null until a model is chosen). */
  const buildRequest = (fresh: Record<string, unknown>): GenerationRequest | null => {
    if (!provider || !model || !spec) return null
    const refs = inputKinds.length === 0 ? [] : combineReferences(mode, upstreamReferences(fresh, inputKinds), [])
    return {
      provider,
      model,
      mode,
      params: buildRequestParams(spec, params, effectivePrompt(fresh)),
      references: refs.map((e) => toRequestReference(e.ref, e.ref.role)),
    }
  }

  // Pre-run estimate of that same request, only when it could actually run.
  const canEstimate = Boolean(catalog && provider && catalog.providers[provider]?.configured && availability.available && spec)
  // The prompt never changes the price, so it is left out: typing does not re-request.
  const estimateRequest = canEstimate ? withoutPrompt(buildRequest(inputs)) : null
  const cost = useCostEstimate(estimateRequest, { enabled: canEstimate })

  // A charge the provider reports after the job finished: look again a few times
  // and re-emit the output with the cost on its metadata, so viewers update.
  const lateCost = useRef<ReturnType<typeof setTimeout>[]>([])
  const stopLateCost = useCallback(() => {
    lateCost.current.forEach(clearTimeout)
    lateCost.current = []
  }, [])
  useEffect(() => stopLateCost, [stopLateCost])
  const watchLateCost = useCallback((job: JobSnapshot) => {
    stopLateCost()
    if (readJobCost(job.cost)) return
    let found = false
    lateCost.current = LATE_COST_CHECKS_MS.map((delay) => setTimeout(async () => {
      if (found) return
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(job.job_id)}`)
        const body = (await res.json()) as { job?: JobSnapshot }
        if (found || !body?.job || !readJobCost(body.job.cost)) return
        found = true
        stopLateCost()
        setOutput(output, jobOutputValue({ ...job, cost: body.job.cost, price_check: body.job.price_check }, output))
      } catch {
        // Try again at the next check; the output itself is already there.
      }
    }, delay))
  }, [output, setOutput, stopLateCost])


  const applyUpdate = useCallback((update: RunUpdate) => {
    setRun((prev) => ({
      status: update.status,
      jobId: update.jobId ?? prev.jobId,
      progress: update.progress ?? null,
      message: update.message ?? null,
      error: null,
      warnings: update.issues?.filter((i) => i.severity === 'warning') ?? prev.warnings,
    }))
    setStatusMessage(update.status === 'running' && update.progress != null
      ? `Running ${Math.round(update.progress * 100)}%`
      : GENERATION_RUN_STATUS_LABEL[update.status])
  }, [setRun, setStatusMessage])

  useEffect(() => {
    registerExecute(async (freshInputs, signal) => {
      if (!catalog) throw new Error('The provider catalog has not loaded yet. Wait a moment and run again.')
      if (noKeys) throw new Error('Add a Kie or PiAPI API key in Settings to run this block.')
      if (!provider || !model || !spec) throw new Error(availability.reason ?? `Choose a model for ${names.mode}.`)
      if (!availability.available) throw new Error(availability.reason ?? `${where} is not available.`)

      stopLateCost()
      const latest = inputKinds.length === 0
        ? []
        : combineReferences(mode, upstreamReferences(freshInputs, inputKinds), [])
      setTouched(true)
      const broken = latest.filter((e) => e.ref.status === 'error' || (!e.ref.local && !e.ref.url))
      if (broken.length > 0) {
        const first = broken[0].ref
        throw new Error(`${first.label ?? 'A reference'}: ${first.error ?? 'has no file or URL.'} Fix it in the loader block.`)
      }
      // Too many items from upstream: say which block sends them.
      if (pipeline) {
        const fresh = latest.map((e) => toRequestReference(e.ref, e.ref.role))
        const issue = checkReferences(spec, fresh, { modelName: names.model, providerName: names.provider, modeName: names.mode })
          .find((i) => i.code === 'too_many_references' || i.code === 'media_kind_not_accepted')
        const kind = issue ? (/^references\.(image|video|audio)$/.exec(issue.field)?.[1] as MediaKind | undefined) : undefined
        if (issue && kind && latest.some((e) => e.source === 'upstream' && e.ref.kind === kind)) {
          const sources = pipeline.getPortSources(blockId, kind).map((p) => `"${p.blockLabel}"`)
          if (sources.length > 0) {
            throw new Error(`${issue.message} The ${kindPlural(kind)} come from ${sources.join(', ')}; fix it there.`)
          }
        }
      }
      if (usesUpstream(freshInputs)) {
        // Say plainly that the problem is in the prompt another block sent.
        const text = effectivePrompt(freshInputs)
        const from = upstreamSource ? `"${upstreamSource}"` : 'the upstream block'
        const max = spec.prompt.max_length
        if (!text && spec.prompt.requirement === 'required') {
          throw new Error(`The prompt from ${from} is empty. Check that block, or turn off "Use the upstream prompt" and write one here.`)
        }
        if (max !== null && text.length > max) {
          throw new Error(
            `The prompt from ${from} is ${text.length.toLocaleString('en-US')} characters; ${where} takes up to ${max.toLocaleString('en-US')}. `
            + 'Shorten it in that block, or turn off "Use the upstream prompt".',
          )
        }
      }
      const request = buildRequest(freshInputs)!
      setServerIssues([])
      try {
        const job = await runGeneration({ blockId, request, signal, pollIntervalMs, onUpdate: applyUpdate })
        const value = jobOutputValue(job, output)
        setOutput(output, value)
        watchLateCost(job)
        setRun((prev) => ({ ...prev, status: 'completed', progress: 1, error: null }))
        setStatusMessage(GENERATION_RUN_STATUS_LABEL.completed)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setRun((prev) => ({ ...prev, status: 'cancelled', error: null }))
          throw err
        }
        const message = err instanceof Error && err.message ? err.message : 'The generation failed. Try again.'
        if (err instanceof GenerationRunError && err.issues.length > 0) setServerIssues(err.issues)
        const status: RunStatus = err instanceof GenerationRunError && err.kind === 'cancelled'
          ? 'cancelled'
          : err instanceof GenerationRunError && err.kind === 'timeout' ? 'timed_out' : 'failed'
        setRun((prev) => ({ ...prev, status, error: message }))
        throw new Error(message)
      }
    })
  })

  // Resume a job that was running when the page was reloaded.
  useEffect(() => {
    const resumed = resumeGeneration({ blockId, pollIntervalMs, onUpdate: applyUpdate })
    if (!resumed) return
    setExecutionStatus?.('running')
    let active = true
    resumed.promise
      .then((job) => {
        if (!active) return
        try {
          setOutput(output, jobOutputValue(job, output))
          watchLateCost(job)
          setRun((prev) => ({ ...prev, status: 'completed', progress: 1, error: null }))
          setExecutionStatus?.('completed')
        } catch (err) {
          const message = err instanceof Error ? err.message : 'The generation failed.'
          setRun((prev) => ({ ...prev, status: 'failed', error: message }))
          setExecutionStatus?.('error', message)
        }
      })
      .catch((err) => {
        if (!active) return
        if (err instanceof DOMException && err.name === 'AbortError') {
          cancelResumedGeneration(blockId, resumed.jobId)
          setRun((prev) => ({ ...prev, status: 'cancelled' }))
          setExecutionStatus?.('cancelled')
          return
        }
        const message = err instanceof Error ? err.message : 'The generation failed.'
        setRun((prev) => ({ ...prev, status: 'failed', error: message }))
        setExecutionStatus?.('error', message)
      })
    return () => {
      active = false
    }
    // Resume once per mounted block.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId])

  return {
    catalogState,
    catalog,
    provider,
    model,
    spec,
    availability,
    names,
    where,
    noKeys,
    prompt,
    setPrompt,
    useUpstreamPrompt,
    setUseUpstreamPrompt,
    hasUpstreamText,
    promptFromUpstream,
    upstreamSource,
    params,
    updateParams,
    changes,
    dismissChanges: () => setChanges([]),
    selectProvider,
    selectModel,
    costEstimate: cost.estimate,
    costUnavailable: cost.unavailable,
    summary,
    badges: referenceBadges(spec, entries.map((e) => e.ref)),
    hasAnySource,
    referenceCount: entries.length,
    issues,
    hints,
    loader,
    addLoader,
    legacyReferences,
    moveLegacyReferences,
    missingOutput,
    viewer,
    addViewer,
    pipelineAttached: Boolean(pipeline),
    run,
    hasUpstreamProducer,
  }
}

export type GenerationBlockState = ReturnType<typeof useGenerationBlock>
