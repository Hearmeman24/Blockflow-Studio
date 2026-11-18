'use client'

/**
 * The character wizard: three steps, Face and name, Looks, Audio (the last two
 * optional).
 *
 * Create mode stages everything in memory (object-URL previews, probed
 * metadata) and sends nothing until "Create character": the character is
 * created from the name and face, then the other files are uploaded one at a
 * time, then a starred audio clip other than the first is made the default
 * (the backend makes the first audio clip the default). If some uploads fail the
 * character is kept and the wizard continues in edit mode with the failed
 * files and a Retry.
 *
 * Edit mode shows the same steps for a saved character, live: every change
 * is saved at once, and Done closes.
 */
import { useCallback, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ImageUp, UserPlus, XCircle } from 'lucide-react'
import { AlertPanel } from '@/components/alert-panel'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DropTarget, REVEAL } from '@/components/byok/media-loader'
import { MediaThumb } from '@/components/byok/media-thumb'
import { kindAccent } from '@/lib/byok/kind-accent'
import { isKindFile } from '@/lib/byok/loader-items'
import { probeMedia } from '@/lib/byok/probe-media'
import { pickFiles } from '@/lib/file-picker'
import type { CharactersState } from '@/lib/characters/use-characters'
import type { Character } from '@/lib/characters/types'
import { cn } from '@/lib/utils'
import { CharacterMediaSection, errorMessage } from './character-media-section'
import { CharacterPortrait } from './character-portrait'
import { useLiveMediaSource, useStagedMedia, type MediaSource, type StagedFile } from './media-source'
import { nonBlank, useAutosaveField } from './use-autosave-field'

const STEPS = ['Face and name', 'Looks', 'Audio'] as const
const NAME_MAX = 80
const NEEDS_FACE_AND_NAME = 'Add a face and a name first'

interface Failure {
  item: StagedFile
  error: string
}

export interface CharacterWizardProps {
  mode: 'create' | 'edit'
  /** The character being edited (edit mode). */
  character?: Character
  state: CharactersState
  onClose: () => void
  /** Everything was created. */
  onCreated: (id: string) => void
  /** The character was created but some files were not: continue in edit mode. */
  onPartial: (id: string) => void
}

export function CharacterWizard({ mode, character, state, onClose, onCreated, onPartial }: CharacterWizardProps) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const staged = useStagedMedia()
  const [faceProblem, setFaceProblem] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [failures, setFailures] = useState<{ characterId: string; list: Failure[] } | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const nextHintId = useId()

  const editing = mode === 'edit' && !!character
  const busy = progress !== null
  const ready = editing || (!!staged.face && nonBlank(name))
  const dirty = !editing && (staged.hasFiles || nonBlank(name))

  const requestClose = () => {
    if (busy) return
    if (dirty) setConfirmingDiscard(true)
    else onClose()
  }
  const discard = () => {
    staged.clear()
    onClose()
  }

  const goTo = (target: number) => {
    if (target < 0 || target >= STEPS.length || busy) return
    if (target > 0 && !ready) return
    setStep(target)
  }

  // ---- create ----

  const create = async () => {
    if (!ready || busy || editing || !staged.face) return
    const face = staged.face
    setCreateError(null)
    setProgress('Creating…')
    let created: Character
    try {
      created = await state.create({ name: name.trim(), face: face.file, meta: { width: face.meta.width, height: face.meta.height } })
    } catch (err) {
      setCreateError(errorMessage(err))
      setProgress(null)
      return
    }
    const { files, starredAudioId } = staged
    const queue = [...files.image, ...files.video, ...files.audio]
    const failed: Failure[] = []
    const uploaded = new Map<string, string>()
    for (const [i, item] of queue.entries()) {
      setProgress(`Adding ${i + 1} of ${queue.length}…`)
      try {
        const { media } = await state.uploadMedia(created.id, item.file, item.kind, item.meta)
        uploaded.set(item.id, media.id)
      } catch (err) {
        failed.push({ item, error: errorMessage(err) })
      }
    }
    // The backend makes the first audio clip the default; a starred other one is set here.
    const starredMedia = starredAudioId && starredAudioId !== files.audio[0]?.id ? uploaded.get(starredAudioId) : undefined
    if (starredMedia) {
      try {
        await state.update(created.id, { default_audio_id: starredMedia })
      } catch (err) {
        toast.error(`Could not set the default audio: ${errorMessage(err)}`)
      }
    }
    setProgress(null)
    if (failed.length === 0) {
      staged.clear()
      toast.success(`Created ${created.name}`)
      onCreated(created.id)
    } else {
      setFailures({ characterId: created.id, list: failed })
      onPartial(created.id)
    }
  }

  const retryFailures = async () => {
    if (!failures || retrying) return
    setRetrying(true)
    const still: Failure[] = []
    for (const f of failures.list) {
      try {
        await state.uploadMedia(failures.characterId, f.item.file, f.item.kind, f.item.meta)
      } catch (err) {
        still.push({ item: f.item, error: errorMessage(err) })
      }
    }
    setFailures(still.length > 0 ? { characterId: failures.characterId, list: still } : null)
    setRetrying(false)
  }

  // ---- step 1: the staged face ----

  const chooseFace = async (files: File[]) => {
    if (files.length === 0) return
    const image = files.find((f) => isKindFile('image', f))
    const refused = files.filter((f) => !isKindFile('image', f))
    setFaceProblem(refused.length > 0 && !image ? `${refused[0].name} is not an image file.` : null)
    if (!image) return
    staged.setFace(image, await probeMedia(image, 'image'))
  }
  const pickFace = () => {
    void pickFiles({ slug: 'characters-image', accept: 'image/*', multiple: false, description: 'images' })
      .then((files) => chooseFace(files ?? []))
  }

  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    goTo(1)
  }

  // ---- layout ----

  const title = editing ? `Edit ${character.name}` : 'New character'

  return (
    <Dialog open onOpenChange={(open) => { if (!open) requestClose() }}>
      <DialogContent
        className="flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onOpenAutoFocus={(e) => {
          // Focus the name, not the first button.
          const field = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLInputElement>('input[aria-label="Name"]')
          if (field) {
            e.preventDefault()
            field.focus()
          }
        }}
      >
        <div className="border-b px-6 pt-5 pb-4">
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {editing ? 'Changes are saved as you make them.' : 'A face and a name are required. Looks and audio are optional.'}
          </DialogDescription>
          <Stepper step={step} reachable={(i) => i === 0 || ready} onStep={goTo} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === 0 && (
            editing
              ? <EditFaceAndName key={character.id} character={character} state={state} />
              : (
                <FaceAndName
                  face={staged.face}
                  faceProblem={faceProblem}
                  onFaceFiles={(files) => void chooseFace(files)}
                  onPickFace={pickFace}
                  name={name}
                  onName={setName}
                  onNameKey={onNameKey}
                  disabled={busy}
                />
              )
          )}
          {step === 1 && (
            editing
              ? <LiveLooks character={character} state={state} />
              : <Looks source={staged.source} faceId={staged.face?.id ?? null} />
          )}
          {step === 2 && (
            editing
              ? <LiveAudioStep character={character} state={state} />
              : <AudioStep source={staged.source} />
          )}
        </div>

        <div className="space-y-3 border-t px-6 py-4">
          {createError && (
            <div role="alert">
              <AlertPanel variant="error" icon={<XCircle aria-hidden className="size-3.5" />}>{createError}</AlertPanel>
            </div>
          )}
          {failures && failures.list.length > 0 && (
            <div role="alert">
              <AlertPanel variant="error" title="Some files were not added" icon={<XCircle aria-hidden className="size-3.5" />}>
                <ul className="space-y-0.5">
                  {failures.list.map((f) => <li key={f.item.id}>{`${f.item.label}: ${f.error}`}</li>)}
                </ul>
                <div className="pt-1">
                  <Button type="button" variant="outline" size="xs" onClick={() => void retryFailures()} disabled={retrying}>
                    {retrying ? 'Retrying…' : 'Retry'}
                  </Button>
                </div>
              </AlertPanel>
            </div>
          )}
          <div className="flex items-center gap-2">
            {!editing && (
              <Button type="button" variant="ghost" onClick={requestClose} disabled={busy}>Cancel</Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {step > 0 && (
                <Button type="button" variant="outline" onClick={() => goTo(step - 1)} disabled={busy}>Back</Button>
              )}
              {step < STEPS.length - 1 && (
                <Button
                  type="button"
                  // Step 1 of a new character: Next is the dialog's one primary.
                  variant={!editing && step === 0 ? 'default' : 'outline'}
                  aria-disabled={!ready || busy ? true : undefined}
                  aria-describedby={!ready ? nextHintId : undefined}
                  title={!ready ? NEEDS_FACE_AND_NAME : undefined}
                  onClick={() => goTo(step + 1)}
                  className={cn(!ready && 'cursor-not-allowed opacity-50')}
                >
                  Next
                </Button>
              )}
              {!ready && <span id={nextHintId} className="sr-only">{NEEDS_FACE_AND_NAME}</span>}
              {editing ? (
                <Button type="button" onClick={onClose}>Done</Button>
              ) : step > 0 && (
                <Button
                  type="button"
                  aria-disabled={busy ? true : undefined}
                  onClick={() => void create()}
                  className={cn(busy && 'cursor-progress opacity-80')}
                >
                  {progress ?? 'Create character'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>

      <AlertDialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this character?</AlertDialogTitle>
            <AlertDialogDescription>The face, name and files you added here are not saved anywhere yet.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={discard}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

// ---- stepper ----

function Stepper({ step, reachable, onStep }: { step: number; reachable: (i: number) => boolean; onStep: (i: number) => void }) {
  return (
    <ol aria-label="Steps" className="mt-4 flex items-center gap-2">
      {STEPS.map((label, i) => {
        const current = i === step
        const done = i < step
        const canGo = reachable(i)
        return (
          <li key={label} className="flex min-w-0 items-center gap-2">
            {i > 0 && <span aria-hidden className="bg-border h-px w-6 shrink-0 sm:w-10" />}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-current={current ? 'step' : undefined}
              aria-disabled={canGo ? undefined : true}
              onClick={() => onStep(i)}
              className={cn('h-8 gap-2 px-2 font-normal', !canGo && 'cursor-not-allowed opacity-50', current ? 'text-foreground' : 'text-muted-foreground')}
            >
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full text-2xs tabular-nums',
                  current ? 'bg-primary text-primary-foreground' : done ? 'bg-muted text-foreground' : 'border text-muted-foreground',
                )}
              >
                {i + 1}
              </span>
              <span className={cn('truncate', current && 'font-medium')}>{label}</span>
            </Button>
          </li>
        )
      })}
    </ol>
  )
}

function StepIntro({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 space-y-1">
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      {children && <p className="text-muted-foreground text-sm">{children}</p>}
    </div>
  )
}

// ---- step 1 ----

const FACE_COLUMN = 'w-44 shrink-0 sm:w-52'

function FaceAndName({ face, faceProblem, onFaceFiles, onPickFace, name, onName, onNameKey, disabled }: {
  face: StagedFile | null
  faceProblem: string | null
  onFaceFiles: (files: File[]) => void
  onPickFace: () => void
  name: string
  onName: (v: string) => void
  onNameKey: (e: KeyboardEvent<HTMLInputElement>) => void
  disabled: boolean
}) {
  const accent = kindAccent('image')
  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
      <div role="group" aria-label="Face photo" className={cn(FACE_COLUMN, 'flex flex-col gap-2')}>
        <DropTarget onFiles={onFaceFiles}>
          {(dragging) => face ? (
            <div className={cn('group bg-muted relative aspect-[3/4] overflow-hidden rounded-2xl shadow-lg ring-1 ring-border/60', dragging && 'ring-2 ring-ring')}>
              <MediaThumb kind="image" src={face.src} label={face.label} />
              <div aria-hidden className="from-background/70 pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t to-transparent" />
              <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={onPickFace}
                disabled={disabled}
                className={cn('absolute bottom-2 left-1/2 -translate-x-1/2 shadow-sm', REVEAL)}
              >
                <ImageUp aria-hidden />
                Change
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              onClick={onPickFace}
              disabled={disabled}
              className={cn(
                'aspect-[3/4] h-auto w-full flex-col gap-2 rounded-2xl border-2 border-dashed px-4 text-sm font-medium whitespace-normal',
                accent.tile,
                accent.add,
                dragging && accent.addDragging,
              )}
            >
              <UserPlus aria-hidden className="mb-1 size-10" strokeWidth={1.5} />
              <span>Drop a photo of the face</span>
              <span className="text-xs font-normal opacity-80">or click to choose</span>
            </Button>
          )}
        </DropTarget>
        {faceProblem && <p role="alert" className="text-destructive text-xs">{faceProblem}</p>}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:pt-6">
        <h3 className="text-2xl font-semibold tracking-tight">Who is this?</h3>
        <Input
          aria-label="Name"
          placeholder="Name"
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={onNameKey}
          disabled={disabled}
          className="h-12 text-lg md:text-lg"
        />
        <p className="text-muted-foreground text-sm">How this character is listed in your flows. You can change it later.</p>
      </div>
    </div>
  )
}

function EditFaceAndName({ character, state }: { character: Character; state: CharactersState }) {
  const { id } = character
  const { update } = state
  const saveName = useCallback((v: string) => update(id, { name: v.trim() }), [update, id])
  const name = useAutosaveField(character.name, saveName, nonBlank, 'name')
  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
      <div className={FACE_COLUMN}>
        <CharacterPortrait character={character} actions={state} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:pt-6">
        <h3 className="text-2xl font-semibold tracking-tight">Who is this?</h3>
        <Input
          aria-label="Name"
          value={name.value}
          maxLength={NAME_MAX}
          aria-invalid={name.valid ? undefined : true}
          onChange={(e) => name.change(e.target.value)}
          onBlur={name.blur}
          className="h-12 text-lg md:text-lg"
        />
        <p className="text-muted-foreground text-sm">Changes are saved as you type.</p>
      </div>
    </div>
  )
}

// ---- steps 2 and 3 ----

const LOOKS_HINT = 'Other angles, full body, outfits, short clips.'

function Looks({ source, faceId }: { source: MediaSource; faceId: string | null }) {
  return (
    <>
      <StepIntro title="Looks">{LOOKS_HINT}</StepIntro>
      <CharacterMediaSection
        source={source}
        kinds={['image', 'video']}
        title="Looks"
        addLabel="Add images or videos"
        lockedIds={faceId ? [faceId] : []}
        stars={false}
        bare
      />
    </>
  )
}

function LiveLooks({ character, state }: { character: Character; state: CharactersState }) {
  const source = useLiveMediaSource(character, state)
  return <Looks source={source} faceId={character.default_face_id} />
}

const AUDIO_HINT = 'A voice sample or any other sound. Sent to the model as audio; your prompt says how to use it.'

function AudioStep({ source }: { source: MediaSource }) {
  return (
    <>
      <StepIntro title="Audio">{AUDIO_HINT}</StepIntro>
      <CharacterMediaSection source={source} kinds={['audio']} title="Audio" addLabel="Add audio" addText="Add audio" bare />
    </>
  )
}

function LiveAudioStep({ character, state }: { character: Character; state: CharactersState }) {
  const source = useLiveMediaSource(character, state)
  return <AudioStep source={source} />
}
