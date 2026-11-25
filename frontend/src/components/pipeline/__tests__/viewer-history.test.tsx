/**
 * Image, Video and Audio Viewer keep one history of the outputs they were
 * shown: new outputs are appended, and Clear empties it and hides the current
 * output until a new one arrives.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import '@/components/pipeline/custom_blocks/_register'
import { blockDef as imageViewer } from '@/components/pipeline/custom_blocks/generated/image_viewer'
import { blockDef as videoViewer } from '@/components/pipeline/custom_blocks/generated/video_viewer'
import { blockDef as audioViewer } from '@/components/pipeline/custom_blocks/generated/audio_viewer'
import { PipelineProvider } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { blockProps } from '@/test-utils/byok-harness'

let tab = 0
beforeEach(() => sessionStorage.clear())

function mount(def: typeof imageViewer, port: string, first: string[]) {
  const tabId = `vh-${++tab}`
  const wrap = (children: ReactNode) => (
    <PipelineTabsProvider><PipelineProvider tabId={tabId}>{children}</PipelineProvider></PipelineTabsProvider>
  )
  const props = blockProps(`viewer-${tab}`, { [port]: first })
  const Comp = def.component
  const view = render(wrap(<Comp {...props} />))
  // A new array each time, as the pipeline passes on every render.
  const show = (urls: string[]) => view.rerender(wrap(<Comp {...props} inputs={{ [port]: [...urls] }} />))
  return { show }
}

const cases = [
  { name: 'Image Viewer', def: imageViewer, port: 'image', ext: 'png', clear: 'Clear', empty: 'Waiting for image input…' },
  { name: 'Video Viewer', def: videoViewer, port: 'video', ext: 'mp4', clear: 'Clear', empty: 'Waiting for video input…' },
] as const

describe.each(cases)('$name history', ({ def, port, ext, clear, empty }) => {
  const url = (n: string) => `/outputs/${n}.${ext}`
  /** How many outputs the viewer holds: the "n / N" counter, which a single output does not show. */
  const count = () => screen.queryByTestId('viewer-counter')?.textContent?.split(' / ')[1] ?? (screen.queryByTestId('media-frame') ? '1' : '0')
  /** The output the Download link offers, by its path (the link's tooltip). */
  const offered = () => screen.getByRole('link', { name: /^Download / }).getAttribute('title')

  it('appends each new output', () => {
    const { show } = mount(def, port, [url('a')])
    expect(count()).toBe('1')
    show([url('b')])
    expect(count()).toBe('2')
    expect(offered()).toBe(url('b'))
  })

  it('Clear hides the current output until a new one arrives', () => {
    const { show } = mount(def, port, [url('a')])
    show([url('b')])
    fireEvent.click(screen.getByRole('button', { name: clear }))
    expect(screen.getByText(empty)).toBeInTheDocument()
    show([url('b')])
    show([url('b')])
    expect(screen.getByText(empty)).toBeInTheDocument()
    show([url('c')])
    expect(count()).toBe('1')
    expect(offered()).toBe(url('c'))
  })
})

describe('Audio Viewer history', () => {
  const url = (n: string) => `/outputs/${n}.mp3`
  const listed = () => screen.queryAllByRole('button').filter((b) => /^#\d/.test(b.textContent ?? '')).map((b) => b.textContent)

  it('appends each new output', () => {
    const { show } = mount(audioViewer, 'audio', [url('a')])
    show([url('b')])
    expect(listed()).toEqual(['#1a.mp3', '#2b.mp3'])
  })

  it('clear history hides the current output until a new one arrives', () => {
    const { show } = mount(audioViewer, 'audio', [url('a')])
    show([url('b')])
    fireEvent.click(screen.getByRole('button', { name: 'clear history' }))
    expect(screen.getByText('Connect a block that outputs audio upstream to play it here.')).toBeInTheDocument()
    show([url('b')])
    expect(screen.getByText('Connect a block that outputs audio upstream to play it here.')).toBeInTheDocument()
    show([url('c')])
    // The selected file is named in the footer line (the old standalone file-name line is gone).
    expect(screen.getByTestId('viewer-footer')).toHaveTextContent('/outputs/c.mp3')
    expect(listed()).toEqual([])
  })
})
