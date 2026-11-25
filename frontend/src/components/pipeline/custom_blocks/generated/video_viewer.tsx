// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/video_viewer/frontend.block.tsx
'use client'

import { useEffect } from 'react'
import {
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import { useViewerHistory } from '@/lib/use-viewer-history'
import { toDisplayUrls } from '@/lib/video-ref'
import { MediaViewer } from '@/components/pipeline/media-viewer'
import { useOutputMeta } from '@/components/byok/output-cost'

function VideoViewerBlock({ blockId, inputs, registerExecute }: BlockComponentProps) {
  const { blockStates, isLooping } = usePipeline()
  // Display URLs accept both video refs (generation blocks, loaders) and bare strings.
  const videoUrls = toDisplayUrls(inputs.video)
  const ownOutputUrls = toDisplayUrls(blockStates.get(blockId)?.outputs.video)
  // Which job made each video and what it cost, from the refs (generation blocks only).
  const metaByUrl = useOutputMeta([inputs.video, blockStates.get(blockId)?.outputs.video])

  const currentUrls = videoUrls.length > 0 ? videoUrls : ownOutputUrls
  const viewer = useViewerHistory(currentUrls)
  const isStale = !isLooping && currentUrls.length === 0 && viewer.history.length > 0

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const urls = toDisplayUrls(freshInputs.video)
      if (!urls.length) throw new Error('No video input')
    })
  })

  return <MediaViewer kind="video" viewer={viewer} metaByUrl={metaByUrl} stale={isStale} />
}

export const blockDef: BlockDef = {
  type: 'videoViewer',
  label: 'Video Viewer',
  description: 'View generated videos inline',
  size: 'lg',
  role: 'video',
  canStart: false,
  inputs: [{ name: 'video', kind: PORT_VIDEO, required: true }],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  forwards: [{ fromInput: 'video', toOutput: 'video', when: 'if_present' }],
  configKeys: [],
  component: VideoViewerBlock,
}

