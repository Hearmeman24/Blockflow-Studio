import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { SWRConfig } from 'swr'
import { PROMPT_LIBRARY_URL, type PromptType, type SavedPrompt } from '@/lib/prompt-library/api'
import { PromptLibraryButton, SEARCH_THRESHOLD } from './prompt-library-button'

const toastMocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() })
  return { toast }
})
vi.mock('sonner', () => ({ toast: toastMocks.toast }))

const entry = (id: string, over: Partial<SavedPrompt> = {}): SavedPrompt => ({
  id, name: id, type: 'generation', content: `text of ${id}`, created_at: '2026-01-01T00:00:00Z', ...over,
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubLibrary(initial: SavedPrompt[]) {
  let prompts = [...initial]
  const fail: { next: (() => Response | Promise<Response>) | null; hold: Promise<void> | null } = { next: null, hold: null }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (fail.hold) await fail.hold
    if (fail.next) {
      const f = fail.next
      fail.next = null
      return f()
    }
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === PROMPT_LIBRARY_URL && method === 'GET') return json({ ok: true, prompts })
    if (url === PROMPT_LIBRARY_URL && method === 'POST') {
      const body = JSON.parse(String(init?.body))
      const created = entry(`new-${prompts.length}`, { name: body.name.trim(), type: body.type, content: body.content })
      prompts = [...prompts, created]
      return json({ ok: true, prompt: created })
    }
    const id = decodeURIComponent(url.slice(PROMPT_LIBRARY_URL.length + 1))
    prompts = prompts.filter((p) => p.id !== id)
    return json({ ok: true })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, fail, current: () => prompts }
}

/** A prompt box with the library button, as blocks use it. */
function Box({ type = 'generation', initial = '', label = 'Generation Prompt' }: { type?: PromptType; initial?: string; label?: string }) {
  const [text, setText] = useState(initial)
  return (
    <div>
      <label htmlFor={`box-${label}`}>{label}</label>
      <PromptLibraryButton type={type} value={text} onChange={setText} />
      <textarea id={`box-${label}`} value={text} onChange={(e) => setText(e.target.value)} />
    </div>
  )
}

function renderBoxes(...boxes: React.ReactElement[]) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{boxes}</SWRConfig>)
}

const LABEL = 'Saved generation prompts'

async function openLibrary(user: ReturnType<typeof userEvent.setup>, name = LABEL, index = 0) {
  await user.click(screen.getAllByRole('button', { name })[index])
  return screen.findByRole('dialog', { name })
}

beforeEach(() => {
  toastMocks.toast.mockClear()
  toastMocks.toast.success.mockClear()
  toastMocks.toast.error.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

describe('PromptLibraryButton', () => {
  it('is a book button named for its type and loads nothing until opened', async () => {
    const { fetchMock } = stubLibrary([])
    renderBoxes(<Box key="g" />, <Box key="s" type="system" label="System Prompt" />, <Box key="u" type="user" label="User Prompt" />)
    expect(screen.getByRole('button', { name: 'Saved generation prompts' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saved system prompts' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saved user prompts' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows a skeleton while loading, then only the saved prompts of its own type', async () => {
    let release!: () => void
    const { fail } = stubLibrary([entry('Fox'), entry('Terse', { type: 'system' }), entry('Lake', { content: 'a frozen lake\nat dawn' })])
    fail.hold = new Promise<void>((r) => { release = r })
    const user = userEvent.setup()
    renderBoxes(<Box key="g" />)
    const dialog = await openLibrary(user)
    expect(within(dialog).getByLabelText('Loading saved prompts')).toHaveAttribute('aria-busy', 'true')
    fail.hold = null
    await act(async () => { release() })
    expect(await within(dialog).findByRole('button', { name: /^Use Fox/ })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /^Use Lake/ })).toHaveTextContent('a frozen lake')
    expect(within(dialog).queryByRole('button', { name: /^Use Terse/ })).toBeNull()
  })

  it('says when there are none yet and still offers to save', async () => {
    stubLibrary([entry('Terse', { type: 'system' })])
    const user = userEvent.setup()
    renderBoxes(<Box key="g" initial="a cat" />)
    const dialog = await openLibrary(user)
    expect(await within(dialog).findByText('No saved generation prompts yet')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('a failed load shows a readable error with Retry, which loads again', async () => {
    const { fail } = stubLibrary([entry('Fox')])
    fail.next = () => json({ ok: false, kind: 'corrupt', error: 'The prompt library file (prompt_library.json) is not a valid list of prompts.' }, 500)
    const user = userEvent.setup()
    renderBoxes(<Box key="g" />)
    const dialog = await openLibrary(user)
    expect(await within(dialog).findByText(/not a valid list of prompts/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }))
    expect(await within(dialog).findByRole('button', { name: /^Use Fox/ })).toBeInTheDocument()
  })

  it('using a saved prompt replaces the box, closes, and Undo restores the previous text', async () => {
    stubLibrary([entry('Fox', { content: 'a fox in the snow 🦊' })])
    const user = userEvent.setup()
    renderBoxes(<Box key="g" initial="my own words" />)
    const dialog = await openLibrary(user)
    await user.click(await within(dialog).findByRole('button', { name: /^Use Fox/ }))
    expect(screen.getByLabelText('Generation Prompt')).toHaveValue('a fox in the snow 🦊')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(toastMocks.toast).toHaveBeenCalledWith('Used "Fox"', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))
    const undo = toastMocks.toast.mock.calls[0][1].action.onClick as () => void
    act(() => undo())
    expect(screen.getByLabelText('Generation Prompt')).toHaveValue('my own words')
  })

  it('saving is disabled while the box is empty or whitespace, and needs a name', async () => {
    stubLibrary([])
    const user = userEvent.setup()
    renderBoxes(<Box key="g" initial="   " />)
    const dialog = await openLibrary(user)
    await within(dialog).findByText('No saved generation prompts yet')
    await user.type(within(dialog).getByLabelText('Name'), 'Empty')
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(within(dialog).getByText('Write a prompt in the box first.')).toBeInTheDocument()
  })

  it('saves the current text under a name; the other open box sees it at once', async () => {
    const { fetchMock, fail } = stubLibrary([])
    const user = userEvent.setup()
    renderBoxes(<Box key="a" initial="夜の東京, neon rain 🌧️" label="First" />, <Box key="b" label="Second" />)
    const dialog = await openLibrary(user, LABEL, 0)
    await within(dialog).findByText('No saved generation prompts yet')
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Name'), 'Tokyo rain')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await within(dialog).findByRole('button', { name: /^Use Tokyo rain/ })
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(String(post[1]?.body))).toEqual({ name: 'Tokyo rain', type: 'generation', content: '夜の東京, neon rain 🌧️' })
    expect(within(dialog).getByLabelText('Name')).toHaveValue('')
    expect(toastMocks.toast.success).toHaveBeenCalledWith('Saved "Tokyo rain"')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // From here no request is ever answered, so the second box can only show the
    // saved prompt from the shared cache. (Opening a box may refetch in the
    // background; counting GETs here depended on timing and failed on CI.)
    fail.hold = new Promise<void>(() => {})
    const second = await openLibrary(user, LABEL, 1)
    expect(within(second).getByRole('button', { name: /^Use Tokyo rain/ })).toBeInTheDocument()
  })

  it('a refused save shows the server message and keeps the list and the typed name', async () => {
    const { fail } = stubLibrary([entry('Fox')])
    const user = userEvent.setup()
    renderBoxes(<Box key="g" initial="x" />)
    const dialog = await openLibrary(user)
    await within(dialog).findByRole('button', { name: /^Use Fox/ })
    await user.type(within(dialog).getByLabelText('Name'), 'Fox')
    fail.next = () => json({ ok: false, kind: 'duplicate', error: 'A saved generation prompt named "Fox" already exists. Choose another name.' }, 409)
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('named "Fox" already exists')
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Fox')
    expect(within(dialog).getAllByRole('button', { name: /^Use / })).toHaveLength(1)
  })

  it('a network failure on save is readable', async () => {
    const { fail } = stubLibrary([])
    const user = userEvent.setup()
    renderBoxes(<Box key="g" initial="x" />)
    const dialog = await openLibrary(user)
    await within(dialog).findByText('No saved generation prompts yet')
    await user.type(within(dialog).getByLabelText('Name'), 'N')
    fail.next = () => { throw new TypeError('Failed to fetch') }
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('BlockFlow is not reachable')
  })

  it('pressing Enter in the name field saves', async () => {
    const { fetchMock } = stubLibrary([])
    const user = userEvent.setup()
    renderBoxes(<Box key="g" initial="x" />)
    const dialog = await openLibrary(user)
    await within(dialog).findByText('No saved generation prompts yet')
    await user.type(within(dialog).getByLabelText('Name'), 'Quick{Enter}')
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
  })

  it('delete asks inline, Cancel keeps the entry, confirming removes it', async () => {
    const { fetchMock } = stubLibrary([entry('Fox'), entry('Lake')])
    const user = userEvent.setup()
    renderBoxes(<Box key="g" />)
    const dialog = await openLibrary(user)
    await user.click(await within(dialog).findByRole('button', { name: 'Delete Fox' }))
    expect(within(dialog).getByText('Delete "Fox"?')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)

    await user.click(within(dialog).getByRole('button', { name: 'Delete Fox' }))
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: /^Use Fox/ })).toBeNull())
    expect(within(dialog).getByRole('button', { name: /^Use Lake/ })).toBeInTheDocument()
  })

  it('a failed delete keeps the entry and says why', async () => {
    const { fail } = stubLibrary([entry('Fox')])
    const user = userEvent.setup()
    renderBoxes(<Box key="g" />)
    const dialog = await openLibrary(user)
    await user.click(await within(dialog).findByRole('button', { name: 'Delete Fox' }))
    fail.next = () => json({ ok: false, kind: 'not_found', error: 'That saved prompt no longer exists.' }, 404)
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That saved prompt no longer exists.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(within(dialog).getByRole('button', { name: /^Use Fox/ })).toBeInTheDocument()
  })

  it('deleting the prompt that was just used keeps the box text and Undo still works', async () => {
    stubLibrary([entry('Fox', { content: 'fox text' })])
    const user = userEvent.setup()
    renderBoxes(<Box key="g" initial="before" />)
    let dialog = await openLibrary(user)
    await user.click(await within(dialog).findByRole('button', { name: /^Use Fox/ }))
    dialog = await openLibrary(user)
    await user.click(within(dialog).getByRole('button', { name: 'Delete Fox' }))
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await within(dialog).findByText('No saved generation prompts yet')
    expect(screen.getByLabelText('Generation Prompt')).toHaveValue('fox text')
    act(() => (toastMocks.toast.mock.calls[0][1].action.onClick as () => void)())
    expect(screen.getByLabelText('Generation Prompt')).toHaveValue('before')
  })

  it(`shows a search field only above ${SEARCH_THRESHOLD} entries, matching name and text`, async () => {
    const many = Array.from({ length: SEARCH_THRESHOLD + 1 }, (_, i) => entry(`P${i}`))
    many[2] = entry('Castle', { content: 'a castle at night' })
    many[3] = entry('Dawn', { content: 'a CASTLE at dawn' })
    stubLibrary(many)
    const user = userEvent.setup()
    renderBoxes(<Box key="g" />)
    const dialog = await openLibrary(user)
    const search = await within(dialog).findByRole('searchbox', { name: 'Search saved generation prompts' })
    await user.type(search, 'castle')
    expect(within(dialog).getAllByRole('button', { name: /^Use / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Use Castle', 'Use Dawn'])
    await user.clear(search)
    await user.type(search, 'zzz')
    expect(within(dialog).getByText('No saved prompt matches.')).toBeInTheDocument()
  })

  it('no search field with a few entries', async () => {
    stubLibrary([entry('A'), entry('B')])
    const user = userEvent.setup()
    renderBoxes(<Box key="g" />)
    const dialog = await openLibrary(user)
    await within(dialog).findByRole('button', { name: /^Use A/ })
    expect(within(dialog).queryByRole('searchbox')).toBeNull()
  })

  it('keeps keys and wheel inside the popover away from the canvas', async () => {
    stubLibrary([entry('A')])
    const user = userEvent.setup()
    const onKeyDown = vi.fn()
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <div onKeyDown={onKeyDown}><Box /></div>
      </SWRConfig>,
    )
    const dialog = await openLibrary(user)
    expect(dialog.className).toMatch(/\bpanningDisabled\b/)
    expect(dialog.className).toMatch(/\bwheelDisabled\b/)
    const name = within(dialog).getByLabelText('Name')
    fireEvent.keyDown(name, { key: 'a' })
    fireEvent.keyDown(name, { key: 'ArrowRight' })
    fireEvent.keyDown(name, { key: 'Delete' })
    expect(onKeyDown).not.toHaveBeenCalled()
  })
})
