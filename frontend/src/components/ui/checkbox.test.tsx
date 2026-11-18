import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Checkbox } from './checkbox'
import { Label } from './label'

describe('Checkbox', () => {
  it('is a labelled checkbox that toggles by click, label click and Space', async () => {
    const onCheckedChange = vi.fn()
    const user = userEvent.setup()
    render(
      <div>
        <Checkbox id="c" checked={false} onCheckedChange={onCheckedChange} />
        <Label htmlFor="c">Video</Label>
      </div>,
    )
    const box = screen.getByRole('checkbox', { name: 'Video' })
    expect(box).toHaveAttribute('aria-checked', 'false')
    expect(box).toHaveAttribute('data-slot', 'checkbox')
    await user.click(box)
    await user.click(screen.getByText('Video'))
    box.focus()
    await user.keyboard(' ')
    expect(onCheckedChange).toHaveBeenCalledTimes(3)
    expect(onCheckedChange).toHaveBeenLastCalledWith(true)
  })

  it('shows its checked state', () => {
    render(<Checkbox aria-label="On" checked />)
    expect(screen.getByRole('checkbox', { name: 'On' })).toHaveAttribute('aria-checked', 'true')
  })
})
