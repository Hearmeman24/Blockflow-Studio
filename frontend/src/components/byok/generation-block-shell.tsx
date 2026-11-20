'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { ExternalLink, Film, Image as ImageIcon, Info, Music } from 'lucide-react'
import { AlertPanel } from '@/components/alert-panel'
import { PromptLibraryButton } from '@/components/prompt-library/prompt-library-button'
import { BlockField } from '@/components/pipeline/block-field'
import { SourceModeControl } from '@/components/pipeline/source-mode-control'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { providerIds, providerName } from '@/lib/byok/catalog'
import { article } from '@/lib/byok/generation-blocks'
import { kindAccent } from '@/lib/byok/kind-accent'
import { insertMention } from '@/lib/byok/mentions'
import type { MediaKind, ProviderCatalog } from '@/lib/byok/types'
import { unavailableReason } from '@/lib/byok/generation-readiness'
import { RUN_END_PANEL, isActiveRun, runError } from '@/lib/byok/generation-run-state'
import { shownEstimate } from '@/lib/byok/use-cost-estimate'
import { useOptionalPipeline } from '@/lib/pipeline/pipeline-context'
import type { BlockComponentProps, BlockWarning } from '@/lib/pipeline/registry'
import { useHeaderWarnings } from '@/lib/pipeline/use-header-warnings'
import { PROVIDER_REFERRALS } from '@/lib/provider-referrals'
import { cn } from '@/lib/utils'
import { CostEstimateChip } from './cost-chip'
import { GenerationSettings } from './generation-settings'
import { MentionTextarea } from './mention-textarea'
import { ModelSelect } from './model-select'
import { NsfwBadge } from './nsfw-badge'
import { ProviderSelect } from './provider-select'
import {
  useGenerationBlock,
  type GenerationBlockConfig,
  type GenerationBlockState,
  type RunView,
} from './use-generation-block'

export type { GenerationBlockConfig } from './use-generation-block'
export { GENERATION_CONFIG_KEYS } from './use-generation-block'

export interface GenerationBlockShellProps extends BlockComponentProps {
  config: GenerationBlockConfig
  /** Job status poll interval; tests shorten it. */
  pollIntervalMs?: number
}

export function GenerationBlockShell({ config, pollIntervalMs, ...props }: GenerationBlockShellProps) {
  const state = useGenerationBlock(props, config, pollIntervalMs)
  const { load, retry } = state.catalogState

  switch (load.status) {
    case 'loading':
      return (
        <div aria-busy="true" aria-label="Loading providers">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )
    case 'error':
      return (
        <AlertPanel variant="error" title="Could not load the providers">
          <p>{load.error.message}</p>
          <Button type="button" variant="outline" size="xs" onClick={retry}>Retry</Button>
        </AlertPanel>
      )
    case 'ready':
      // A failed revalidation (`stale`) keeps the loaded catalog in use.
      return <ShellBody state={state} config={config} catalog={load.catalog} blockId={props.blockId} setHeaderWarnings={props.setHeaderWarnings} />
  }
}

function SetupGuidance({ catalog }: { catalog: ProviderCatalog }) {
  return (
    <AlertPanel variant="info" title="Add a provider key to generate">
      <p>BlockFlow uses your own Kie or PiAPI account. Save an API key in Settings; it stays on this computer.</p>
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <Button asChild variant="outline" size="xs">
          <Link href="/settings">Open Settings</Link>
        </Button>
        {providerIds(catalog).map((id) => {
          const href = PROVIDER_REFERRALS[id as keyof typeof PROVIDER_REFERRALS]
          if (!href) return null
          return (
            <Button key={id} asChild variant="link" size="xs" className="text-link h-auto px-0">
              <a href={href} target="_blank" rel="noreferrer">
                Create a {providerName(catalog, id)} account
                <ExternalLink aria-hidden />
              </a>
            </Button>
          )
        })}
      </div>
    </AlertPanel>
  )
}

function ShellBody({
  state,
  config,
  catalog,
  blockId,
  setHeaderWarnings,
}: {
  state: GenerationBlockState
  config: GenerationBlockConfig
  catalog: ProviderCatalog
  blockId: string
  setHeaderWarnings?: BlockComponentProps['setHeaderWarnings']
}) {
  const { spec, names } = state
  const unavailable = unavailableReason(state.readiness)
  const estimate = shownEstimate(state.cost)

  // Non-blocking warnings go to the header badge; errors that block a run stay in the body.
  const warnings: BlockWarning[] = []
  if (state.legacyReferences.length > 0) {
    const n = state.legacyReferences.length
    warnings.push({
      id: 'legacy-references',
      message: `${n} ${n === 1 ? 'reference was' : 'references were'} saved in this block by an older version. Move ${n === 1 ? 'it' : 'them'} into ${article(state.loader.label)} ${state.loader.label} to use ${n === 1 ? 'it' : 'them'}.`,
      action: { label: 'Move to a loader', onClick: state.moveLegacyReferences },
    })
  }
  for (const missing of state.missingLoaders) {
    warnings.push({
      id: missing.id,
      message: `No ${missing.label} before this block. References come from a loader block.`,
      action: { label: `Add ${missing.label}`, onClick: () => state.addLoader(missing.type) },
    })
  }
  if (state.missingOutput) {
    warnings.push({
      id: 'missing-output',
      message: `No output block. Add ${article(state.viewer.label)} ${state.viewer.label} after this block to see the result.`,
      action: { label: `Add ${state.viewer.label}`, onClick: state.addViewer },
    })
  }
  useHeaderWarnings(setHeaderWarnings, warnings)
  // A block that needs a prompt (Character Swap) says so whatever the ledger's rule for the model.
  const promptRule = config.promptRequired ? 'required' : spec?.prompt.requirement ?? 'required'
  const modelEntry = catalog.models.find((m) => m.id === state.model)
  const keyMissing = Boolean(state.provider && !catalog.providers[state.provider]?.configured)

  return (
    <div className="@container min-w-0" data-testid="generation-block">
      {state.noKeys && <SetupGuidance catalog={catalog} />}

      <div className="grid min-w-0 grid-cols-1 gap-2 @xs:grid-cols-2">
        <BlockField label="Provider">
          <ProviderSelect catalog={catalog} value={state.provider} onChange={state.selectProvider} />
        </BlockField>
        <BlockField label="Model">
          <ModelSelect
            catalog={catalog}
            mode={config.mode}
            provider={state.provider ?? ''}
            models={config.models}
            value={state.model}
            onChange={state.selectModel}
          />
        </BlockField>
      </div>
      {modelEntry?.nsfw && (
        <p className="text-muted-foreground flex items-center gap-1 text-3xs">
          <NsfwBadge /> NSFW-capable model. Provider content rules still apply.
        </p>
      )}

      {unavailable && (
        <AlertPanel variant="warning" title={`${names.model} is not available on ${names.provider}`}>
          <p>{unavailable}.</p>
          {keyMissing ? (
            <Button asChild variant="outline" size="xs">
              <Link href="/settings">Add the key in Settings</Link>
            </Button>
          ) : (
            <p>Choose another model or switch provider.</p>
          )}
        </AlertPanel>
      )}

      {promptRule !== 'none' && (
        <PromptField state={state} optional={promptRule === 'optional'} maxLength={spec?.prompt.max_length ?? null} />
      )}

      {spec && (
        <GenerationSettings
          spec={spec}
          params={state.params}
          onChange={state.updateParams}
          changes={state.changes}
          onDismissChanges={state.dismissChanges}
          where={state.where}
          trailing={estimate.estimate || estimate.unavailable
            ? <CostEstimateChip estimate={estimate.estimate} unavailable={estimate.unavailable} providerName={state.names.provider} />
            : null}
        />
      )}

      {config.referenceKinds.length > 0 && <SourceControls state={state} blockId={blockId} />}

      {state.hints.length > 0 && (
        <p data-testid="reference-hint" className="text-muted-foreground flex items-start gap-1 text-2xs">
          <Info aria-hidden className="mt-px size-3 shrink-0" />
          <span>{state.hints.join(' ')}</span>
        </p>
      )}

      {state.issues.length > 0 && (
        <AlertPanel variant="error" title="Fix before running">
          <ul className="list-disc space-y-0.5 pl-4">
            {state.issues.map((message, i) => <li key={i}>{message}</li>)}
          </ul>
        </AlertPanel>
      )}

      <RunStatus run={state.run} />
    </div>
  )
}

const KIND_NOUN: Record<MediaKind, [string, string]> = {
  image: ['image', 'images'],
  video: ['video', 'videos'],
  audio: ['audio clip', 'audio clips'],
}

/** Which upstream blocks feed each input, shown only when there is more than one to choose from. */
function SourceControls({ state, blockId }: { state: GenerationBlockState; blockId: string }) {
  const pipeline = useOptionalPipeline()
  if (!pipeline) return null
  return (
    <div className="flex min-w-0 flex-wrap justify-end gap-1 empty:hidden">
      {state.summary.map((row) => (
        <SourceModeControl key={row.kind} compact blockId={blockId} inputName={row.kind} inputKind={row.kind} label={KIND_NOUN[row.kind][1]} />
      ))}
    </div>
  )
}

function PromptField({ state, optional, maxLength }: { state: GenerationBlockState; optional: boolean; maxLength: number | null }) {
  const id = `prompt-${state.names.mode}`
  const label = optional ? 'Generation Prompt (optional)' : 'Generation Prompt'
  const text = state.prompt
  const over = maxLength !== null && text.length > maxLength
  const area = useRef<HTMLTextAreaElement>(null)
  const focusedOnce = useRef(false)
  const pendingCaret = useRef<number | null>(null)

  // Put the caret after the inserted text once the new prompt has rendered.
  useEffect(() => {
    const caret = pendingCaret.current
    if (caret === null || !area.current) return
    pendingCaret.current = null
    area.current.focus()
    area.current.setSelectionRange(caret, caret)
  }, [state.prompt])

  const insert = (mention: string) => {
    const el = area.current
    const result = insertMention(state.prompt, el?.selectionStart ?? state.prompt.length, el?.selectionEnd ?? state.prompt.length, mention, focusedOnce.current)
    pendingCaret.current = result.caret
    focusedOnce.current = true
    state.setPrompt(result.value)
  }

  const upstreamSwitch = (
    <Switch size="sm" aria-label="Use the upstream prompt" checked={state.useUpstreamPrompt} onCheckedChange={state.setUseUpstreamPrompt} />
  )

  // The prompt comes from upstream: no box, badges, library or counter; the
  // written prompt shows in the upstream block. The own prompt stays in state.
  if (state.promptFromUpstream) {
    return (
      <BlockField label={label}>
        <div className="text-2xs flex min-w-0 items-center justify-between gap-2" data-testid="upstream-prompt-source">
          <span className="text-muted-foreground min-w-0 truncate">
            Uses the prompt from {state.upstreamSource ?? 'the upstream block'}
          </span>
          {upstreamSwitch}
        </div>
      </BlockField>
    )
  }

  return (
    <BlockField
      label={label}
      htmlFor={id}
      action={(
        <div className="flex items-center gap-2">
          {/* A block with a default prompt (Character Swap) offers the way back to it once edited. */}
          {state.defaultPrompt !== null && state.prompt !== state.defaultPrompt && (
            <Button type="button" variant="link" size="xs" className="text-link h-auto px-0 text-3xs" onClick={state.resetPrompt}>
              Reset to default
            </Button>
          )}
          <PromptLibraryButton type="generation" value={state.prompt} onChange={state.setPrompt} />
        </div>
      )}
      hint={maxLength !== null ? `${text.length} / ${maxLength} characters` : undefined}
    >
      {state.hasUpstreamText && (
        <label className="text-2xs flex items-center justify-between gap-2">
          Use the upstream prompt
          {upstreamSwitch}
        </label>
      )}
      {state.badges.length > 0 && (
        <div role="group" aria-label="Insert a reference" className="flex min-w-0 flex-wrap gap-1" data-testid="reference-badges">
          {state.badges.map((badge) => (
            <Button
              key={badge.key}
              type="button"
              variant="outline"
              size="xs"
              title={badge.text}
              aria-label={`Insert reference to ${badge.label}`}
              onClick={() => insert(badge.text)}
              className="h-6 gap-1 rounded-full pr-2 pl-0.5 text-2xs font-normal"
            >
              {badge.thumbnail && badge.kind === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={badge.thumbnail} alt="" className="size-5 rounded-full object-cover" />
              ) : (
                <span aria-hidden className={cn('flex size-5 items-center justify-center rounded-full', kindAccent(badge.kind).chip)}>
                  <BadgeIcon kind={badge.kind} />
                </span>
              )}
              {badge.label}
            </Button>
          ))}
        </div>
      )}
      <MentionTextarea
        ref={area}
        id={id}
        value={text}
        mentions={state.badges}
        aria-invalid={over || undefined}
        onFocus={() => { focusedOnce.current = true }}
        onChange={(e) => state.setPrompt(e.target.value)}
        placeholder={optional ? 'Optional for this model' : 'Describe what to generate'}
        className="min-h-20 resize-y text-xs"
      />
    </BlockField>
  )
}

function BadgeIcon({ kind }: { kind: MediaKind }) {
  const Icon = kind === 'video' ? Film : kind === 'audio' ? Music : ImageIcon
  return <Icon className="size-3" />
}

/** Provider messages that repeat the header status and add nothing. */
const FILLER = /^(done|completed?|running|queued)\.?$/i

/** The provider's detail and progress while a job is active, e.g. "Queued at Kie · 40%". */
function activeDetail(run: RunView): string {
  if (!isActiveRun(run)) return ''
  const message = run.message && !FILLER.test(run.message.trim()) ? run.message.trim() : null
  const percent = run.status === 'running' && run.progress != null ? `${Math.round(run.progress * 100)}%` : null
  return [message, percent].filter(Boolean).join(' · ')
}

/**
 * The header status badge is the block's only status. The body adds only what
 * the badge cannot say: the provider's detail and progress while a job is
 * active, validation warnings, and the error when a run did not finish.
 */
function RunStatus({ run }: { run: RunView }) {
  if (run.status === 'idle') return null
  const detail = activeDetail(run)
  const { warnings } = run
  const ended = runError(run)
  if (!detail && warnings.length === 0 && !ended) return null
  return (
    <div role="status" aria-live="polite" className="space-y-1.5" data-testid="run-status">
      {detail && <p data-testid="run-detail" className="text-muted-foreground truncate text-3xs">{detail}</p>}
      {warnings.length > 0 && (
        <AlertPanel variant="warning">
          <ul className="list-disc space-y-0.5 pl-4">{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
        </AlertPanel>
      )}
      {ended && (
        <AlertPanel variant={RUN_END_PANEL[ended.status].variant} title={RUN_END_PANEL[ended.status].title}>
          <p>{ended.error}</p>
          <p className="text-muted-foreground">Fix the problem above if there is one, then press Run Pipeline again.</p>
        </AlertPanel>
      )}
    </div>
  )
}
