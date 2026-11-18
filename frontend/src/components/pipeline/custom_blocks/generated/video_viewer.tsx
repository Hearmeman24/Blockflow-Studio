// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/video_viewer/frontend.block.tsx
'use client'

import { useEffect, useMemo } from 'react'
import { AdaptiveVideoFrame } from '@/components/adaptive-media'
import {
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import { useViewerHistory } from '@/lib/use-viewer-history'
import { toDisplayUrls } from '@/lib/video-ref'
import { BlockFooter } from '@/components/pipeline/block-footer'
import { OutputCostLabel, PriceMismatchBadge, useOutputMeta } from '@/components/byok/output-cost'

function VideoViewerBlock({ blockId, inputs, registerExecute }: BlockComponentProps) {
  const { blockStates, isLooping } = usePipeline()
  // Display URLs accept both video refs (generation blocks, loaders) and bare strings.
  const videoUrls = toDisplayUrls(inputs.video)
  const ownOutputUrls = toDisplayUrls(blockStates.get(blockId)?.outputs.video)
  // Which job made each video and what it cost, from the refs (generation blocks only).
  const metaByUrl = useOutputMeta([inputs.video, blockStates.get(blockId)?.outputs.video])

  const currentUrls = videoUrls.length > 0 ? videoUrls : ownOutputUrls
  const { history: accumulatedUrls, displayUrls, selectedIndex, select: setSelectedIndex, clear } = useViewerHistory(currentUrls)
  const isStale = !isLooping && currentUrls.length === 0 && accumulatedUrls.length > 0

  const selectedVideo = useMemo(() => {
    if (displayUrls.length === 0) return ''
    const idx = Math.min(selectedIndex, displayUrls.length - 1)
    return displayUrls[idx]
  }, [displayUrls, selectedIndex])

  useEffect(() => {
    registerExecute(async (freshInputs) => {
      const urls = toDisplayUrls(freshInputs.video)
      if (!urls.length) throw new Error('No video input')
    })
  })

  if (displayUrls.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Waiting for video input…</p>
      </div>
    )
  }

  return (
    <div className={`${isStale ? 'opacity-40' : ''} transition-opacity duration-300`}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{displayUrls.length} video{displayUrls.length === 1 ? '' : 's'}</p>
        <div className="flex items-center gap-2">
          {isStale && (
            <span className="text-[10px] text-yellow-500 font-medium">Previous run</span>
          )}
          {accumulatedUrls.length > 1 && (
            <button
              type="button"
              onClick={clear}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
          <p className="text-[10px] text-muted-foreground">{Math.min(selectedIndex + 1, displayUrls.length)}/{displayUrls.length}</p>
        </div>
      </div>

      <AdaptiveVideoFrame src={`${selectedVideo}#t=0.1`} />

      {displayUrls.length > 1 && (
        <div className="overflow-y-auto max-h-[min(50vh,400px)] pr-1">
          <div className="grid grid-cols-2 gap-2">
            {displayUrls.map((url, idx) => {
              const isActive = idx === Math.min(selectedIndex, displayUrls.length - 1)
              return (
                <button
                  key={`${url}-${idx}`}
                  type="button"
                  onClick={() => setSelectedIndex(idx)}
                  className={`relative overflow-hidden rounded border text-left ${isActive ? 'border-blue-400' : 'border-border/60 hover:border-border'}`}
                  aria-label={`Select video ${idx + 1}`}
                >
                  <video
                    src={`${url}#t=0.1`}
                    muted
                    playsInline
                    preload="metadata"
                    className="w-full bg-black/30"
                    aria-label={`Video preview ${idx + 1}`}
                  >
                    <track kind="captions" />
                  </video>
                  <span className="absolute right-1 top-1 rounded bg-black/70 px-1 text-[10px] text-white">
                    {idx + 1}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <BlockFooter testId="viewer-footer">
        <span className="min-w-0 flex-1 truncate" title={selectedVideo}>{selectedVideo}</span>
        <OutputCostLabel
          meta={metaByUrl.get(selectedVideo)}
          outputsOfJob={displayUrls.filter((u) => metaByUrl.get(u)?.job_id === metaByUrl.get(selectedVideo)?.job_id).length}
        />
        <PriceMismatchBadge meta={metaByUrl.get(selectedVideo)} />
      </BlockFooter>
    </div>
  )
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

