// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/upload_image_to_tmpfiles/frontend.block.tsx
'use client'

/**
 * Image Loader. The block type and slug keep their historical names
 * (`uploadImageToTmpfiles`, `upload_image_to_tmpfiles`) so saved flows keep
 * working; nothing is uploaded to tmpfiles on load. Images are saved to the
 * local output folder and the generation service uploads them to the
 * provider when a run needs them.
 */
import { useCallback, useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { AlertPanel } from '@/components/alert-panel'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { VisualLoaderSection } from '@/components/byok/media-loader'
import { IMAGE_SAVE_ENDPOINT, useLoaderBlock, useLoaderList } from '@/components/byok/use-media-loader'
import { LOADER_CONFIG_KEY, legacyImageItems, type LoaderItem } from '@/lib/byok/loader-items'
import {
  PORT_IMAGE,
  PORT_TEXT,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

// Visually-lossless ceiling. Generation models never use more than this;
// anything beyond is wasted bandwidth and trips proxy body limits.
const MAX_EDGE = 2048
const SIZE_THRESHOLD_BYTES = 3 * 1024 * 1024 // 3 MB — below this the file is kept as-is

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number | undefined,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality })
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      type,
      quality,
    )
  })
}

/**
 * Resize/re-encode oversized images before saving. Preserves PNG (lossless);
 * everything else goes to JPEG q=0.95 (visually lossless). Returns the
 * original file unchanged when it is already small enough. The size and
 * dimension checks run on the file this returns, which is the file saved.
 */
async function prepareImageForUpload(file: File): Promise<File> {
  if (file.size <= SIZE_THRESHOLD_BYTES || typeof createImageBitmap !== 'function') return file

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }

  const { width, height } = bitmap
  const longest = Math.max(width, height)
  const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))

  const isPng = file.type === 'image/png'
  const outputType = isPng ? 'image/png' : 'image/jpeg'
  const quality = isPng ? undefined : 0.95

  let canvas: HTMLCanvasElement | OffscreenCanvas
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(targetW, targetH)
  } else {
    const c = document.createElement('canvas')
    c.width = targetW
    c.height = targetH
    canvas = c
  }
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx) {
    bitmap.close?.()
    return file
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, targetW, targetH)
  bitmap.close?.()

  let blob: Blob
  try {
    blob = await canvasToBlob(canvas, outputType, quality)
  } catch {
    return file
  }
  if (blob.size >= file.size) return file

  const stem = file.name.replace(/\.[^.]+$/, '') || 'image'
  const ext = isPng ? 'png' : 'jpg'
  return new File([blob], `${stem}.${ext}`, {
    type: outputType,
    lastModified: file.lastModified,
  })
}

function readSession(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

/** Items from the keys this block used before the item list (`uploads_v2`, and the gallery tab). */
function legacyItems(blockId: string): LoaderItem[] {
  const items = legacyImageItems(readSession(`block_${blockId}_uploads_v2`))
  const gallery = readSession(`block_${blockId}_gallery_url`)
  if (readSession(`block_${blockId}_tab`) === 'gallery' && typeof gallery === 'string' && gallery.startsWith('/outputs/')) {
    return [{ id: 'legacy-gallery-0', label: gallery.split('/').pop() || gallery, local: gallery, status: 'ready' }]
  }
  return items
}

const GALLERY_PAGE_SIZE = 24

interface GalleryImage { url: string; name: string; created_at: number }

/** Recent generated images (GET /api/images). Choosing one adds it to the list. */
function PastGenerations({ onAdd }: { onAdd: (local: string) => void }) {
  const [page, setPage] = useState(0)
  const [images, setImages] = useState<GalleryImage[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback((p: number) => {
    setLoading(true)
    setError('')
    fetch(`/api/images?limit=${GALLERY_PAGE_SIZE}&offset=${p * GALLERY_PAGE_SIZE}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) throw new Error(d.error || 'Failed to load images')
        setImages(d.images || [])
        setTotal(d.total || 0)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(page) }, [page, load])

  const totalPages = Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE))

  if (error) {
    return (
      <AlertPanel variant="error" title="Could not load past generations">
        <p>{error}</p>
        <Button type="button" variant="outline" size="xs" onClick={() => load(page)}>Retry</Button>
      </AlertPanel>
    )
  }
  if (loading && images.length === 0) {
    return (
      <div className="grid grid-cols-4 gap-1.5" aria-busy="true" aria-label="Loading past generations">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="aspect-square" />)}
      </div>
    )
  }
  if (images.length === 0) {
    return <EmptyState className="py-8" title="No generated images yet" description="Run a generation, then add its image here." />
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
        {images.map((img) => (
          <Button
            key={img.url}
            type="button"
            variant="ghost"
            className="h-auto overflow-hidden rounded-lg p-0"
            aria-label={`Add ${img.name}`}
            title={img.name}
            onClick={() => onAdd(img.url)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.url} alt="" loading="lazy" className="aspect-square w-full object-cover" />
          </Button>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <Button type="button" variant="outline" size="xs" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Prev
          </Button>
          <span className="text-muted-foreground text-3xs">Page {page + 1} / {totalPages}</span>
          <Button type="button" variant="outline" size="xs" disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

function PastGenerationsButton({ onAdd }: { onAdd: (local: string) => boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-xs" aria-label="Add from past generations">
          <History aria-hidden />
          Past
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add from past generations</DialogTitle>
          <DialogDescription>Choose an image you generated earlier.</DialogDescription>
        </DialogHeader>
        {open && <PastGenerations onAdd={(local) => { if (onAdd(local)) setOpen(false) }} />}
      </DialogContent>
    </Dialog>
  )
}

function ImageLoaderBlock(props: BlockComponentProps) {
  const list = useLoaderList(props.blockId, props.setOutput, {
    kind: 'image',
    configKey: LOADER_CONFIG_KEY,
    port: 'image',
    saveEndpoint: IMAGE_SAVE_ENDPOINT,
    responseField: 'image_url',
    legacyItems: () => legacyItems(props.blockId),
    prepare: prepareImageForUpload,
    emitSingleAsObject: true,
  })
  useLoaderBlock(props, [list], 'Add at least one image before running this block.')
  return (
    <VisualLoaderSection
      list={list}
      pickerSlug="upload_image_to_tmpfiles"
      secondaryAction={<PastGenerationsButton onAdd={list.addSaved} />}
    />
  )
}

export const blockDef: BlockDef = {
  type: 'uploadImageToTmpfiles',
  label: 'Image Loader',
  description: 'Load images from your computer or past generations, in order. Files stay on this computer.',
  size: 'md',
  role: 'loader',
  canStart: true,
  suggestedDownstream: ['imageToImage', 'imageToVideo', 'imageViewer'],
  inputs: [{ name: 'text', kind: PORT_TEXT, required: false }],
  outputs: [
    { name: 'image', kind: PORT_IMAGE },
    { name: 'text', kind: PORT_TEXT },
  ],
  forwards: [{ fromInput: 'text', toOutput: 'text', when: 'if_present' }],
  configKeys: [LOADER_CONFIG_KEY],
  component: ImageLoaderBlock,
}

