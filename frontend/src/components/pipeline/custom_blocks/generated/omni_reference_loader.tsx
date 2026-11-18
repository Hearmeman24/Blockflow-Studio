// AUTO-GENERATED. DO NOT EDIT.
// Source: custom_blocks/omni_reference_loader/frontend.block.tsx
'use client'

/**
 * Omni Reference Loader: the references for Omni Reference to Video, in three
 * sections (Video, Image, Audio). Each list follows the limit of the
 * downstream model for its kind; a kind the model does not take says so and
 * keeps its items, flagged. Files stay on this computer until a run uses them.
 *
 * Sound is one kind: a voice sample is an audio clip like any other, and the
 * prompt says how the model uses it. A voice list saved by an older version
 * in an open tab is folded into Audio, after the audio, on first mount.
 */
import { SoundLoaderSection, VisualLoaderSection } from '@/components/byok/media-loader'
import { IMAGE_SAVE_ENDPOINT, VIDEO_SAVE_ENDPOINT, useLoaderBlock, useLoaderList } from '@/components/byok/use-media-loader'
import { LEGACY_OMNI_VOICE_KEY, OMNI_LOADER_KEYS } from '@/lib/byok/loader-items'
import {
  PORT_AUDIO,
  PORT_IMAGE,
  PORT_VIDEO,
  type BlockComponentProps,
  type BlockDef,
} from '@/lib/pipeline/registry'

function OmniReferenceLoaderBlock(props: BlockComponentProps) {
  const { blockId, setOutput } = props
  const video = useLoaderList(blockId, setOutput, {
    kind: 'video', configKey: OMNI_LOADER_KEYS.video, port: 'video', saveEndpoint: VIDEO_SAVE_ENDPOINT, responseField: 'video_url',
  })
  const image = useLoaderList(blockId, setOutput, {
    kind: 'image', configKey: OMNI_LOADER_KEYS.image, port: 'image', saveEndpoint: IMAGE_SAVE_ENDPOINT, responseField: 'image_url',
  })
  const audio = useLoaderList(blockId, setOutput, {
    kind: 'audio', configKey: OMNI_LOADER_KEYS.audio, port: 'audio', saveEndpoint: VIDEO_SAVE_ENDPOINT, responseField: 'video_url',
    absorbConfigKey: LEGACY_OMNI_VOICE_KEY,
  })
  useLoaderBlock(props, [video, image, audio], 'Add at least one reference before running this block.')

  return (
    <div className="@container min-w-0" data-testid="omni-reference-loader">
      <VisualLoaderSection list={video} pickerSlug="omni_loader_video" title="Video" />
      <VisualLoaderSection list={image} pickerSlug="omni_loader_image" title="Image" />
      <SoundLoaderSection list={audio} pickerSlug="omni_loader_audio" title="Audio" />
    </div>
  )
}

export const blockDef: BlockDef = {
  type: 'omniReferenceLoader',
  label: 'Omni Reference Loader',
  description: 'Load the videos, images and audio for Omni Reference to Video. Files stay on this computer.',
  size: 'huge',
  role: 'loader',
  canStart: true,
  suggestedDownstream: ['omniReferenceToVideo'],
  inputs: [],
  outputs: [
    { name: 'video', kind: PORT_VIDEO },
    { name: 'image', kind: PORT_IMAGE },
    { name: 'audio', kind: PORT_AUDIO },
  ],
  configKeys: [OMNI_LOADER_KEYS.video, OMNI_LOADER_KEYS.image, OMNI_LOADER_KEYS.audio],
  component: OmniReferenceLoaderBlock,
}

