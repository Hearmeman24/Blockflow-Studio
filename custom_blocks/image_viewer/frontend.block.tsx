'use client'

import { useEffect } from 'react'
import {
  PORT_IMAGE,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import { useViewerHistory } from '@/lib/use-viewer-history'
import { toDisplayUrls } from '@/lib/image-ref'
import { MediaViewer } from '@/components/pipeline/media-viewer'
import { useOutputMeta } from '@/components/byok/output-cost'

function toImageUrls(value: unknown): string[] {
  // Browser display — local /outputs URLs are served by FastAPI, so prefer
  // those over the tmpfiles URL (avoids a third-party hop just to render).
  return toDisplayUrls(value)
}

function ImageViewerBlock({ blockId, inputs, registerExecute }: BlockComponentProps) {
  const { blockStates, isLooping } = usePipeline()

  const imageUrls = toImageUrls(inputs.image)
  const ownOutputUrls = toImageUrls(blockStates.get(blockId)?.outputs.image)
  // Which job made each image and what it cost, from the refs (generation blocks only).
  const metaByUrl = useOutputMeta([inputs.image, blockStates.get(blockId)?.outputs.image])

  const currentUrls = imageUrls.length > 0 ? imageUrls : ownOutputUrls
  const viewer = useViewerHistory(currentUrls)
  const isStale = !isLooping && currentUrls.length === 0 && viewer.history.length > 0

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const urls = toImageUrls(freshInputs.image)
      if (!urls.length) throw new Error('No image input')
    })
  })

  return <MediaViewer kind="image" viewer={viewer} metaByUrl={metaByUrl} stale={isStale} />
}

export const blockDef: BlockDef = {
  type: 'imageViewer',
  label: 'Image Viewer',
  description: 'View image outputs inline',
  size: 'lg',
  role: 'image',
  canStart: false,
  suggestedUpstream: ['uploadImageToTmpfiles'],
  inputs: [
    { name: 'image', kind: PORT_IMAGE, required: false },
  ],
  outputs: [{ name: 'image', kind: PORT_IMAGE }],
  forwards: [{ fromInput: 'image', toOutput: 'image', when: 'if_present' }],
  configKeys: [],
  component: ImageViewerBlock,
}
