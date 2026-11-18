'use client'

/**
 * The editor's large 3:4 portrait: the default face. Without one it is a
 * dashed "Drop a face" tile (a drop target that also opens the picker). With
 * one, dropping an image or "Change face" adds it and makes it the face. The
 * file is uploaded as one of the character's images; the backend makes the
 * first image the face, otherwise the new image is PATCHed in as the face.
 */
import { useState } from 'react'
import { ImageUp, Loader2, UserPlus, XCircle } from 'lucide-react'
import { AlertPanel } from '@/components/alert-panel'
import { DropTarget, REVEAL } from '@/components/byok/media-loader'
import { MediaThumb } from '@/components/byok/media-thumb'
import { Button } from '@/components/ui/button'
import { kindAccent } from '@/lib/byok/kind-accent'
import { isKindFile } from '@/lib/byok/loader-items'
import { probeMedia } from '@/lib/byok/probe-media'
import { defaultFace } from '@/lib/characters/use-characters'
import type { Character } from '@/lib/characters/types'
import { pickFiles } from '@/lib/file-picker'
import { cn } from '@/lib/utils'
import { ACCEPT, ARTICLE, errorMessage } from './character-media-section'
import type { CharacterMediaActions } from './media-source'

export function CharacterPortrait({ character, actions }: { character: Character; actions: CharacterMediaActions }) {
  const face = defaultFace(character)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const accent = kindAccent('image')

  const setFaceFrom = async (files: File[]) => {
    if (files.length === 0) return
    const image = files.find((f) => isKindFile('image', f))
    setProblems(files.filter((f) => !isKindFile('image', f)).map((f) => `${f.name} is not ${ARTICLE.image} file.`))
    if (!image) return
    setBusy(true)
    try {
      const meta = await probeMedia(image, 'image')
      const { media, character: saved } = await actions.uploadMedia(character.id, image, 'image', meta)
      if (saved.default_face_id !== media.id) await actions.update(character.id, { default_face_id: media.id })
    } catch (err) {
      setProblems((prev) => [...prev, `${image.name}: ${errorMessage(err)}`])
    } finally {
      setBusy(false)
    }
  }

  const pick = () => {
    void pickFiles({ slug: 'characters-image', accept: ACCEPT.image, multiple: false, description: 'images' })
      .then((files) => setFaceFrom(files ?? []))
  }

  return (
    <div role="group" aria-label="Face" className="flex min-w-0 flex-col gap-2">
      <DropTarget onFiles={(files) => void setFaceFrom(files)} className="min-w-0">
        {(dragging) => face ? (
          <div
            className={cn(
              'group bg-muted relative aspect-[3/4] overflow-hidden rounded-2xl shadow-lg ring-1 ring-border/60',
              'transition-shadow motion-reduce:transition-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              dragging && 'ring-2 ring-ring',
            )}
          >
            <MediaThumb kind="image" src={face.local} label={face.label} />
            <div aria-hidden className="from-background/70 pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t to-transparent" />
            {(busy || dragging) && (
              <div className="bg-background/60 text-foreground absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs font-medium">
                {busy
                  ? <Loader2 aria-hidden className="size-6 animate-spin motion-reduce:animate-none" />
                  : <ImageUp aria-hidden className="size-6" />}
                {busy ? 'Saving' : 'Drop to make it the face'}
              </div>
            )}
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={pick}
              disabled={busy}
              className={cn('absolute bottom-2 left-1/2 -translate-x-1/2 shadow-sm', REVEAL)}
            >
              <ImageUp aria-hidden />
              Change face
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            onClick={pick}
            disabled={busy}
            className={cn(
              'aspect-[3/4] h-auto w-full flex-col gap-3 rounded-2xl border-2 border-dashed text-sm font-medium whitespace-normal',
              accent.tile,
              accent.add,
              dragging && accent.addDragging,
            )}
          >
            {busy
              ? <Loader2 aria-hidden className="size-8 animate-spin motion-reduce:animate-none" />
              : <UserPlus aria-hidden className="size-9" strokeWidth={1.5} />}
            Drop a face
          </Button>
        )}
      </DropTarget>

      {problems.length > 0 && (
        <div role="alert">
          <AlertPanel variant="error" icon={<XCircle aria-hidden className="size-3.5" />}>
            <ul className="space-y-0.5">
              {problems.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
            <div className="pt-0.5">
              <Button type="button" variant="ghost" size="xs" onClick={() => setProblems([])}>Dismiss</Button>
            </div>
          </AlertPanel>
        </div>
      )}
    </div>
  )
}
