/**
 * The run favourite toggle shared by the tile, the viewer and the character
 * gallery: optimistic, one request at a time, rolled back with a toast on failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/pipeline/tabs-context', () => ({ usePipelineTabs: () => ({ restoreFlowSnapshot: vi.fn() }) }))
const toggleRunFavorite = vi.fn()
vi.mock('@/lib/api', () => ({ toggleRunFavorite: (...a: unknown[]) => toggleRunFavorite(...a) }))
const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }))

import { FavoriteRunButton, useRunFavorite } from './run-actions'
import type { RunEntry } from '@/lib/types'

const RUN = { id: 'r1', name: 'Run 1', favorited: false } as RunEntry

function Star({ run = RUN, onToggled }: { run?: RunEntry; onToggled?: () => void }) {
  const { fav, toggle } = useRunFavorite(run, onToggled)
  return <FavoriteRunButton name="Run 1" fav={fav} onToggle={() => void toggle()} />
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const star = () => screen.getByRole('button', { name: 'Favorite Run 1' })

beforeEach(() => {
  toggleRunFavorite.mockReset()
  toastError.mockReset()
})

describe('useRunFavorite', () => {
  it('shows the new state at once, before the answer', async () => {
    const answer = deferred<unknown>()
    toggleRunFavorite.mockReturnValue(answer.promise)
    const onToggled = vi.fn()
    const user = userEvent.setup()
    render(<Star onToggled={onToggled} />)
    await user.click(star())
    expect(star()).toHaveAttribute('aria-pressed', 'true')
    expect(onToggled).not.toHaveBeenCalled()
    answer.resolve({ ok: true, favorited: true })
    await waitFor(() => expect(onToggled).toHaveBeenCalledTimes(1))
    expect(star()).toHaveAttribute('aria-pressed', 'true')
  })

  it('a second click while the first is pending sends nothing', async () => {
    const answer = deferred<unknown>()
    toggleRunFavorite.mockReturnValue(answer.promise)
    const user = userEvent.setup()
    render(<Star />)
    await user.click(star())
    await user.click(star())
    expect(toggleRunFavorite).toHaveBeenCalledTimes(1)
    answer.resolve({ ok: true, favorited: true })
    await waitFor(() => expect(star()).toHaveAttribute('aria-pressed', 'true'))
    // Once settled, a click toggles again.
    toggleRunFavorite.mockResolvedValue({ ok: true, favorited: false })
    await user.click(star())
    await waitFor(() => expect(star()).toHaveAttribute('aria-pressed', 'false'))
    expect(toggleRunFavorite).toHaveBeenCalledTimes(2)
  })

  it('a network failure rolls back and says so', async () => {
    toggleRunFavorite.mockRejectedValue(new TypeError('Failed to fetch'))
    const onToggled = vi.fn()
    const user = userEvent.setup()
    render(<Star onToggled={onToggled} />)
    await user.click(star())
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not change the favorite. Try again.'))
    expect(star()).toHaveAttribute('aria-pressed', 'false')
    expect(onToggled).not.toHaveBeenCalled()
  })

  it('an ok:false answer rolls back and says so', async () => {
    toggleRunFavorite.mockResolvedValue({ ok: false, error: 'Run not found' })
    const user = userEvent.setup()
    render(<Star run={{ ...RUN, favorited: true }} />)
    await user.click(star())
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not change the favorite. Try again.'))
    expect(star()).toHaveAttribute('aria-pressed', 'true')
  })

  it('ends on the server\'s answer when it differs from the guess', async () => {
    toggleRunFavorite.mockResolvedValue({ ok: true, favorited: false })
    const user = userEvent.setup()
    render(<Star />)
    await user.click(star())
    await waitFor(() => expect(star()).toHaveAttribute('aria-pressed', 'false'))
  })
})
