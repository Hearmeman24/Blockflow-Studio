import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { User } from 'lucide-react'
import { MediaThumb, useThumbPlayback } from './media-thumb'

afterEach(() => vi.restoreAllMocks())

describe('MediaThumb', () => {
  it('renders an image covering the square with its label as alt text', () => {
    render(<MediaThumb kind="image" src="/outputs/a b.png" label="Zoë face.png" />)
    const img = screen.getByRole('img', { name: 'Zoë face.png' })
    expect(img).toHaveAttribute('src', '/outputs/a b.png')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img.className).toContain('object-cover')
  })

  it('renders a muted looping video poster at 0.1 s that plays on hover and focus and pauses on leave', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    const onDuration = vi.fn()
    render(<MediaThumb kind="video" src="/outputs/clip.mp4" label="clip.mp4" onDuration={onDuration} />)
    const video = screen.getByLabelText('clip.mp4') as HTMLVideoElement
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('src')).toBe('/outputs/clip.mp4#t=0.1')
    expect(video.muted).toBe(true)
    expect(video.loop).toBe(true)
    expect(video).toHaveAttribute('preload', 'metadata')

    fireEvent.mouseEnter(video)
    expect(play).toHaveBeenCalledTimes(1)
    fireEvent.mouseLeave(video)
    expect(pause).toHaveBeenCalledTimes(1)
    fireEvent.focus(video)
    expect(play).toHaveBeenCalledTimes(2)
    fireEvent.blur(video)
    expect(pause).toHaveBeenCalledTimes(2)

    Object.defineProperty(video, 'duration', { configurable: true, value: 7.5 })
    fireEvent.loadedMetadata(video)
    expect(onDuration).toHaveBeenCalledWith(7.5)
  })

  it('lets a parent own the hover play so hovering its controls keeps the video playing', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    function Tile() {
      const playback = useThumbPlayback()
      return (
        <div data-testid="tile" {...playback.containerProps}>
          <MediaThumb kind="video" src="/v.mp4" label="v.mp4" playback={playback} />
        </div>
      )
    }
    render(<Tile />)
    fireEvent.mouseEnter(screen.getByTestId('tile'))
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('shows a placeholder when there is no src: a spinner while saving, a custom icon when given', () => {
    const { rerender, container } = render(<MediaThumb kind="image" label="x" />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(container.querySelector('[data-testid="media-thumb-placeholder"]')).not.toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
    rerender(<MediaThumb kind="image" label="x" saving />)
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    rerender(<MediaThumb kind="image" label="x" placeholder={<User data-testid="user-icon" />} />)
    expect(screen.getByTestId('user-icon')).toBeInTheDocument()
  })
})
