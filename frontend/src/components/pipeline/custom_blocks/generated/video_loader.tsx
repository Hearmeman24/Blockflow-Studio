// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/video_loader/frontend.block.tsx
'use client'

/**
 * Video Loader: one or more videos, in order. Videos are saved to the local
 * output folder; nothing is uploaded on load. The generation service uploads
 * the local file to the provider when a run needs it.
 */
import { VisualLoaderSection } from '@/components/byok/media-loader'
import { VIDEO_SAVE_ENDPOINT, useLoaderBlock, useLoaderList } from '@/components/byok/use-media-loader'
import { LOADER_CONFIG_KEY, legacyVideoItems, type LoaderItem } from '@/lib/byok/loader-items'
import {
  PORT_VIDEO,
  type BlockDef,
  type BlockComponentProps,
} from '@/lib/pipeline/registry'

/** The single-video keys this block used before multi-video (`local_url`, `remote_url`, `uploaded_video_url`). */
function legacyItems(blockId: string): LoaderItem[] {
  const config: Record<string, unknown> = {}
  for (const key of ['local_url', 'remote_url', 'uploaded_video_url']) {
    try {
      const raw = sessionStorage.getItem(`block_${blockId}_${key}`)
      if (raw) config[key] = JSON.parse(raw)
    } catch {
      // unreadable legacy value: ignore it
    }
  }
  return legacyVideoItems(config)
}

function VideoLoaderBlock(props: BlockComponentProps) {
  const list = useLoaderList(props.blockId, props.setOutput, {
    kind: 'video',
    configKey: LOADER_CONFIG_KEY,
    port: 'video',
    saveEndpoint: VIDEO_SAVE_ENDPOINT,
    responseField: 'video_url',
    legacyItems: () => legacyItems(props.blockId),
  })
  useLoaderBlock(props, [list], 'Add at least one video before running this block.')
  return <VisualLoaderSection list={list} pickerSlug="video_loader" />
}

export const blockDef: BlockDef = {
  type: 'videoLoader',
  label: 'Video Loader',
  description: 'Load videos from your computer, in order. Files stay on this computer.',
  suggestedDownstream: ['videoViewer', 'videoFx', 'videoStitcher'],
  size: 'md',
  role: 'loader',
  canStart: true,
  inputs: [],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  configKeys: [LOADER_CONFIG_KEY],
  component: VideoLoaderBlock,
}

