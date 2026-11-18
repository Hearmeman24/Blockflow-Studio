/**
 * Characters page (viewer): page states, the character strip and URL
 * selection, the profile header (notes autosave, chips, Edit, delete), the
 * Generated tab (the Artifacts gallery components over the character's runs)
 * and the References tab (live media sections). The characters API module is
 * mocked with an in-memory server; runs come from a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '@/lib/characters/api'
import { pickFiles } from '@/lib/file-picker'
import { probeMedia } from '@/lib/byok/probe-media'
import { ARTIFACTS_PAGE_SIZE } from '@/lib/api'
import { CharactersPageBody } from '../characters-page-body'
import {
  character, faceless, installServer, makeRun, media, mia, png, renderWithSWR, runFetches, runsJson, server, stubFetch, stubObjectUrls,
} from './harness'

// ---- next/navigation with a live search string ----
const nav = vi.hoisted(() => {
  let search = ''
  const listeners = new Set<() => void>()
  return {
    get search() { return search },
    set(next: string) { search = next; listeners.forEach((l) => l()) },
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
    replace: vi.fn(),
    push: vi.fn(),
  }
})
vi.mock('next/navigation', async () => {
  const React = await import('react')
  const apply = (url: string) => nav.set(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
  return {
    useRouter: () => ({
      replace: (url: string) => { nav.replace(url); apply(url) },
      push: (url: string) => { nav.push(url); apply(url) },
    }),
    usePathname: () => '/characters',
    useSearchParams: () => {
      const s = React.useSyncExternalStore(nav.subscribe, () => nav.search, () => nav.search)
      return React.useMemo(() => new URLSearchParams(s), [s])
    },
  }
})

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/lib/file-picker', () => ({ pickFiles: vi.fn() }))
vi.mock('@/lib/byok/probe-media', () => ({ probeMedia: vi.fn(async () => ({})) }))
const restoreFlowSnapshot = vi.hoisted(() => vi.fn(() => 'tab-1'))
vi.mock('@/lib/pipeline/tabs-context', () => ({ usePipelineTabs: () => ({ restoreFlowSnapshot }) }))
vi.mock('@/lib/characters/api', async (orig) => {
  const real = await orig<typeof import('@/lib/characters/api')>()
  return {
    CHARACTERS_URL: real.CHARACTERS_URL,
    listCharacters: vi.fn(),
    createCharacter: vi.fn(),
    getCharacter: vi.fn(),
    updateCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    uploadCharacterMedia: vi.fn(),
    deleteCharacterMedia: vi.fn(),
    reorderCharacterMedia: vi.fn(),
  }
})

let fetchMock: ReturnType<typeof stubFetch>
/** Runs per character id. */
let runsBy: Record<string, ReturnType<typeof makeRun>[]>

function renderPage(search = '') {
  nav.set(search)
  return renderWithSWR(<CharactersPageBody />)
}

beforeEach(() => {
  vi.clearAllMocks()
  installServer([mia(), faceless()])
  runsBy = { c1: [makeRun('r1', { name: 'Mia at the beach' }), makeRun('r2', { name: 'Mia 李 portrait' })] }
  fetchMock = stubFetch((id, offset, limit) => {
    const all = runsBy[id] ?? []
    return runsJson(all.slice(offset, offset + limit), all.length, offset)
  })
  stubObjectUrls()
  vi.mocked(pickFiles).mockResolvedValue(null)
  vi.mocked(probeMedia).mockResolvedValue({})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const strip = () => screen.getByRole('navigation', { name: 'Characters' })
const stripButton = (name: string | RegExp) => within(strip()).getByRole('button', { name })
const section = (name: string) => screen.getByRole('region', { name })
const heading = () => screen.getByRole('heading', { level: 2 })
const params = () => new URLSearchParams(nav.search)

// ---- page states ----

describe('page states', () => {
  it('loading: skeletons in the shape of the strip, header and gallery, no "Loading" text', () => {
    vi.mocked(api.listCharacters).mockImplementation(() => new Promise(() => undefined))
    renderPage()
    expect(screen.getAllByTestId('strip-skeleton').length).toBeGreaterThan(1)
    expect(screen.getByTestId('header-skeleton')).toBeInTheDocument()
    expect(screen.getAllByTestId('gallery-skeleton').length).toBeGreaterThan(1)
    expect(screen.queryByText(/loading/i)).toBeNull()
  })

  it('error: the message with one Retry that refetches', async () => {
    vi.mocked(api.listCharacters).mockRejectedValueOnce(new Error('Backend is down'))
    renderPage()
    expect(await screen.findByText('Backend is down')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('navigation', { name: 'Characters' })).toBeInTheDocument()
    expect(api.listCharacters).toHaveBeenCalledTimes(2)
  })

  it('empty: one large primary "Add character" that opens the wizard and creates nothing', async () => {
    installServer([])
    renderPage()
    expect(await screen.findByText('Create your first character')).toBeInTheDocument()
    const add = screen.getAllByRole('button', { name: /add character/i })
    expect(add).toHaveLength(1)
    expect(add[0]).toHaveAttribute('data-variant', 'default')
    expect(add[0]).toHaveAttribute('data-size', 'lg')
    // The only primary on the page.
    expect(document.querySelectorAll('[data-variant="default"]')).toHaveLength(1)
    await userEvent.click(add[0])
    expect(params().get('new')).toBe('1')
    expect(await screen.findByRole('dialog', { name: 'New character' })).toBeInTheDocument()
    expect(api.createCharacter).not.toHaveBeenCalled()
  })
})

// ---- strip and selection ----

describe('character strip', () => {
  it('lists the characters in creation order as round portraits with their names, then a dashed New button', async () => {
    renderPage('id=c1')
    await screen.findByRole('navigation', { name: 'Characters' })
    const items = within(strip()).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    const mia = within(items[0]).getByRole('button', { name: 'Mia' })
    expect(within(mia).getByRole('img')).toHaveAttribute('src', '/outputs/characters/c1/i2.png')
    expect(within(mia).getByText('Mia')).toHaveAttribute('title', 'Mia')
    expect(within(items[1]).getByRole('button', { name: 'Zoë "Ångström" 李' })).toBeInTheDocument()
    const add = within(items[2]).getByRole('button', { name: 'New character' })
    expect(add).toHaveAttribute('data-variant', 'outline')
    expect(add.className).toContain('border-dashed')
    expect(add.className).toContain('rounded-full')
  })

  it('marks the selected character with aria-current and a ring', async () => {
    renderPage('id=c1')
    await screen.findByRole('navigation', { name: 'Characters' })
    expect(stripButton('Mia')).toHaveAttribute('aria-current', 'true')
    expect(stripButton(/Zoë/)).not.toHaveAttribute('aria-current')
    expect(within(stripButton('Mia')).getByTestId('strip-portrait').className).toContain('ring-primary')
  })

  it('a character without a face shows a placeholder and a "Needs a face" marker', async () => {
    renderPage('id=c1')
    await screen.findByRole('navigation', { name: 'Characters' })
    const zoe = stripButton(/Zoë/)
    expect(within(zoe).queryByRole('img')).toBeNull()
    expect(within(zoe).getByTestId('avatar-placeholder')).toBeInTheDocument()
    expect(zoe).toHaveAccessibleDescription('Needs a face')
    expect(stripButton('Mia')).not.toHaveAccessibleDescription('Needs a face')
  })

  it('selecting a character pushes its id and shows its profile', async () => {
    renderPage('id=c1')
    await screen.findByRole('navigation', { name: 'Characters' })
    await userEvent.click(stripButton(/Zoë/))
    expect(nav.push).toHaveBeenLastCalledWith('/characters?id=c2')
    await waitFor(() => expect(heading()).toHaveTextContent('Zoë "Ångström" 李'))
    expect(stripButton(/Zoë/)).toHaveAttribute('aria-current', 'true')
  })

  it('without ?id the first character is selected with replace, not push', async () => {
    renderPage()
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/characters?id=c1'))
    expect(nav.push).not.toHaveBeenCalled()
    expect(await screen.findByRole('heading', { level: 2, name: 'Mia' })).toBeInTheDocument()
  })

  it('an unknown ?id says it no longer exists and falls back to the first character', async () => {
    renderPage('id=gone')
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/characters?id=c1'))
    expect(toastMock).toHaveBeenCalledWith('That character no longer exists')
    expect(await screen.findByRole('heading', { level: 2, name: 'Mia' })).toBeInTheDocument()
  })

  it('New opens the wizard with ?new=1, keeping the selection', async () => {
    renderPage('id=c1')
    await screen.findByRole('navigation', { name: 'Characters' })
    await userEvent.click(stripButton('New character'))
    expect(params().get('new')).toBe('1')
    expect(params().get('id')).toBe('c1')
    expect(await screen.findByRole('dialog', { name: 'New character' })).toBeInTheDocument()
  })
})

// ---- profile header ----

describe('profile header', () => {
  it('shows the portrait, the name, and chips built only from non-zero facts', async () => {
    renderPage('id=c1')
    expect(await screen.findByRole('heading', { level: 2, name: 'Mia' })).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Face' })).getByRole('img')).toHaveAttribute('src', '/outputs/characters/c1/i2.png')
    const facts = screen.getByRole('list', { name: 'Facts' })
    await waitFor(() => expect(within(facts).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '2 generated', '2 images', '1 video', '2 audio clips',
    ]))
  })

  it('a faceless character with no runs has no chips and a "Drop a face" portrait that uploads the face', async () => {
    vi.mocked(pickFiles).mockResolvedValue([png('Zoë 李 face.png')])
    vi.mocked(probeMedia).mockResolvedValue({ width: 512, height: 640 })
    renderPage('id=c2')
    await screen.findByRole('heading', { level: 2, name: /Zoë/ })
    await waitFor(() => expect(runFetches(fetchMock).length).toBeGreaterThan(0))
    expect(screen.queryByRole('list', { name: 'Facts' })).toBeNull()
    const face = screen.getByRole('group', { name: 'Face' })
    await userEvent.click(within(face).getByRole('button', { name: 'Drop a face' }))
    await waitFor(() => expect(api.uploadCharacterMedia).toHaveBeenCalledWith('c2', expect.objectContaining({ name: 'Zoë 李 face.png' }), 'image', { width: 512, height: 640 }))
    expect(await within(face).findByRole('img')).toHaveAttribute('alt', 'Zoë 李 face.png')
    // The strip follows: no more "Needs a face".
    await waitFor(() => expect(stripButton(/Zoë/)).not.toHaveAccessibleDescription('Needs a face'))
  })

  it('autosaves the notes after a pause, once, with the last value', async () => {
    renderPage('id=c1')
    const notes = await screen.findByRole('textbox', { name: 'Notes' })
    expect(notes).toHaveAttribute('placeholder', 'Add notes. Not sent to any model.')
    fireEvent.change(notes, { target: { value: 'Red hair' } })
    fireEvent.change(notes, { target: { value: 'Red hair, 30s — 李' } })
    expect(api.updateCharacter).not.toHaveBeenCalled()
    await waitFor(() => expect(api.updateCharacter).toHaveBeenCalledWith('c1', { description: 'Red hair, 30s — 李' }), { timeout: 2000 })
    expect(api.updateCharacter).toHaveBeenCalledTimes(1)
  })

  it('flushes the notes on blur; a failed save toasts and keeps the text', async () => {
    vi.mocked(api.updateCharacter).mockRejectedValueOnce(new Error('Disk full'))
    renderPage('id=c1')
    const notes = await screen.findByRole('textbox', { name: 'Notes' })
    fireEvent.change(notes, { target: { value: 'Keep me' } })
    fireEvent.blur(notes)
    expect(api.updateCharacter).toHaveBeenCalledWith('c1', { description: 'Keep me' })
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('Disk full')))
    expect(notes).toHaveValue('Keep me')
  })

  it('Edit (outline) opens the wizard in edit mode for the selected character', async () => {
    renderPage('id=c1')
    await screen.findByRole('heading', { level: 2, name: 'Mia' })
    const edit = screen.getByRole('button', { name: 'Edit' })
    expect(edit).toHaveAttribute('data-variant', 'outline')
    await userEvent.click(edit)
    expect(params().get('edit')).toBe('1')
    expect(params().get('id')).toBe('c1')
    expect(await screen.findByRole('dialog', { name: 'Edit Mia' })).toBeInTheDocument()
  })

  it('deletes only after confirming, then selects the next character without a "no longer exists" toast', async () => {
    renderPage('id=c1')
    await screen.findByRole('heading', { level: 2, name: 'Mia' })
    await userEvent.click(screen.getByRole('button', { name: 'Delete character' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Delete "Mia"?')).toBeInTheDocument()
    expect(within(dialog).getByText('Its files are deleted from this computer. Flows that use this character will show it as missing.')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.deleteCharacter).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Delete character' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete character' }))
    expect(api.deleteCharacter).toHaveBeenCalledWith('c1')
    expect(toastMock.success).toHaveBeenCalledWith('Deleted Mia')
    await waitFor(() => expect(params().get('id')).toBe('c2'))
    expect(toastMock).not.toHaveBeenCalledWith('That character no longer exists')
    await waitFor(() => expect(within(strip()).queryByRole('button', { name: 'Mia' })).toBeNull())
  })

  it('deleting the last character shows the empty state', async () => {
    installServer([mia()])
    renderPage('id=c1')
    await screen.findByRole('heading', { level: 2, name: 'Mia' })
    await userEvent.click(screen.getByRole('button', { name: 'Delete character' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete character' }))
    expect(await screen.findByText('Create your first character')).toBeInTheDocument()
    expect(params().get('id')).toBeNull()
  })
})

// ---- tabs ----

describe('tabs', () => {
  it('Generated is the default tab; the tabs carry their counts', async () => {
    renderPage('id=c1')
    await screen.findByRole('heading', { level: 2, name: 'Mia' })
    expect(screen.getByRole('tab', { name: /Generated/ })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.getByRole('tab', { name: /Generated/ })).toHaveTextContent('Generated2'))
    expect(screen.getByRole('tab', { name: /References/ })).toHaveTextContent('References5')
  })

  it('follows ?tab=references and writes the tab to the URL', async () => {
    renderPage('id=c1&tab=references')
    await screen.findByRole('heading', { level: 2, name: 'Mia' })
    expect(screen.getByRole('tab', { name: /References/ })).toHaveAttribute('aria-selected', 'true')
    expect(section('Images')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /Generated/ }))
    await waitFor(() => expect(params().get('tab')).toBeNull())
    await userEvent.click(screen.getByRole('tab', { name: /References/ }))
    await waitFor(() => expect(params().get('tab')).toBe('references'))
  })
})

// ---- Generated ----

describe('Generated tab', () => {
  it('asks the runs route for this character and shows the runs as Artifacts tiles, newest first', async () => {
    renderPage('id=c1')
    const gallery = await screen.findByRole('list', { name: 'Made with Mia' })
    const tiles = within(gallery).getAllByRole('group')
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual(['Mia at the beach', 'Mia 李 portrait'])
    // The Artifacts tile: its data attribute and its Restore and Favorite actions.
    expect(tiles[0]).toHaveAttribute('data-run-tile', 'r1')
    expect(within(tiles[0]).getByRole('button', { name: 'Restore Mia at the beach' })).toBeInTheDocument()
    expect(runFetches(fetchMock)[0]).toBe(`/api/runs?character=c1&limit=${ARTIFACTS_PAGE_SIZE}&offset=0&hide_partial=1`)
  })

  it('opening a tile shows the Artifacts viewer for that run', async () => {
    renderPage('id=c1')
    const gallery = await screen.findByRole('list', { name: 'Made with Mia' })
    await userEvent.click(within(gallery).getByRole('img', { name: 'Mia 李 portrait' }))
    const viewer = await screen.findByRole('dialog')
    expect(within(viewer).getByText('Mia 李 portrait')).toBeInTheDocument()
  })

  it('restoring a run from a tile opens its flow', async () => {
    renderPage('id=c1')
    const gallery = await screen.findByRole('list', { name: 'Made with Mia' })
    await userEvent.click(within(gallery).getByRole('button', { name: 'Restore Mia at the beach' }))
    expect(restoreFlowSnapshot).toHaveBeenCalledWith('Mia at the beach', expect.anything())
  })

  it('links to the Artifacts page filtered to this character', async () => {
    renderPage('id=c1')
    const link = await screen.findByRole('link', { name: 'Open in Artifacts' })
    expect(link).toHaveAttribute('href', '/artifacts?character=c1')
  })

  it('loading: skeleton tiles', async () => {
    fetchMock = stubFetch(() => new Promise(() => undefined))
    renderPage('id=c1')
    await screen.findByRole('heading', { level: 2, name: 'Mia' })
    expect(screen.getByRole('list', { name: 'Loading generated media' })).toBeInTheDocument()
    expect(screen.getAllByTestId('gallery-skeleton').length).toBeGreaterThan(1)
  })

  it('error: the message and a Retry that refetches', async () => {
    let fail = true
    fetchMock = stubFetch((id, offset) => {
      if (fail) return new Response(JSON.stringify({ ok: false, error: 'Run history is unavailable.' }), { status: 500 })
      return runsJson(runsBy[id] ?? [], (runsBy[id] ?? []).length, offset)
    })
    renderPage('id=c1')
    expect(await screen.findByText('Run history is unavailable.')).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('list', { name: 'Made with Mia' })).toBeInTheDocument()
  })

  it('empty: "Nothing made with <name> yet" with one link to Generate', async () => {
    renderPage('id=c2')
    expect(await screen.findByText('Nothing made with Zoë "Ångström" 李 yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Generate' })).toHaveAttribute('href', '/generate')
  })

  it('Load more appends the next page until every run is in', async () => {
    runsBy.c1 = Array.from({ length: ARTIFACTS_PAGE_SIZE + 2 }, (_, i) => makeRun(`p${i}`, { name: `Take ${i}` }))
    renderPage('id=c1')
    const gallery = await screen.findByRole('list', { name: 'Made with Mia' })
    expect(within(gallery).getAllByRole('group')).toHaveLength(ARTIFACTS_PAGE_SIZE)
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(within(gallery).getAllByRole('group')).toHaveLength(ARTIFACTS_PAGE_SIZE + 2))
    expect(runFetches(fetchMock)).toContain(`/api/runs?character=c1&limit=${ARTIFACTS_PAGE_SIZE}&offset=${ARTIFACTS_PAGE_SIZE}&hide_partial=1`)
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })
})

// ---- References ----

describe('References tab', () => {
  const open = async (id = 'c1') => {
    renderPage(`id=${id}&tab=references`)
    await screen.findByRole('heading', { level: 2 })
  }

  it('lists the three sections in order with their media and Add tiles; one Audio section holds every sound', async () => {
    await open()
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
    expect(regions).toEqual(['Images', 'Videos', 'Audio'])
    expect(within(section('Images')).getAllByRole('img').map((i) => i.getAttribute('alt'))).toEqual(['i1.png', 'i2.png'])
    expect(within(section('Videos')).getByLabelText('vid1.mp4').tagName).toBe('VIDEO')
    expect(within(section('Audio')).getByLabelText('vo1.wav').tagName).toBe('AUDIO')
    expect(within(section('Audio')).getByLabelText('au1.mp3').tagName).toBe('AUDIO')
    expect(screen.queryByText(/Sent as "/)).toBeNull()
    const adds = { Images: 'Add images', Videos: 'Add videos', Audio: 'Add audio clips' }
    for (const [name, label] of Object.entries(adds)) {
      const cells = within(within(section(name)).getByRole('list', { name })).getAllByRole('listitem')
      expect(within(cells.at(-1)!).getByRole('button', { name: label })).toHaveTextContent('Add')
    }
  })

  it('adds picked files with probed metadata and refuses the wrong type', async () => {
    vi.mocked(pickFiles).mockResolvedValue([png('a.png'), new File(['x'], 'notes.txt', { type: 'text/plain' }), png('Zoë 李.png')])
    vi.mocked(probeMedia).mockResolvedValue({ width: 640, height: 480 })
    await open()
    const images = section('Images')
    await userEvent.click(within(images).getByRole('button', { name: 'Add images' }))
    await waitFor(() => expect(api.uploadCharacterMedia).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.uploadCharacterMedia).mock.calls.map(([id, f, kind, meta]) => [id, f.name, kind, meta])).toEqual([
      ['c1', 'a.png', 'image', { width: 640, height: 480 }],
      ['c1', 'Zoë 李.png', 'image', { width: 640, height: 480 }],
    ])
    expect(within(images).getByText('notes.txt is not an image file.')).toBeInTheDocument()
    expect(await within(images).findByAltText('Zoë 李.png')).toBeInTheDocument()
  })

  it('removes, moves and stars live', async () => {
    await open()
    const images = section('Images')
    await userEvent.click(within(images).getByRole('button', { name: 'Move i1.png later' }))
    expect(api.reorderCharacterMedia).toHaveBeenCalledWith('c1', 'image', ['i2', 'i1'])
    await userEvent.click(within(images).getByRole('button', { name: 'Use i1.png as the face' }))
    expect(api.updateCharacter).toHaveBeenCalledWith('c1', { default_face_id: 'i1' })
    await waitFor(() => expect(within(images).getByRole('button', { name: 'Use i1.png as the face' })).toHaveAttribute('aria-pressed', 'true'))
    // The current face cannot be un-starred: a character always has a face.
    await userEvent.click(within(images).getByRole('button', { name: 'Use i1.png as the face' }))
    expect(api.updateCharacter).not.toHaveBeenCalledWith('c1', { default_face_id: null })
    // The default audio clip carries the "Default" badge; starring another moves it.
    const audio = section('Audio')
    expect(within(audio).getAllByTestId('default-badge').map((b) => b.textContent)).toEqual(['Default'])
    expect(within(audio).getByRole('button', { name: 'Use vo1.wav as the default audio' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(audio).getByRole('button', { name: 'Use au1.mp3 as the default audio' })).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(within(audio).getByRole('button', { name: 'Use au1.mp3 as the default audio' }))
    expect(api.updateCharacter).toHaveBeenLastCalledWith('c1', { default_audio_id: 'au1' })
    await waitFor(() => expect(within(audio).getByRole('button', { name: 'Use au1.mp3 as the default audio' })).toHaveAttribute('aria-pressed', 'true'))
    // Pressing the default again clears it.
    await userEvent.click(within(audio).getByRole('button', { name: 'Use au1.mp3 as the default audio' }))
    expect(api.updateCharacter).toHaveBeenLastCalledWith('c1', { default_audio_id: null })
    await userEvent.click(within(section('Audio')).getByRole('button', { name: 'Remove au1.mp3' }))
    expect(api.deleteCharacterMedia).toHaveBeenCalledWith('c1', 'au1')
  })

  it('the remove control on the only image is disabled with "A character needs a face"', async () => {
    server.db[0].media = server.db[0].media.filter((m) => m.id !== 'i1')
    await open()
    const remove = within(section('Images')).getByRole('button', { name: 'Remove i2.png' })
    expect(remove).toHaveAttribute('aria-disabled', 'true')
    expect(remove).toHaveAccessibleDescription('A character needs a face')
    await userEvent.click(remove)
    expect(api.deleteCharacterMedia).not.toHaveBeenCalled()
    // Other kinds are still removable.
    expect(within(section('Videos')).getByRole('button', { name: 'Remove vid1.mp4' })).not.toHaveAttribute('aria-disabled')
  })

  it('a 422 from the backend is a toast, and the file stays', async () => {
    vi.mocked(api.deleteCharacterMedia).mockRejectedValueOnce(new Error('A character needs a face. Add another image before removing this one.'))
    await open()
    await userEvent.click(within(section('Images')).getByRole('button', { name: 'Remove i1.png' }))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not remove i1.png: A character needs a face. Add another image before removing this one.'))
    expect(within(section('Images')).getByAltText('i1.png')).toBeInTheDocument()
  })

  it('a pending tile shows while a file uploads', async () => {
    let finish: () => void = () => undefined
    vi.mocked(api.uploadCharacterMedia).mockImplementationOnce((id, file, kind) => new Promise((resolve) => {
      finish = () => {
        const c = server.find(id)
        const m = media('slow', kind, 2, file.name)
        c.media.push(m)
        resolve({ media: JSON.parse(JSON.stringify(m)), character: JSON.parse(JSON.stringify(c)) })
      }
    }))
    vi.mocked(pickFiles).mockResolvedValue([png('slow.png')])
    await open()
    await userEvent.click(within(section('Images')).getByRole('button', { name: 'Add images' }))
    expect(await within(section('Images')).findByTestId('upload-pending')).toHaveAttribute('title', 'slow.png')
    await act(async () => finish())
    await waitFor(() => expect(within(section('Images')).queryByTestId('upload-pending')).toBeNull())
    expect(within(section('Images')).getByAltText('slow.png')).toBeInTheDocument()
  })

  it('drops are sorted to the section kind; a wrong type shows inside that section', async () => {
    await open()
    const clip = new File([new Uint8Array(2)], 'clip 2.mov', { type: 'video/quicktime' })
    fireEvent.drop(within(section('Videos')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [clip, png('wrong.png')] } })
    await waitFor(() => expect(api.uploadCharacterMedia).toHaveBeenCalledWith('c1', clip, 'video', {}))
    expect(api.uploadCharacterMedia).toHaveBeenCalledTimes(1)
    expect(within(section('Videos')).getByText('wrong.png is not a video file.')).toBeInTheDocument()
  })

  it('a character with nothing shows empty sections with their Add tiles', async () => {
    server.db.push(character('c3', { name: 'Empty' }))
    await open('c3')
    const cells = within(within(section('Videos')).getByRole('list', { name: 'Videos' })).getAllByRole('listitem')
    expect(cells).toHaveLength(1)
  })
})
