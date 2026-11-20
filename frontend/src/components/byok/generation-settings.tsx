'use client'

/**
 * Generation settings as one compact row of chips, rendered generically from
 * the ledger's setting definitions: enums open a small menu, booleans toggle
 * in one click, duration is a − value + stepper, other numbers open a small
 * popover. Every chip has a tooltip with the full name and the ledger
 * description. Only icons and short labels are keyed by setting key here.
 */
import { useId, useState, type ComponentType, type ReactNode } from 'react'
import {
  AlertTriangle,
  AudioLines,
  Check,
  Dices,
  Expand,
  FileImage,
  Gauge,
  Layers,
  Minus,
  Monitor,
  Plus,
  RectangleHorizontal,
  ScanFace,
  Shield,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Users,
  Volume2,
  Wand2,
  ZoomIn,
} from 'lucide-react'
import { AlertPanel } from '@/components/alert-panel'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ChipTooltip, settingTip } from '@/components/chip-tooltip'
import { defaultParams, displayValue, reconcileParams, type ParamChange, type ParamState } from '@/lib/byok/params'
import type { ChoiceSpec, ModeSpec, SettingSpec, SettingValue } from '@/lib/byok/types'
import { cn } from '@/lib/utils'

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>

const ICONS: Record<string, Icon> = {
  duration: Timer,
  resolution: Monitor,
  aspect_ratio: RectangleHorizontal,
  generate_audio: Volume2,
  audio: Volume2,
  enable_audio: Volume2,
  keep_original_sound: AudioLines,
  keep_original_audio: AudioLines,
  nsfw_checker: Shield,
  less_restriction: ShieldOff,
  real_people: Users,
  output_format: FileImage,
  seed: Dices,
  quality: Sparkles,
  background: Layers,
  tier: Layers,
  complexity: Gauge,
  moderation: Shield,
  output_compression: Gauge,
  expand_prompt: Wand2,
  upscale_factor: ZoomIn,
  scale: ZoomIn,
  face_enhance: ScanFace,
}

/** Short chip labels for booleans; the full ledger label is in the tooltip. */
const SHORT_LABEL: Record<string, string> = {
  generate_audio: 'Audio',
  audio: 'Audio',
  enable_audio: 'Audio',
  keep_original_sound: 'Original sound',
  keep_original_audio: 'Original sound',
  nsfw_checker: 'Content filter',
  less_restriction: 'Less restriction',
  real_people: 'Real people',
  expand_prompt: 'Expand prompt',
  face_enhance: 'Face enhance',
}

const CHIP = 'h-6 gap-1 rounded-full px-2 text-2xs font-normal'

interface GenerationSettingsProps {
  spec: ModeSpec
  params: ParamState
  onChange: (next: ParamState) => void
  /** Values reset by the last model or provider switch, shown until dismissed. */
  changes?: ParamChange[]
  onDismissChanges?: () => void
  /** Text for the "not available" messages, e.g. "Seedance 2 on PiAPI". */
  where?: string
  /** A read-only item at the end of the chip row (the cost estimate). */
  trailing?: ReactNode
}

export function GenerationSettings({ spec, params, onChange, changes = [], onDismissChanges, where = 'this model', trailing }: GenerationSettingsProps) {
  const defaults = defaultParams(spec)
  const pending = reconcileParams(spec, params, where)
  const invalid = new Set(pending.changes.map((c) => c.field))
  const setSetting = (key: string, value: SettingValue) => onChange({ ...params, settings: { ...params.settings, [key]: value } })

  return (
    <div className="space-y-1.5">
        <div role="toolbar" aria-label="Settings" className="flex min-w-0 flex-wrap gap-1">
          {spec.duration && (
            <DurationChip spec={spec} value={params.duration} fallback={defaults.duration} invalid={invalid.has('duration')}
              onChange={(duration) => onChange({ ...params, duration })} />
          )}
          {spec.resolutions && (
            <ChoiceChip keyName="resolution" label="Resolution" description="Output resolution." choice={spec.resolutions}
              value={displayValue(spec, params, 'resolution') as string | null} invalid={invalid.has('resolution')}
              onChange={(resolution) => onChange({ ...params, resolution })} />
          )}
          {spec.aspect_ratios && (
            <ChoiceChip keyName="aspect_ratio" label="Aspect ratio" description="Output aspect ratio." choice={spec.aspect_ratios}
              value={displayValue(spec, params, 'aspect_ratio') as string | null} invalid={invalid.has('aspect_ratio')}
              onChange={(aspect_ratio) => onChange({ ...params, aspect_ratio })} />
          )}
          {spec.settings.map((setting) => (
            <SettingChip
              key={setting.key}
              setting={setting}
              value={displayValue(spec, params, `settings.${setting.key}`)}
              invalid={invalid.has(`settings.${setting.key}`)}
              onChange={(value) => setSetting(setting.key, value)}
            />
          ))}
          {trailing && <span className="ml-auto flex items-center">{trailing}</span>}
        </div>

      {changes.length > 0 && (
        <AlertPanel variant="warning" icon={<AlertTriangle aria-hidden className="size-3.5" />}>
          <p>{changes.map((c) => c.message).join(' ')}</p>
          {onDismissChanges && <Button type="button" variant="ghost" size="xs" onClick={onDismissChanges}>Dismiss</Button>}
        </AlertPanel>
      )}
      {pending.changes.length > 0 && (
        <AlertPanel variant="warning" icon={<AlertTriangle aria-hidden className="size-3.5" />}>
          <p>{pending.changes.map((c) => c.message).join(' ')}</p>
          <Button type="button" variant="outline" size="xs" onClick={() => onChange(pending.params)}>Reset these values</Button>
        </AlertPanel>
      )}
    </div>
  )
}

/** A chip with a tooltip carrying the full name and description. */
/** A chip with a tooltip carrying the setting's name and, when it adds something, its description. */
function WithTip({ tip, suppressed, children }: { tip: ReactNode; suppressed?: boolean; children: ReactNode }) {
  return <ChipTooltip tip={tip} suppressed={suppressed}>{children}</ChipTooltip>
}

function InvalidMark({ invalid }: { invalid: boolean }) {
  return invalid ? <AlertTriangle aria-hidden className="text-warning size-3" data-testid="chip-invalid" /> : null
}

const DEFAULT_CHOICE = '__default__'

function ChoiceChip({
  keyName,
  label,
  description,
  choice,
  value,
  invalid,
  onChange,
}: {
  keyName: string
  label: string
  description: string
  choice: ChoiceSpec | { values: Array<string | number | boolean>; default: SettingValue }
  value: SettingValue
  invalid: boolean
  onChange: (value: string | null) => void
}) {
  const Icon = ICONS[keyName] ?? SlidersHorizontal
  const shown = value === null || value === undefined ? 'Default' : String(value)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <WithTip tip={settingTip(label, description)} suppressed={menuOpen}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="xs" aria-label={`${label}: ${shown}`}
            aria-invalid={invalid || undefined}
            className={cn(CHIP, invalid && 'border-warning/70')}>
            <Icon aria-hidden className="size-3" />
            {shown}
            <InvalidMark invalid={invalid} />
          </Button>
        </DropdownMenuTrigger>
      </WithTip>
      <DropdownMenuContent align="start" className="min-w-36">
        <DropdownMenuLabel className="text-2xs">{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value === null || value === undefined ? DEFAULT_CHOICE : String(value)}
          onValueChange={(v) => onChange(v === DEFAULT_CHOICE ? null : v)}>
          {choice.default === null && <DropdownMenuRadioItem value={DEFAULT_CHOICE} className="text-xs">Default</DropdownMenuRadioItem>}
          {choice.values.map((v) => (
            <DropdownMenuRadioItem key={String(v)} value={String(v)} className="text-xs">{String(v)}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ToggleChip({ setting, value, invalid, onChange }: { setting: SettingSpec; value: SettingValue; invalid: boolean; onChange: (v: boolean) => void }) {
  const on = value === true
  const Icon = on ? Check : ICONS[setting.key] ?? SlidersHorizontal
  const short = SHORT_LABEL[setting.key] ?? setting.label
  return (
    <WithTip tip={settingTip(`${setting.label}: ${on ? 'on' : 'off'}`, setting.description)}>
      <Button
        type="button"
        size="xs"
        variant={on ? 'secondary' : 'outline'}
        aria-pressed={on}
        aria-label={`${setting.label}: ${on ? 'on' : 'off'}`}
        aria-invalid={invalid || undefined}
        onClick={() => onChange(!on)}
        className={cn(CHIP, on ? 'border border-transparent' : 'text-muted-foreground', invalid && 'border-warning/70')}
      >
        <Icon aria-hidden className="size-3" />
        {short}
        <InvalidMark invalid={invalid} />
      </Button>
    </WithTip>
  )
}

function toWholeNumber(raw: string): number | null {
  if (raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? Math.round(n) : null
}

function NumberChip({ setting, value, invalid, onChange }: { setting: SettingSpec; value: SettingValue; invalid: boolean; onChange: (v: number | null) => void }) {
  const Icon = ICONS[setting.key] ?? SlidersHorizontal
  const inputId = useId()
  const shown = typeof value === 'number' ? String(value) : setting.key === 'seed' ? 'Random' : 'Default'
  const [draft, setDraft] = useState<string>(typeof value === 'number' ? String(value) : '')
  const [popoverOpen, setPopoverOpen] = useState(false)
  const range = setting.minimum !== null && setting.maximum !== null ? `${setting.minimum}–${setting.maximum}` : null
  return (
    <Popover open={popoverOpen} onOpenChange={(open) => {
      setPopoverOpen(open)
      if (open) setDraft(typeof value === 'number' ? String(value) : '')
    }}>
      <WithTip tip={settingTip(setting.label, setting.description)} suppressed={popoverOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="xs" aria-label={`${setting.label}: ${shown}`}
            aria-invalid={invalid || undefined} className={cn(CHIP, invalid && 'border-warning/70')}>
            <Icon aria-hidden className="size-3" />
            {setting.key === 'seed' ? `Seed ${shown}` : shown}
            <InvalidMark invalid={invalid} />
          </Button>
        </PopoverTrigger>
      </WithTip>
      <PopoverContent align="start" className="w-48 space-y-1.5 p-2">
        <label className="text-2xs font-medium" htmlFor={inputId}>{setting.label}</label>
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={setting.minimum ?? undefined}
          max={setting.maximum ?? undefined}
          step={1}
          value={draft}
          placeholder={setting.key === 'seed' ? 'Random' : 'Default'}
          onChange={(e) => {
            setDraft(e.target.value)
            onChange(toWholeNumber(e.target.value))
          }}
          className="h-7 text-xs"
        />
        {range && <p className="text-muted-foreground text-3xs">{range}</p>}
      </PopoverContent>
    </Popover>
  )
}

function SettingChip({ setting, value, invalid, onChange }: { setting: SettingSpec; value: SettingValue; invalid: boolean; onChange: (v: SettingValue) => void }) {
  if (setting.type === 'bool') return <ToggleChip setting={setting} value={value} invalid={invalid} onChange={onChange} />
  if (setting.type === 'int') return <NumberChip setting={setting} value={value} invalid={invalid} onChange={onChange} />
  return (
    <ChoiceChip keyName={setting.key} label={setting.label} description={setting.description}
      choice={{ values: setting.choices, default: setting.default }} value={value} invalid={invalid}
      onChange={(v) => onChange(v === null ? null : coerceChoice(setting, v))} />
  )
}

/** Menu values are strings; give numeric and boolean choices back their type. */
function coerceChoice(setting: SettingSpec, raw: string): SettingValue {
  const match = setting.choices.find((c) => String(c) === raw)
  return match ?? raw
}

function DurationChip({
  spec,
  value,
  fallback,
  invalid,
  onChange,
}: {
  spec: ModeSpec
  value: number | null
  fallback: number | null
  invalid: boolean
  onChange: (value: number | null) => void
}) {
  const d = spec.duration!
  const auto = d.auto_value !== null && value === d.auto_value
  const current = auto ? null : (value ?? fallback ?? d.default)
  const step = (delta: number) => {
    const base = current ?? d.default
    onChange(Math.min(d.max_s, Math.max(d.min_s, base + delta)))
  }
  const tip = settingTip('Duration', `${d.min_s}–${d.max_s} seconds${d.auto_value !== null ? ', or let the model choose' : ''}`)
  return (
    <>
      <WithTip tip={tip}>
        <div role="group" aria-label={`Duration: ${auto ? 'auto' : `${current} seconds`}`}
          className={cn('border-input flex h-6 items-center rounded-full border', invalid && 'border-warning/70')}>
          <Button type="button" variant="ghost" size="icon-xs" className="rounded-full" aria-label="Shorter"
            disabled={auto || current === null || current <= d.min_s} onClick={() => step(-1)}>
            <Minus aria-hidden />
          </Button>
          <span className="flex items-center gap-1 px-0.5 text-2xs tabular-nums" data-testid="duration-value">
            <Timer aria-hidden className="size-3" />
            {auto ? 'Auto' : `${current} s`}
          </span>
          <InvalidMark invalid={invalid} />
          <Button type="button" variant="ghost" size="icon-xs" className="rounded-full" aria-label="Longer"
            disabled={auto || current === null || current >= d.max_s} onClick={() => step(1)}>
            <Plus aria-hidden />
          </Button>
        </div>
      </WithTip>
      {d.auto_value !== null && (
        <WithTip tip="Let the model choose the duration.">
          <Button type="button" size="xs" variant={auto ? 'secondary' : 'outline'} aria-pressed={auto}
            aria-label={`Let the model choose the duration: ${auto ? 'on' : 'off'}`}
            onClick={() => onChange(auto ? null : d.auto_value)}
            className={cn(CHIP, auto ? 'border border-transparent' : 'text-muted-foreground')}>
            {auto ? <Check aria-hidden className="size-3" /> : <Expand aria-hidden className="size-3" />}
            Auto
          </Button>
        </WithTip>
      )}
    </>
  )
}
