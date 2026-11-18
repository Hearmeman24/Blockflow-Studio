'use client'

import Link from 'next/link'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Copy, RefreshCw, RotateCcw, SlidersHorizontal, Thermometer } from 'lucide-react'
import { toast } from 'sonner'
import { AlertPanel } from '@/components/alert-panel'
import { StatusBadge } from '@/components/status-badge'
import { PromptLibraryButton } from '@/components/prompt-library/prompt-library-button'
import { BlockField } from '@/components/pipeline/block-field'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { generateWithWriter } from '@/lib/prompt-writer/api'
import {
  MAX_TOKENS_RANGE,
  MODE_LABELS,
  TEMPERATURE_RANGE,
  activeSystemPrompt,
  defaultSystemPrompt,
  normalizeWriterSettings,
  type WriterMode,
  type WriterSettings,
} from '@/lib/prompt-writer/config'
import {
  DEFAULT_SEND_MEDIA,
  MEDIA_LABELS,
  SEND_MEDIA_KEY,
  mediaBlocker,
  normalizeSendMedia,
  toMediaRequest,
  upstreamMedia,
  type SendMedia,
} from '@/lib/prompt-writer/media'
import {
  WRITER_MEDIA_KINDS,
  type WriterErrorKind,
  type WriterMediaKind,
  type WriterProviderId,
  type WriterProviderStatus,
} from '@/lib/prompt-writer/types'
import { useWriterProviders } from '@/lib/prompt-writer/use-writer-providers'
import type { BlockComponentProps } from '@/lib/pipeline/registry'
import { useSessionState } from '@/lib/use-session-state'
import { cn } from '@/lib/utils'
import { WriterModelField } from './writer-model-field'
import { WriterProviderSelect } from './writer-provider-select'

export const PROMPT_OUTPUT_PORT = 'prompt'

type RunState =
  | { status: 'idle' }
  | { status: 'running'; provider: string }
  | { status: 'success'; message: string }
  | { status: 'cancelled' }
  | { status: 'error'; kind: WriterErrorKind; message: string }

const ERROR_TITLES: Record<WriterErrorKind, string> = {
  validation: 'Check the block before running',
  unavailable: 'The provider is not available',
  auth: 'The API key was rejected',
  insufficient_credits: 'Not enough credits',
  rate_limited: 'Rate limited',
  model_not_found: 'Model not found',
  timeout: 'The model took too long',
  network: 'Could not connect',
  provider_failure: 'The provider could not write the prompt',
  malformed_response: 'Unexpected answer from the provider',
}

class WriterRunError extends Error {
  constructor(readonly kind: WriterErrorKind, message: string) {
    super(message)
  }
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof DOMException && err.name === 'AbortError')
}

/** The provider to use: the saved one, else the first available. */
function effectiveProvider(settings: WriterSettings, providers: WriterProviderStatus[] | undefined): WriterProviderId | null {
  if (settings.provider) return settings.provider
  return providers?.find((p) => p.available)?.id ?? null
}

/** The model to use: the saved one, else a local server's first model. */
function effectiveModel(settings: WriterSettings, status: WriterProviderStatus | undefined): string {
  if (!status) return ''
  const saved = settings.models[status.id]
  if (saved) return saved
  return status.kind === 'local' && status.available ? (status.models[0]?.id ?? '') : ''
}

export function PromptWriterBlock({
  blockId,
  inputs,
  setOutput,
  registerExecute,
  setStatusMessage,
  hasUpstreamProducer,
}: BlockComponentProps) {
  const prefix = `block_${blockId}_`
  const [rawSettings, setRawSettings] = useSessionState<unknown>(`${prefix}local_settings`, null)
  const [rawSend, setRawSend] = useSessionState<unknown>(`${prefix}${SEND_MEDIA_KEY}`, DEFAULT_SEND_MEDIA)
  const [idea, setIdea] = useSessionState<string>(`${prefix}user_prompt`, '')
  const [result, setResult] = useSessionState<string>(`${prefix}output`, '')
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const state = useWriterProviders()
  const ideaId = useId()
  const resultId = useId()

  const settings = useMemo(() => normalizeWriterSettings(rawSettings), [rawSettings])
  const update = (patch: Partial<WriterSettings>) => setRawSettings({ ...settings, ...patch })
  /** Set one mode's system prompt on the latest settings (Undo may come after a mode switch). */
  const setSystemPrompt = (mode: WriterMode, value: string) => setRawSettings((prev: unknown) => ({
    ...normalizeWriterSettings(prev),
    ...(mode === 'image' ? { image_system_prompt: value } : { video_system_prompt: value }),
  }))

  const providers = state.providers
  const providerId = effectiveProvider(settings, providers)
  const current = providers?.find((p) => p.id === providerId)
  const model = effectiveModel(settings, current)
  const ideaText = typeof idea === 'string' ? idea : ''
  const resultText = typeof result === 'string' ? result : ''
  const isLocal = current?.kind === 'local'

  // ---- Media from upstream ----
  const send = useMemo(() => normalizeSendMedia(rawSend), [rawSend])
  const media = useMemo(() => upstreamMedia(inputs ?? {}), [inputs])
  /** Kinds with something upstream (or a block that will produce it): one box each. */
  const shownKinds = WRITER_MEDIA_KINDS.filter((k) => media.counts[k] > 0 || Boolean(hasUpstreamProducer?.(k)))
  /** Ticked kinds that are upstream: they filter the models and block a run. */
  const activeKinds = shownKinds.filter((k) => send[k])
  const blocker = current?.available ? mediaBlocker(current, model.trim(), activeKinds) : null
  const toggleKind = (kind: WriterMediaKind, on: boolean) =>
    setRawSend((prev: unknown) => ({ ...normalizeSendMedia(prev), [kind]: on }))

  useEffect(() => {
    registerExecute(async (freshInputs, signal) => {
      if (settings.keep_result && resultText.trim()) {
        setOutput(PROMPT_OUTPUT_PORT, resultText)
        setRun({ status: 'success', message: 'Kept the existing result.' })
        return
      }
      try {
        if (!providerId) throw new WriterRunError('unavailable', 'No provider is available. Set one up first.')
        if (current && !current.available) {
          throw new WriterRunError('unavailable', `${current.reason}. Your text and settings are kept; fix this, then press Re-check.`)
        }
        if (!model.trim()) throw new WriterRunError('validation', 'Choose a model.')
        if (!ideaText.trim()) throw new WriterRunError('validation', 'Write a user prompt first.')
        // The media this run sends: the ticked kinds, read from the inputs the runner resolved now.
        const ticked = WRITER_MEDIA_KINDS.filter((k) => send[k])
        const refs = ticked.length > 0 ? upstreamMedia(freshInputs ?? {}, ticked).refs : []
        const sentKinds = WRITER_MEDIA_KINDS.filter((k) => refs.some((r) => r.kind === k))
        const refused = current ? mediaBlocker(current, model.trim(), sentKinds) : null
        if (refused) throw new WriterRunError('validation', refused)
        const unsaved = refs.find((r) => !r.local)
        if (unsaved) {
          throw new WriterRunError('validation', `${unsaved.label ?? 'A file'} is not saved in BlockFlow. Add it again in the block that loads it.`)
        }
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        // Remember an automatically chosen provider and model with the flow.
        if (settings.provider !== providerId || settings.models[providerId] !== model.trim()) {
          update({ provider: providerId, models: { ...settings.models, [providerId]: model.trim() } })
        }
        setRun({ status: 'running', provider: current?.label ?? providerId })
        setStatusMessage('Writing the prompt…')
        const res = await generateWithWriter({
          provider: providerId,
          model: model.trim(),
          input: ideaText,
          system_prompt: activeSystemPrompt(settings),
          // Local servers use their own sampling settings (the backend drops these for them too).
          ...(isLocal ? {} : { temperature: settings.temperature, max_tokens: settings.max_tokens }),
          ...(refs.length > 0 ? { media: toMediaRequest(refs) } : {}),
        }, signal)
        if (!res.ok) throw new WriterRunError(res.kind, res.message)
        setResult(res.text)
        setOutput(PROMPT_OUTPUT_PORT, res.text)
        setRun({ status: 'success', message: `Written by ${current?.label ?? providerId}.` })
      } catch (err) {
        if (isAbort(err, signal)) {
          setRun({ status: 'cancelled' })
          throw err
        }
        const kind = err instanceof WriterRunError ? err.kind : 'provider_failure'
        const message = err instanceof Error ? err.message : String(err)
        setRun({ status: 'error', kind, message })
        throw err instanceof Error ? err : new Error(message)
      }
    })
  })

  if (state.isLoading) {
    return (
      <div aria-busy="true" aria-label="Checking providers">
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
        </div>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  const nothingAvailable = Boolean(providers && !providers.some((p) => p.available))

  return (
    <div className="@container min-w-0" data-testid="prompt-writer-block">
      {!providers && (
        <AlertPanel variant="error" title="Could not check the providers">
          <p>{state.error?.message ?? 'The provider list is unavailable.'}</p>
          <Button type="button" variant="outline" size="xs" onClick={() => void state.recheck()} disabled={state.rechecking}>
            {state.rechecking ? 'Checking…' : 'Retry'}
          </Button>
        </AlertPanel>
      )}

      {providers && nothingAvailable && (
        <SetupGuidance providers={providers} rechecking={state.rechecking} onRecheck={() => void state.recheck()} />
      )}

      {providers && !nothingAvailable && (
        <>
          <div className="grid min-w-0 grid-cols-1 gap-2 @xs:grid-cols-2">
            <BlockField label="Provider">
              <WriterProviderSelect
                providers={providers}
                value={providerId}
                onChange={(id) => update({ provider: id })}
              />
            </BlockField>
            <BlockField label="Model">
              <WriterModelField
                provider={current}
                value={model}
                requiredKinds={activeKinds}
                onChange={(m) => providerId && update({ provider: providerId, models: { ...settings.models, [providerId]: m } })}
              />
            </BlockField>
          </div>
          <ProviderSummary providers={providers} rechecking={state.rechecking} onRecheck={() => void state.recheck()} />
          {state.error && <p className="text-destructive text-3xs">{state.error.message}</p>}
          {current && !current.available && (
            <AlertPanel variant="warning" title={`${current.label} is not available`}>
              <p>{current.reason}.</p>
              <p className="text-muted-foreground">Your text and settings are kept. {fixHint(current)}</p>
            </AlertPanel>
          )}
        </>
      )}

      {shownKinds.length > 0 && (
        <SendMediaGroup blockId={blockId} kinds={shownKinds} counts={media.counts} send={send} onToggle={toggleKind} />
      )}

      {blocker && (
        <AlertPanel variant="error" title="The model cannot take this media">
          <p data-testid="media-blocker">{blocker}</p>
        </AlertPanel>
      )}

      <BlockField
        label="User Prompt"
        htmlFor={ideaId}
        action={<PromptLibraryButton type="user" value={ideaText} onChange={setIdea} />}
      >
        <Textarea
          id={ideaId}
          value={ideaText}
          onChange={(e) => setIdea(e.target.value)}
          placeholder={settings.mode === 'image'
            ? 'A short idea for the image, e.g. a lighthouse keeper at dawn, 1970s film look'
            : 'A short idea for the video, e.g. a fox crossing a frozen lake at dawn'}
          className="min-h-16 resize-y text-xs"
        />
      </BlockField>

      {!nothingAvailable && (
        <StyleSettings
          settings={settings}
          onChange={update}
          onSystemChange={setSystemPrompt}
          localProvider={isLocal ? current?.label ?? null : null}
        />
      )}

      <ResultField
        id={resultId}
        value={resultText}
        onChange={setResult}
        keep={settings.keep_result}
        onKeepChange={(keep) => update({ keep_result: keep })}
      />

      <RunStatus run={run} onRecheck={() => void state.recheck()} />
    </div>
  )
}

function fixHint(status: WriterProviderStatus): string {
  if (status.id === 'openrouter') return 'Add an OpenRouter key in Settings.'
  return `Start ${status.label}, then press Re-check.`
}

function ProviderSummary({ providers, rechecking, onRecheck }: {
  providers: WriterProviderStatus[]
  rechecking: boolean
  onRecheck: () => void
}) {
  const ready = providers.filter((p) => p.available).map((p) => p.label)
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <p className="text-muted-foreground min-w-0 truncate text-3xs" data-testid="provider-summary">
        Available: {ready.join(', ')}
      </p>
      <Button type="button" variant="ghost" size="xs" onClick={onRecheck} disabled={rechecking} className="text-2xs">
        <RefreshCw aria-hidden className={cn(rechecking && 'animate-spin')} />
        {rechecking ? 'Checking…' : 'Re-check'}
      </Button>
    </div>
  )
}

function SetupGuidance({ providers, rechecking, onRecheck }: {
  providers: WriterProviderStatus[]
  rechecking: boolean
  onRecheck: () => void
}) {
  const reason = (id: WriterProviderId) => providers.find((p) => p.id === id)?.reason
  return (
    <AlertPanel variant="info" title="Set up a model to write prompts">
      <ul className="list-disc space-y-1 pl-4">
        <li>
          <span className="font-medium">OpenRouter:</span> save an OpenRouter API key in Settings → API keys.
          {reason('openrouter') && <span className="text-muted-foreground block text-2xs">{reason('openrouter')}.</span>}
        </li>
        <li>
          <span className="font-medium">Ollama:</span> install Ollama, run <code className="font-mono">ollama pull llama3.2</code> and keep it running.
          {reason('ollama') && <span className="text-muted-foreground block text-2xs">{reason('ollama')}.</span>}
        </li>
        <li>
          <span className="font-medium">LM Studio:</span> load a model and start the local server (Developer tab).
          {reason('lmstudio') && <span className="text-muted-foreground block text-2xs">{reason('lmstudio')}.</span>}
        </li>
      </ul>
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <Button asChild variant="outline" size="xs">
          <Link href="/settings">Open Settings</Link>
        </Button>
        <Button type="button" variant="outline" size="xs" onClick={onRecheck} disabled={rechecking}>
          <RefreshCw aria-hidden className={cn(rechecking && 'animate-spin')} />
          {rechecking ? 'Checking…' : 'Re-check'}
        </Button>
      </div>
    </AlertPanel>
  )
}

/** "Send to the model": one box per media kind upstream, with its count. */
function SendMediaGroup({ blockId, kinds, counts, send, onToggle }: {
  blockId: string
  kinds: readonly WriterMediaKind[]
  counts: Record<WriterMediaKind, number>
  send: SendMedia
  onToggle: (kind: WriterMediaKind, on: boolean) => void
}) {
  const labelId = useId()
  return (
    <div role="group" aria-labelledby={labelId} className="space-y-1">
      <Label id={labelId} className="text-2xs">Send to the model</Label>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {kinds.map((kind) => {
          const id = `${blockId}-send-${kind}`
          return (
            <div key={kind} className="flex items-center gap-1.5">
              <Checkbox id={id} checked={send[kind]} onCheckedChange={(v) => onToggle(kind, v === true)} />
              <Label htmlFor={id} className="text-xs font-normal">{MEDIA_LABELS[kind]} ({counts[kind]})</Label>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const CHIP = 'h-6 gap-1 rounded-full px-2 text-2xs font-normal'

function StyleSettings({ settings, onChange, onSystemChange, localProvider }: {
  settings: WriterSettings
  onChange: (patch: Partial<WriterSettings>) => void
  onSystemChange: (mode: WriterMode, value: string) => void
  /** The local server's label (Ollama, LM Studio): its own sampling settings apply, so the chips are hidden. */
  localProvider: string | null
}) {
  const [open, setOpen] = useState(false)
  const systemId = useId()
  const system = activeSystemPrompt(settings)
  const isDefault = system === defaultSystemPrompt(settings.mode)
  // Bound to the mode shown now, so a later Undo restores this mode's text.
  const mode = settings.mode
  const setSystem = (value: string) => onSystemChange(mode, value)
  const useSaved = (value: string) => {
    setSystem(value)
    setOpen(true)
  }
  return (
    <div className="space-y-1.5">
      <div role="toolbar" aria-label="Writer settings" className="flex min-w-0 flex-wrap gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="xs" className={CHIP} aria-label={`Style: ${MODE_LABELS[settings.mode]}`}>
              <SlidersHorizontal aria-hidden className="size-3" />
              {MODE_LABELS[settings.mode]}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={settings.mode} onValueChange={(v) => onChange({ mode: v as WriterMode })}>
              <DropdownMenuRadioItem value="video" className="text-xs">{MODE_LABELS.video}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="image" className="text-xs">{MODE_LABELS.image}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {localProvider ? (
          <span className="text-muted-foreground self-center text-3xs">
            Temperature and length are set in {localProvider}.
          </span>
        ) : (
          <>
            <NumberChip
              label="Temperature"
              icon={<Thermometer aria-hidden className="size-3" />}
              value={settings.temperature}
              step={0.05}
              range={TEMPERATURE_RANGE}
              onChange={(temperature) => onChange({ temperature })}
            />
            <NumberChip
              label="Max tokens"
              icon={<span aria-hidden className="text-3xs font-semibold">T</span>}
              value={settings.max_tokens}
              step={1}
              whole
              range={MAX_TOKENS_RANGE}
              onChange={(max_tokens) => onChange({ max_tokens })}
            />
          </>
        )}
      </div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center justify-between gap-2">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="text-2xs -ml-1.5 gap-1 px-1.5">
              <ChevronRight aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
              System Prompt{isDefault ? '' : ' (edited)'}
            </Button>
          </CollapsibleTrigger>
          <div className="flex items-center gap-1">
            {open && !isDefault && (
              <Button type="button" variant="ghost" size="xs" className="text-2xs" onClick={() => setSystem(defaultSystemPrompt(settings.mode))}>
                <RotateCcw aria-hidden />Reset
              </Button>
            )}
            <PromptLibraryButton type="system" value={system} onChange={useSaved} />
          </div>
        </div>
        <CollapsibleContent className="pt-1">
          <label htmlFor={systemId} className="sr-only">System Prompt</label>
          <Textarea
            id={systemId}
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            className="max-h-60 min-h-24 resize-y text-xs"
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function NumberChip({ label, icon, value, step, whole, range, onChange }: {
  label: string
  icon: ReactNode
  value: number
  step: number
  whole?: boolean
  range: { min: number; max: number }
  onChange: (value: number) => void
}) {
  const inputId = useId()
  const [draft, setDraft] = useState(String(value))
  const [invalid, setInvalid] = useState(false)
  return (
    <Popover onOpenChange={(o) => { if (o) { setDraft(String(value)); setInvalid(false) } }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs" className={CHIP} aria-label={`${label}: ${value}`}>
          {icon}
          {value}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 space-y-1.5 p-2">
        <label className="text-2xs font-medium" htmlFor={inputId}>{label}</label>
        <Input
          id={inputId}
          type="number"
          inputMode={whole ? 'numeric' : 'decimal'}
          min={range.min}
          max={range.max}
          step={step}
          value={draft}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            setDraft(e.target.value)
            const n = Number(e.target.value)
            const ok = e.target.value.trim() !== '' && Number.isFinite(n) && n >= range.min && n <= range.max && (!whole || Number.isInteger(n))
            setInvalid(!ok)
            if (ok) onChange(n)
          }}
          className="h-7 text-xs"
        />
        <p className={cn('text-3xs', invalid ? 'text-destructive' : 'text-muted-foreground')}>
          {range.min}–{range.max.toLocaleString('en-US')}
        </p>
      </PopoverContent>
    </Popover>
  )
}

function ResultField({ id, value, onChange, keep, onKeepChange }: {
  id: string
  value: string
  onChange: (value: string) => void
  keep: boolean
  onKeepChange: (keep: boolean) => void
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success('Prompt copied.')
    } catch {
      toast.error('Could not copy the prompt. Select the text and copy it instead.')
    }
  }
  // Two top-level items, so the block body's standard gap separates the row from the field.
  return (
    <>
      <BlockField label="Result" htmlFor={id}>
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="The written prompt appears here after Run Pipeline. You can edit it."
          className="min-h-20 resize-y text-xs"
        />
      </BlockField>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-2xs flex items-center gap-2">
          <Switch size="sm" checked={keep} onCheckedChange={onKeepChange} aria-label="Keep this result on the next run" />
          Keep this result on the next run
        </label>
        <Button type="button" variant="outline" size="xs" onClick={() => void copy()} disabled={!value.trim()}>
          <Copy aria-hidden />Copy
        </Button>
      </div>
    </>
  )
}

function RunStatus({ run, onRecheck }: { run: RunState; onRecheck: () => void }) {
  if (run.status === 'idle') return null
  return (
    <div role="status" aria-live="polite" className="space-y-1.5" data-testid="run-status">
      {run.status === 'running' && (
        <div className="flex items-center gap-2">
          <StatusBadge variant="info">Writing</StatusBadge>
          <span className="text-muted-foreground truncate text-3xs">Waiting for {run.provider}…</span>
        </div>
      )}
      {run.status === 'success' && (
        <div className="flex items-center gap-2">
          <StatusBadge variant="success">Done</StatusBadge>
          <span className="text-muted-foreground truncate text-3xs">{run.message}</span>
        </div>
      )}
      {run.status === 'cancelled' && <StatusBadge variant="neutral">Cancelled</StatusBadge>}
      {run.status === 'error' && (
        <AlertPanel variant="error" title={ERROR_TITLES[run.kind]}>
          <p data-testid="run-error-kind" data-kind={run.kind}>{run.message}</p>
          {run.kind === 'auth' && (
            <Button asChild variant="outline" size="xs"><Link href="/settings">Open Settings</Link></Button>
          )}
          {run.kind === 'unavailable' && (
            <Button type="button" variant="outline" size="xs" onClick={onRecheck}>
              <RefreshCw aria-hidden />Re-check
            </Button>
          )}
          {run.kind !== 'auth' && run.kind !== 'unavailable' && (
            <p className="text-muted-foreground">Fix the problem if there is one, then press Run Pipeline again.</p>
          )}
        </AlertPanel>
      )}
    </div>
  )
}
