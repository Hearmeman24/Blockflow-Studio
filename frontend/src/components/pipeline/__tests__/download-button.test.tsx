/**
 * The shared Download control of the viewer blocks and the BlockFooter slot
 * that pins it above the divider.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BlockFooter } from '@/components/pipeline/block-footer'
import { DownloadButton, downloadFileName } from '@/components/pipeline/download-button'

describe('downloadFileName', () => {
  it.each([
    ['/outputs/cat.png', 'cat.png'],
    ['/outputs/cat.png?x=1#t=0.1', 'cat.png'],
    ['/outputs/my%20caf%C3%A9.png', 'my café.png'],
    ['https://cdn.example.com/a/b/clip.mp4?sig=abc', 'clip.mp4'],
    ['/outputs/bad%ZZ.png', 'bad%ZZ.png'],
    ['/outputs/', 'download'],
    ['https://cdn.example.com', 'download'],
    ['', 'download'],
  ])('%s -> %s', (url, name) => {
    expect(downloadFileName(url)).toBe(name)
  })
})

describe('DownloadButton', () => {
  it('is a real link with a file name and an accessible name, no new tab for a same-origin file', () => {
    render(<DownloadButton url="/outputs/cat.png?v=2" />)
    const link = screen.getByRole('link', { name: 'Download cat.png' })
    expect(link).toHaveAttribute('href', '/outputs/cat.png?v=2')
    expect(link).toHaveAttribute('download', 'cat.png')
    expect(link).not.toHaveAttribute('target')
    expect(link).toHaveTextContent('Download')
  })

  it('treats the app origin and blob URLs as same-origin', () => {
    const { rerender } = render(<DownloadButton url={`${window.location.origin}/outputs/a.png`} />)
    expect(screen.getByRole('link')).not.toHaveAttribute('target')
    rerender(<DownloadButton url="blob:http://localhost/abc" />)
    expect(screen.getByRole('link')).not.toHaveAttribute('target')
  })

  it('has an icon-only variant: same link and name, no visible text, the URL as its tooltip', () => {
    render(<DownloadButton url="/outputs/cat.png" iconOnly />)
    const link = screen.getByRole('link', { name: 'Download cat.png' })
    expect(link).toHaveAttribute('href', '/outputs/cat.png')
    expect(link).toHaveAttribute('download', 'cat.png')
    expect(link).toHaveAttribute('title', '/outputs/cat.png')
    expect(link.textContent).toBe('')
    expect(link.querySelector('svg')).not.toBeNull()
  })

  it('opens another origin in a new tab, so the app tab is never navigated away', () => {
    render(<DownloadButton url="https://tmpfiles.org/dl/1/clip.mp4" />)
    const link = screen.getByRole('link', { name: 'Download clip.mp4' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

describe('BlockFooter actions slot', () => {
  it('renders the actions above the divider, inside the footer', () => {
    const { container } = render(<BlockFooter actions={<button type="button">Act</button>}>line</BlockFooter>)
    const footer = container.querySelector('[data-slot="block-footer"]')!
    const action = screen.getByRole('button', { name: 'Act' })
    const separator = footer.querySelector('[data-slot="separator"]')!
    expect(footer).toContainElement(action as HTMLElement)
    expect(action.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders nothing extra without actions', () => {
    const { container } = render(<BlockFooter>line</BlockFooter>)
    const footer = container.querySelector('[data-slot="block-footer"]')!
    expect(footer.children).toHaveLength(2)
    expect(footer.firstElementChild).toHaveAttribute('data-slot', 'separator')
  })
})
