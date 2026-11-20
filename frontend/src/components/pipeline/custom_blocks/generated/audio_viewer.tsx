// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/audio_viewer/frontend.block.tsx
'use client'

import { useMemo } from 'react'
import {
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'
import { useViewerHistory } from '@/lib/use-viewer-history'
import { BlockFooter } from '@/components/pipeline/block-footer'
import { DownloadButton } from '@/components/pipeline/download-button'
import { ShowOlderButton } from '@/components/pipeline/viewer-strip'

const PORT_AUDIO = 'audio'

function toAudioUrls(value: unknown): string[] {
  if (value == null) return []
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const v of value) out.push(...toAudioUrls(v))
    return out
  }
  return []
}

function filenameOf(url: string): string {
  try {
    const u = url.split('?')[0]
    return u.substring(u.lastIndexOf('/') + 1) || url
  } catch {
    return url
  }
}

function AudioViewerBlock({ blockId, inputs }: BlockComponentProps) {
  const currentUrls = toAudioUrls(inputs.audio)
  const {
    history: accumulated, displayUrls, selectedIndex, select: setSelectedIndex, clear, stripStart, hiddenOlder, showOlder,
  } = useViewerHistory(currentUrls)
  const selected = useMemo(() => {
    if (displayUrls.length === 0) return ''
    return displayUrls[Math.min(selectedIndex, displayUrls.length - 1)]
  }, [displayUrls, selectedIndex])

  return (
    <div>
      {displayUrls.length === 0 ? (
        <div className="rounded border border-dashed border-border/60 p-4 text-center">
          <p className="text-[10px] text-muted-foreground italic">
            Connect a block that outputs audio upstream to play it here.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded border border-border/60 p-2">
            <audio
              key={selected}
              src={selected}
              controls
              autoPlay={false}
              className="w-full"
            />
          </div>
          {displayUrls.length > 1 && (
            <div className="space-y-0.5 max-h-[180px] overflow-y-auto rounded border border-border/60 p-1">
              <ShowOlderButton hidden={hiddenOlder} onClick={showOlder} />
              {displayUrls.slice(stripStart).map((u, j) => {
                const i = stripStart + j
                return (
                  <button
                    key={u}
                    type="button"
                    onClick={() => setSelectedIndex(i)}
                    className={`w-full text-left px-1.5 py-1 rounded text-[10px] font-mono truncate transition-colors ${
                      i === selectedIndex
                        ? 'bg-primary/15 text-foreground'
                        : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground'
                    }`}
                  >
                    <span className="mr-1.5 text-muted-foreground">#{i + 1}</span>
                    {filenameOf(u)}
                  </button>
                )
              })}
            </div>
          )}
          {accumulated.length > 0 && (
            <button
              type="button"
              onClick={clear}
              className="text-[10px] text-muted-foreground hover:text-foreground underline"
            >
              clear history
            </button>
          )}
          <BlockFooter
            testId="viewer-footer"
            actions={<DownloadButton url={selected} />}
          >
            <span className="min-w-0 flex-1 truncate" title={selected}>{selected}</span>
          </BlockFooter>
        </>
      )}
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'audioViewer',
  label: 'Audio Viewer',
  description: 'View audio outputs inline and pass them downstream.',
  size: 'md',
  role: 'loader',
  canStart: false,
  inputs: [
    { name: 'audio', kind: PORT_AUDIO, required: true },
  ],
  outputs: [{ name: 'audio', kind: PORT_AUDIO }],
  forwards: [{ fromInput: 'audio', toOutput: 'audio', when: 'if_present' }],
  suggestedDownstream: [],
  configKeys: [],
  component: AudioViewerBlock,
}

