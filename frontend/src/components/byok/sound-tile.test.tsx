/**
 * The sound tile: a square card for one audio clip with a waveform,
 * a play/pause button driving a hidden <audio>, and optional star, remove and
 * move controls. jsdom has no Web Audio, so the waveform is the placeholder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SoundTile, soundLabel } from './sound-tile'

let play: ReturnType<typeof vi.spyOn>
let pause: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('soundLabel', () => {
  it('drops the extension and keeps names without one', () => {
    expect(soundLabel('Mia line 1.wav')).toBe('Mia line 1')
    expect(soundLabel('Zoë 李.final.mp3')).toBe('Zoë 李.final')
    expect(soundLabel('no-extension')).toBe('no-extension')
    expect(soundLabel('.wav')).toBe('.wav')
  })
})

describe('SoundTile', () => {
  it('has one look for every sound: the audio accent, and no kind to choose', () => {
    const { container } = render(<SoundTile src="/a.wav" label="a.wav" />)
    expect(container.innerHTML).toContain('amber-')
    expect(container.innerHTML).not.toContain('emerald-')
  })

  it('shows the label without its extension, with the full name as the title, and a hidden audio element', () => {
    render(<SoundTile src="/outputs/c/vo1.wav" label="Mia line 1.wav" />)
    const text = screen.getByText('Mia line 1')
    expect(text).toHaveAttribute('title', 'Mia line 1.wav')
    const audio = screen.getByLabelText('Mia line 1.wav')
    expect(audio.tagName).toBe('AUDIO')
    expect(audio).toHaveAttribute('src', '/outputs/c/vo1.wav')
    expect(audio).toHaveAttribute('preload', 'none')
    expect(audio).not.toHaveAttribute('controls')
  })

  it('play toggles aria-pressed and calls play / pause on its own audio element', async () => {
    render(<SoundTile src="/outputs/c/au1.mp3" label="au1.mp3" />)
    const button = screen.getByRole('button', { name: 'Play au1.mp3' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    const audio = screen.getByLabelText('au1.mp3')
    expect(play).toHaveBeenCalledTimes(1)
    expect(play.mock.contexts[0]).toBe(audio)
    const pauseButton = screen.getByRole('button', { name: 'Pause au1.mp3' })
    expect(pauseButton).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(pauseButton)
    expect(pause.mock.contexts.at(-1)).toBe(audio)
    expect(screen.getByRole('button', { name: 'Play au1.mp3' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('starting another tile pauses the first', async () => {
    render(
      <>
        <SoundTile src="/a.mp3" label="a.mp3" />
        <SoundTile src="/b.mp3" label="b.mp3" />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Play a.mp3' }))
    await userEvent.click(screen.getByRole('button', { name: 'Play b.mp3' }))
    expect(pause.mock.contexts).toContain(screen.getByLabelText('a.mp3'))
    expect(screen.getByRole('button', { name: 'Play a.mp3' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Pause b.mp3' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('returns to Play when the clip ends', async () => {
    render(<SoundTile src="/a.mp3" label="a.mp3" />)
    await userEvent.click(screen.getByRole('button', { name: 'Play a.mp3' }))
    fireEvent.ended(screen.getByLabelText('a.mp3'))
    expect(screen.getByRole('button', { name: 'Play a.mp3' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows the placeholder waveform when decoding is unavailable', () => {
    render(<SoundTile src="/a.wav" label="a.wav" />)
    const wave = screen.getByTestId('waveform')
    expect(wave).toHaveAttribute('data-state', 'placeholder')
    expect(wave).toHaveAttribute('aria-hidden', 'true')
    expect(within(wave).getAllByTestId('waveform-bar').length).toBeGreaterThan(8)
  })

  it('without a file the play button is disabled and there is no audio element', () => {
    render(<SoundTile label="gone.wav" />)
    expect(screen.getByRole('button', { name: 'Play gone.wav' })).toBeDisabled()
    expect(screen.queryByLabelText('gone.wav')).toBeNull()
  })

  it('star, remove and move call back; move is disabled at the ends', async () => {
    const onStar = vi.fn()
    const onRemove = vi.fn()
    const onMove = vi.fn()
    const { rerender } = render(
      <SoundTile
        src="/v.wav"
        label="v.wav"
        star={{ label: 'Use v.wav as the default audio', pressed: false, onToggle: onStar }}
        onRemove={onRemove}
        onMove={onMove}
        first
        last={false}
      />,
    )
    const star = screen.getByRole('button', { name: 'Use v.wav as the default audio' })
    expect(star).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(star)
    expect(onStar).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Remove v.wav' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Move v.wav earlier' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Move v.wav later' }))
    expect(onMove).toHaveBeenCalledWith(1)

    rerender(
      <SoundTile src="/v.wav" label="v.wav" star={{ label: 'Use v.wav as the default audio', pressed: true, onToggle: onStar }} onMove={onMove} first={false} last />,
    )
    expect(screen.getByRole('button', { name: 'Use v.wav as the default audio' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Move v.wav later' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Move v.wav earlier' }))
    expect(onMove).toHaveBeenLastCalledWith(-1)
    expect(screen.queryByRole('button', { name: 'Remove v.wav' })).toBeNull()
  })

  it('the star sits with the revealed controls; the bottom row is only play and the label', () => {
    render(
      <SoundTile
        src="/v.wav"
        label="mia_okafor_take_3.wav"
        star={{ label: 'Use mia_okafor_take_3.wav as the default audio', pressed: true, onToggle: vi.fn() }}
        onRemove={vi.fn()}
      />,
    )
    const controls = screen.getByTestId('tile-controls')
    expect(within(controls).getByRole('button', { name: 'Use mia_okafor_take_3.wav as the default audio' })).toHaveAttribute('aria-pressed', 'true')
    // Hidden at rest, shown on hover, keyboard focus inside the tile, and touch.
    expect(controls.className).toContain('opacity-0')
    expect(controls.className).toContain('group-has-[:focus-visible]:opacity-100')
    expect(controls.className).toContain('pointer-coarse:opacity-100')
    const bar = screen.getByTestId('tile-bar')
    expect(within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Play mia_okafor_take_3.wav'])
    expect(within(bar).getByText('mia_okafor_take_3')).toBeInTheDocument()
  })

  it('a star alone (no remove or move) still gets the revealed controls', () => {
    render(<SoundTile src="/v.wav" label="v.wav" star={{ label: 'Use v.wav as the default audio', pressed: false, onToggle: vi.fn() }} />)
    expect(within(screen.getByTestId('tile-controls')).getByRole('button', { name: 'Use v.wav as the default audio' })).toBeInTheDocument()
  })

  it('an overlay control is a sibling of the play button, never its ancestor', () => {
    render(
      <SoundTile
        src="/a.mp3"
        label="a.mp3"
        overlay={<button type="button" aria-label="a.mp3" aria-pressed={false} />}
      />,
    )
    const select = screen.getByRole('button', { name: 'a.mp3' })
    const playButton = screen.getByRole('button', { name: 'Play a.mp3' })
    expect(select.contains(playButton)).toBe(false)
    expect(playButton.contains(select)).toBe(false)
  })
})
