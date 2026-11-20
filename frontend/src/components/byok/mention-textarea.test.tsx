/**
 * MentionTextarea: the prompt textarea with the attached references' mentions
 * coloured by kind. The textarea stays the real control; a layer that only
 * repeats its text in colour sits over it and never takes input.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState } from 'react'
import { kindAccent } from '@/lib/byok/kind-accent'
import type { MentionTarget } from '@/lib/byok/mentions'
import { MentionTextarea } from './mention-textarea'

const MENTIONS: MentionTarget[] = [
  { text: 'Image1', kind: 'image' },
  { text: 'Video1', kind: 'video' },
  { text: '@sound_1', kind: 'audio' },
]

function Controlled({ initial = '', mentions = MENTIONS, onValue }: { initial?: string; mentions?: MentionTarget[]; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <label htmlFor="p">Prompt</label>
      <MentionTextarea
        id="p"
        value={value}
        mentions={mentions}
        maxLength={500}
        placeholder="Describe what to generate"
        onChange={(e) => { setValue(e.target.value); onValue?.(e.target.value) }}
      />
    </>
  )
}

const layer = () => screen.getByTestId('mention-highlight')
/** The coloured parts of the layer, as [text, kind]. */
const coloured = () => Array.from(layer().querySelectorAll('[data-mention-kind]')).map((el) => [el.textContent, el.getAttribute('data-mention-kind')])

describe('MentionTextarea', () => {
  it('keeps the textarea as the labelled control with its value, limit and placeholder', () => {
    render(<Controlled initial="swap Video1 with Image1" />)
    const box = screen.getByRole('textbox', { name: 'Prompt' })
    expect(box.tagName).toBe('TEXTAREA')
    expect(box).toHaveValue('swap Video1 with Image1')
    expect(box).toHaveAttribute('maxlength', '500')
    expect(box).toHaveAttribute('placeholder', 'Describe what to generate')
    // Its own glyphs are transparent; the caret keeps the text colour.
    expect(box.className).toMatch(/\btext-transparent\b/)
    expect(box.className).toMatch(/\bcaret-foreground\b/)
  })

  it('repeats the text in a hidden layer, colouring each attached mention by kind', () => {
    render(<Controlled initial="swap Video1 with Image1, sing @sound_1, not Image3 or Image10" />)
    expect(layer()).toHaveAttribute('aria-hidden', 'true')
    expect(layer().textContent).toBe('swap Video1 with Image1, sing @sound_1, not Image3 or Image10')
    expect(coloured()).toEqual([['Video1', 'video'], ['Image1', 'image'], ['@sound_1', 'audio']])
    const spans = layer().querySelectorAll('[data-mention-kind]')
    expect(spans[0].className).toBe(kindAccent('video').mention)
    expect(spans[1].className).toBe(kindAccent('image').mention)
    expect(spans[2].className).toBe(kindAccent('audio').mention)
  })

  it('the layer takes no pointer input and is not read by screen readers', () => {
    render(<Controlled initial="Image1" />)
    expect(layer().className).toMatch(/\bpointer-events-none\b/)
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    // The accessible text is the textarea's value, not the layer.
    expect(layer().closest('[aria-hidden="true"]')).toBe(layer())
    expect(layer().querySelector('[tabindex], button, a, input, textarea')).toBeNull()
  })

  it('updates the colours while the user types, including a mention typed by hand', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(<Controlled onValue={onValue} />)
    const box = screen.getByRole('textbox', { name: 'Prompt' })
    await user.type(box, 'a video of the character from Image')
    expect(coloured()).toEqual([])
    await user.type(box, '1')
    expect(box).toHaveValue('a video of the character from Image1')
    expect(coloured()).toEqual([['Image1', 'image']])
    await user.type(box, '0')
    expect(coloured()).toEqual([])
    expect(onValue).toHaveBeenLastCalledWith('a video of the character from Image10')
  })

  it('typing in the middle keeps the text and the caret where the user put them', async () => {
    const user = userEvent.setup()
    render(<Controlled initial="from Image1 to Video1" />)
    const box = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement
    box.focus()
    box.setSelectionRange(5, 5)
    await user.keyboard('the ')
    expect(box).toHaveValue('from the Image1 to Video1')
    expect(box.selectionStart).toBe(9)
    expect(coloured()).toEqual([['Image1', 'image'], ['Video1', 'video']])
  })

  it('colours nothing when no reference is attached', () => {
    render(<Controlled initial="Image1 and Video1" mentions={[]} />)
    expect(coloured()).toEqual([])
    expect(layer().textContent).toBe('Image1 and Video1')
  })

  it('keeps a trailing new line visible in the layer so its height matches the textarea', () => {
    render(<Controlled initial={'line one\n'} />)
    expect(layer().textContent).toBe('line one\n ')
  })

  it('follows the textarea scroll position', () => {
    render(<Controlled initial={'Image1\n'.repeat(40)} />)
    const box = screen.getByRole('textbox', { name: 'Prompt' })
    box.scrollTop = 120
    box.scrollLeft = 3
    fireEvent.scroll(box)
    expect(layer().scrollTop).toBe(120)
    expect(layer().scrollLeft).toBe(3)
  })

  it('forwards the ref to the textarea and dims the layer when disabled', () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(<MentionTextarea ref={ref} aria-label="Prompt" value="Image1" mentions={MENTIONS} onChange={() => undefined} disabled />)
    expect(ref.current).toBe(screen.getByRole('textbox', { name: 'Prompt' }))
    expect(ref.current).toBeDisabled()
    expect(layer().className).toMatch(/\bopacity-50\b/)
  })
})
