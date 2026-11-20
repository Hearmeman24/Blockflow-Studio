/** Image, Video and Audio Viewer offer a Download link for the selected item, above the footer divider. */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SWRConfig } from 'swr'
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

function mount(def: typeof imageViewer, port: string, urls: string[]) {
  const Comp = def.component
  const tabId = `vd-${++tab}`
  const wrap = (children: ReactNode) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider><PipelineProvider tabId={tabId}>{children}</PipelineProvider></PipelineTabsProvider>
    </SWRConfig>
  )
  const props = blockProps(`vd-block-${tab}`, { [port]: urls })
  const view = render(wrap(<Comp {...props} />))
  return { view, show: (next: string[]) => view.rerender(wrap(<Comp {...props} inputs={{ [port]: [...next] }} />)) }
}

const cases = [
  { name: 'Image Viewer', def: imageViewer, port: 'image', ext: 'png', select: 'Select image 1' },
  { name: 'Video Viewer', def: videoViewer, port: 'video', ext: 'mp4', select: 'Select video 1' },
] as const

describe.each(cases)('$name download', ({ def, port, ext, select }) => {
  const url = (n: string) => `/outputs/${n}.${ext}`

  it('offers the selected item above the footer divider, without a #t fragment', () => {
    mount(def, port, [url('a'), url('b')])
    const link = screen.getByRole('link', { name: `Download b.${ext}` })
    expect(link).toHaveAttribute('href', url('b'))
    expect(link).toHaveAttribute('download', `b.${ext}`)
    expect(link.getAttribute('href')).not.toContain('#')
    const footer = screen.getByTestId('viewer-footer').closest('[data-slot="block-footer"]')!
    expect(footer).toContainElement(link)
    const separator = footer.querySelector('[data-slot="separator"]')!
    expect(link.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('follows the selection', () => {
    mount(def, port, [url('a'), url('b')])
    fireEvent.click(screen.getByRole('button', { name: select }))
    expect(screen.getByRole('link', { name: `Download a.${ext}` })).toHaveAttribute('href', url('a'))
  })

  it('is not shown when the viewer is empty', () => {
    mount(def, port, [])
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('is still shown for a previous-run item', () => {
    const { show } = mount(def, port, [url('a')])
    show([])
    expect(screen.getByText('Previous run')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: `Download a.${ext}` })).toBeInTheDocument()
  })
})

describe('Audio Viewer download', () => {
  it('shows the Download button above a footer carrying the file name, and drops the old text link', () => {
    mount(audioViewer, 'audio', ['/outputs/a.wav', '/outputs/b.wav'])
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAccessibleName('Download b.wav')
    expect(links[0]).toHaveAttribute('href', '/outputs/b.wav')
    expect(screen.queryByText('download')).toBeNull()
    const footer = links[0].closest('[data-slot="block-footer"]')!
    expect(footer).toHaveTextContent('/outputs/b.wav')
  })

  it('follows the selection and is absent when empty', () => {
    const { view } = mount(audioViewer, 'audio', ['/outputs/a.wav', '/outputs/b.wav'])
    fireEvent.click(screen.getByRole('button', { name: /a\.wav/ }))
    expect(screen.getByRole('link', { name: 'Download a.wav' })).toBeInTheDocument()
    view.unmount()
    mount(audioViewer, 'audio', [])
    expect(screen.queryByRole('link')).toBeNull()
  })
})
