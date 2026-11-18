/**
 * The character wizard, driven through the page and its URL (`?new=1`,
 * `?edit=1`). Create mode stages everything in memory and sends nothing until
 * "Create character"; edit mode saves each change at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '@/lib/characters/api'
import { pickFiles } from '@/lib/file-picker'
import { probeMedia } from '@/lib/byok/probe-media'
import { CharactersPageBody } from '../characters-page-body'
import { clone, installServer, media, mia, mp4, png, renderWithSWR, runsJson, server, stubFetch, stubObjectUrls, txt, wav, writeCalls } from './harness'

const nav = vi.hoisted(() => {
  let search = ''
  const listeners = new Set<() => void>()
  return {
    get search() { return search },
    set(next: string) { search = next; listeners.forEach((l) => l()) },
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  }
})
vi.mock('next/navigation', async () => {
  const React = await import('react')
  const go = (url: string) => nav.set(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
  return {
    useRouter: () => ({ replace: go, push: go }),
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
vi.mock('@/lib/pipeline/tabs-context', () => ({ usePipelineTabs: () => ({ restoreFlowSnapshot: vi.fn() }) }))
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
let urls: ReturnType<typeof stubObjectUrls>

beforeEach(() => {
  vi.clearAllMocks()
  installServer([])
  fetchMock = stubFetch(() => runsJson([]))
  urls = stubObjectUrls()
  vi.mocked(pickFiles).mockResolvedValue(null)
  vi.mocked(probeMedia).mockImplementation(async (file: File, kind) => (kind === 'image' ? { width: 600, height: 800 } : kind === 'video' ? { width: 720, height: 1280, duration_s: 4.5 } : { duration_s: 2.25 }))
})
afterEach(() => vi.unstubAllGlobals())

const params = () => new URLSearchParams(nav.search)
function renderPage(search: string) {
  nav.set(search)
  return renderWithSWR(<CharactersPageBody />)
}

const dialog = () => screen.getByRole('dialog')
const inDialog = () => within(dialog())
const nameField = () => inDialog().getByRole('textbox', { name: 'Name' }) as HTMLInputElement
const button = (name: string | RegExp) => inDialog().getByRole('button', { name })
const faceZone = () => within(inDialog().getByRole('group', { name: 'Face photo' })).getByTestId('loader-drop-zone')
const region = (name: string) => inDialog().getByRole('region', { name })
const stepButton = (name: RegExp) => within(inDialog().getByRole('list', { name: 'Steps' })).getByRole('button', { name })

async function openNew(search = 'new=1') {
  renderPage(search)
  return screen.findByRole('dialog', { name: 'New character' })
}

async function stageFace(file = png('Zoë 李 #1.png')) {
  fireEvent.drop(faceZone(), { dataTransfer: { files: [file] } })
  await inDialog().findByRole('img', { name: file.name })
}

// ---- step 1 ----

describe('create: face and name', () => {
  it('shows the three steps with step 1 current', async () => {
    await openNew()
    const steps = within(inDialog().getByRole('list', { name: 'Steps' })).getAllByRole('listitem')
    expect(steps.map((s) => s.textContent)).toEqual(['1Face and name', '2Looks', '3Audio'])
    expect(stepButton(/Face and name/)).toHaveAttribute('aria-current', 'step')
    expect(inDialog().getByText('Who is this?')).toBeInTheDocument()
    expect(nameField()).toHaveFocus()
    expect(nameField()).toHaveAttribute('maxlength', '80')
    expect(inDialog().getByText('Drop a photo of the face')).toBeInTheDocument()
  })

  it('Next is disabled, with the reason for assistive tech, until there is a face and a non-blank name', async () => {
    await openNew()
    const next = button('Next')
    expect(next).toHaveAttribute('aria-disabled', 'true')
    expect(next).toHaveAccessibleDescription('Add a face and a name first')
    await userEvent.click(next)
    expect(stepButton(/Face and name/)).toHaveAttribute('aria-current', 'step')

    fireEvent.change(nameField(), { target: { value: '   ' } })
    await stageFace()
    expect(button('Next')).toHaveAttribute('aria-disabled', 'true')

    fireEvent.change(nameField(), { target: { value: 'Zoë "Ångström" 李' } })
    expect(button('Next')).not.toHaveAttribute('aria-disabled', 'true')
    expect(button('Next')).toHaveAttribute('data-variant', 'default')
  })

  it('a name without a face is not enough', async () => {
    await openNew()
    fireEvent.change(nameField(), { target: { value: 'Mia' } })
    expect(button('Next')).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(nameField(), { key: 'Enter' })
    expect(stepButton(/Face and name/)).toHaveAttribute('aria-current', 'step')
  })

  it('Enter in the name goes to the next step when allowed', async () => {
    await openNew()
    await stageFace()
    fireEvent.change(nameField(), { target: { value: 'Mia' } })
    fireEvent.keyDown(nameField(), { key: 'Enter' })
    await waitFor(() => expect(stepButton(/Looks/)).toHaveAttribute('aria-current', 'step'))
  })

  it('refuses a non-image face inline and keeps nothing', async () => {
    await openNew()
    fireEvent.drop(faceZone(), { dataTransfer: { files: [txt('notes.txt')] } })
    expect(await inDialog().findByText('notes.txt is not an image file.')).toBeInTheDocument()
    expect(inDialog().queryByRole('img')).toBeNull()
    expect(urls.create).not.toHaveBeenCalled()
  })

  it('clicking the drop zone picks one image; Change replaces it and revokes the old preview', async () => {
    vi.mocked(pickFiles).mockResolvedValueOnce([png('first.png')]).mockResolvedValueOnce([png('second.png')])
    await openNew()
    await userEvent.click(button(/Drop a photo of the face/))
    expect(pickFiles).toHaveBeenCalledWith(expect.objectContaining({ accept: 'image/*', multiple: false }))
    const first = await inDialog().findByRole('img', { name: 'first.png' })
    const firstUrl = first.getAttribute('src')!
    await userEvent.click(button('Change'))
    expect(await inDialog().findByRole('img', { name: 'second.png' })).toBeInTheDocument()
    expect(urls.revoked).toContain(firstUrl)
  })
})

// ---- steps 2 and 3, and the create flow ----

async function toLooks(name = 'Zoë "Ångström" 李') {
  await openNew()
  await stageFace()
  fireEvent.change(nameField(), { target: { value: name } })
  await userEvent.click(button('Next'))
  await waitFor(() => expect(stepButton(/Looks/)).toHaveAttribute('aria-current', 'step'))
}

describe('create: looks and audio', () => {
  it('Looks shows the face first with its badge and no remove, then staged images and videos sorted by type', async () => {
    await toLooks()
    expect(inDialog().getByText('Other angles, full body, outfits, short clips.')).toBeInTheDocument()
    const looks = region('Looks')
    const faceTile = within(looks).getByAltText('Zoë 李 #1.png').closest('li')!
    expect(within(faceTile).getByTestId('default-badge')).toHaveTextContent('Face')
    expect(within(faceTile).queryByRole('button', { name: /Remove/ })).toBeNull()

    fireEvent.drop(within(looks).getByTestId('loader-drop-zone'), { dataTransfer: { files: [mp4('walk 李.mp4'), png('side.png'), txt('notes.txt')] } })
    expect(await within(looks).findByAltText('side.png')).toBeInTheDocument()
    expect(within(looks).getByLabelText('walk 李.mp4').tagName).toBe('VIDEO')
    expect(within(looks).getByText('notes.txt is not an image or a video file.')).toBeInTheDocument()
    // Images first (face, side), then videos.
    const order = within(within(looks).getByRole('list', { name: 'Looks' })).getAllByRole('listitem').map((li) => li.getAttribute('title'))
    expect(order.slice(0, 3)).toEqual(['Zoë 李 #1.png', 'side.png', 'walk 李.mp4'])
    expect(probeMedia).toHaveBeenCalledWith(expect.objectContaining({ name: 'walk 李.mp4' }), 'video')
    expect(writeCalls()).toBe(0)
  })

  it('a staged look can be removed, which revokes its preview', async () => {
    await toLooks()
    const looks = region('Looks')
    fireEvent.drop(within(looks).getByTestId('loader-drop-zone'), { dataTransfer: { files: [png('side.png')] } })
    const img = await within(looks).findByAltText('side.png')
    const src = img.getAttribute('src')!
    await userEvent.click(within(looks).getByRole('button', { name: 'Remove side.png' }))
    await waitFor(() => expect(within(looks).queryByAltText('side.png')).toBeNull())
    expect(urls.revoked).toContain(src)
  })

  it('staged images can be reordered, but never ahead of the face', async () => {
    await toLooks()
    const looks = region('Looks')
    fireEvent.drop(within(looks).getByTestId('loader-drop-zone'), { dataTransfer: { files: [png('a.png'), png('b.png')] } })
    await within(looks).findByAltText('b.png')
    expect(within(looks).getByRole('button', { name: 'Move a.png earlier' })).toBeDisabled()
    await userEvent.click(within(looks).getByRole('button', { name: 'Move a.png later' }))
    await waitFor(() => expect(within(looks).getAllByRole('img').map((i) => i.getAttribute('alt'))).toEqual(['Zoë 李 #1.png', 'b.png', 'a.png']))
  })

  it('Audio: one section and one Add tile; says how sound is sent; the first clip is the default, a star changes it', async () => {
    await toLooks('Dr. Who?')
    await userEvent.click(button('Next'))
    expect(stepButton(/Audio/)).toHaveAttribute('aria-current', 'step')
    expect(inDialog().getByRole('heading', { name: 'Audio' })).toBeInTheDocument()
    expect(inDialog().getByText('A voice sample or any other sound. Sent to the model as audio; your prompt says how to use it.')).toBeInTheDocument()
    expect(inDialog().queryByText(/Sent as "/)).toBeNull()
    expect(inDialog().queryByRole('region', { name: 'Voice' })).toBeNull()
    expect(within(region('Audio')).getAllByRole('button', { name: /^Add/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Add audio'])
    fireEvent.drop(within(region('Audio')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [wav('one.wav'), wav('two 李.wav')] } })
    await within(region('Audio')).findByRole('button', { name: 'Use two 李.wav as the default audio' })
    expect(within(region('Audio')).getByRole('button', { name: 'Use one.wav as the default audio' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(region('Audio')).getAllByTestId('default-badge').map((b) => b.textContent)).toEqual(['Default'])
    await userEvent.click(within(region('Audio')).getByRole('button', { name: 'Use two 李.wav as the default audio' }))
    expect(within(region('Audio')).getByRole('button', { name: 'Use two 李.wav as the default audio' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(region('Audio')).getByRole('button', { name: 'Use one.wav as the default audio' })).toHaveAttribute('aria-pressed', 'false')
    expect(writeCalls()).toBe(0)
  })

  it('the footer has one primary: Next on step 1, Create character on steps 2 and 3', async () => {
    await openNew()
    expect(inDialog().queryByRole('button', { name: 'Create character' })).toBeNull()
    await stageFace()
    fireEvent.change(nameField(), { target: { value: 'Mia' } })
    await userEvent.click(button('Next'))
    expect(button('Create character')).toHaveAttribute('data-variant', 'default')
    expect(button('Next')).not.toHaveAttribute('data-variant', 'default')
    expect(button('Back')).toBeInTheDocument()
    expect(dialog().querySelectorAll('[data-variant="default"]')).toHaveLength(1)
    await userEvent.click(button('Next'))
    expect(inDialog().queryByRole('button', { name: 'Next' })).toBeNull()
    expect(button('Create character')).toHaveAttribute('data-variant', 'default')
    await userEvent.click(button('Back'))
    expect(stepButton(/Looks/)).toHaveAttribute('aria-current', 'step')
  })

  it('sends nothing at all before Create character', async () => {
    await toLooks()
    fireEvent.drop(within(region('Looks')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [png('side.png')] } })
    await within(region('Looks')).findByAltText('side.png')
    await userEvent.click(button('Next'))
    fireEvent.drop(within(region('Audio')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [wav('v.wav')] } })
    await within(region('Audio')).findByRole('button', { name: 'Play v.wav' })
    expect(writeCalls()).toBe(0)
    // No characters, no selection: the only request is the character list itself.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('create: Create character', () => {
  async function stageAll() {
    await toLooks()
    fireEvent.drop(within(region('Looks')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [png('side.png'), mp4('walk.mp4')] } })
    await within(region('Looks')).findByLabelText('walk.mp4')
    await userEvent.click(button('Next'))
    fireEvent.drop(within(region('Audio')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [wav('one.wav'), wav('two 李.wav'), new File([new Uint8Array(1)], 'laugh.mp3', { type: 'audio/mpeg' })] } })
    await within(region('Audio')).findByRole('button', { name: 'Play laugh.mp3' })
    await userEvent.click(within(region('Audio')).getByRole('button', { name: 'Use two 李.wav as the default audio' }))
  }

  it('posts the face with the name, uploads the rest in order with probed metadata as audio, then sets the starred default audio', async () => {
    await stageAll()
    await userEvent.click(button('Create character'))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Created Zoë "Ångström" 李'))
    expect(api.createCharacter).toHaveBeenCalledWith({
      name: 'Zoë "Ångström" 李',
      face: expect.objectContaining({ name: 'Zoë 李 #1.png' }),
      meta: { width: 600, height: 800 },
    })
    expect(vi.mocked(api.uploadCharacterMedia).mock.calls.map(([id, f, kind, meta]) => [id, f.name, kind, meta])).toEqual([
      ['new1', 'side.png', 'image', { width: 600, height: 800 }],
      ['new1', 'walk.mp4', 'video', { width: 720, height: 1280, duration_s: 4.5 }],
      ['new1', 'one.wav', 'audio', { duration_s: 2.25 }],
      ['new1', 'two 李.wav', 'audio', { duration_s: 2.25 }],
      ['new1', 'laugh.mp3', 'audio', { duration_s: 2.25 }],
    ])
    const twoId = server.find('new1').media.find((m) => m.label === 'two 李.wav')!.id
    expect(api.updateCharacter).toHaveBeenCalledWith('new1', { default_audio_id: twoId })
    expect(server.find('new1').default_audio_id).toBe(twoId)
    // Closed, the new character selected, ?new gone.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(params().get('id')).toBe('new1')
    expect(params().get('new')).toBeNull()
    expect(await screen.findByRole('heading', { level: 2, name: 'Zoë "Ångström" 李' })).toBeInTheDocument()
  })

  it('does not PATCH the default when the first audio clip stays the default (the backend makes it the default)', async () => {
    await toLooks()
    await userEvent.click(button('Next'))
    fireEvent.drop(within(region('Audio')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [wav('one.wav'), wav('two.wav')] } })
    await within(region('Audio')).findByRole('button', { name: 'Play two.wav' })
    await userEvent.click(button('Create character'))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    expect(api.updateCharacter).not.toHaveBeenCalled()
  })

  it('shows progress on the button while it works', async () => {
    let releaseCreate: () => void = () => undefined
    const realCreate = vi.mocked(api.createCharacter).getMockImplementation()!
    vi.mocked(api.createCharacter).mockImplementationOnce((input) => new Promise((resolve) => { releaseCreate = () => resolve(realCreate(input)) }))
    let releaseUpload: () => void = () => undefined
    const realUpload = vi.mocked(api.uploadCharacterMedia).getMockImplementation()!
    vi.mocked(api.uploadCharacterMedia)
      .mockImplementationOnce((...a) => realUpload(...a))
      .mockImplementationOnce((...a) => new Promise((resolve) => { releaseUpload = () => resolve(realUpload(...a)) }))
    await toLooks()
    fireEvent.drop(within(region('Looks')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [png('a.png'), png('b.png'), png('c.png')] } })
    await within(region('Looks')).findByAltText('c.png')
    await userEvent.click(button('Create character'))
    expect(await inDialog().findByRole('button', { name: 'Creating…' })).toHaveAttribute('aria-disabled', 'true')
    releaseCreate()
    expect(await inDialog().findByRole('button', { name: 'Adding 2 of 3…' })).toBeInTheDocument()
    releaseUpload()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a failed create stays on the step with the backend message and loses nothing', async () => {
    vi.mocked(api.createCharacter).mockRejectedValueOnce(new Error('A character needs a name and a face image.'))
    await toLooks()
    fireEvent.drop(within(region('Looks')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [png('side.png')] } })
    await within(region('Looks')).findByAltText('side.png')
    await userEvent.click(button('Create character'))
    expect(await inDialog().findByText('A character needs a name and a face image.')).toBeInTheDocument()
    expect(stepButton(/Looks/)).toHaveAttribute('aria-current', 'step')
    expect(within(region('Looks')).getByAltText('side.png')).toBeInTheDocument()
    expect(api.uploadCharacterMedia).not.toHaveBeenCalled()
    expect(params().get('new')).toBe('1')
    // Trying again works.
    await userEvent.click(button('Create character'))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Created Zoë "Ångström" 李'))
  })

  it('when some files fail, the character is kept and the dialog switches to edit mode with the failures and a Retry', async () => {
    const realUpload = vi.mocked(api.uploadCharacterMedia).getMockImplementation()!
    vi.mocked(api.uploadCharacterMedia).mockImplementation(async (id, file, kind, meta) => {
      if (file.name === 'walk.mp4') throw new Error('File is too large.')
      return realUpload(id, file, kind, meta)
    })
    await toLooks()
    fireEvent.drop(within(region('Looks')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [mp4('walk.mp4'), png('side.png')] } })
    await within(region('Looks')).findByAltText('side.png')
    await userEvent.click(button('Create character'))
    const panel = await inDialog().findByRole('alert')
    expect(panel).toHaveTextContent('walk.mp4: File is too large.')
    expect(within(panel).queryByText(/side\.png/)).toBeNull()
    expect(await screen.findByRole('dialog', { name: 'Edit Zoë "Ångström" 李' })).toBeInTheDocument()
    expect(params().get('id')).toBe('new1')
    expect(params().get('edit')).toBe('1')
    expect(params().get('new')).toBeNull()
    expect(api.deleteCharacter).not.toHaveBeenCalled()
    expect(server.find('new1').media.map((m) => m.label)).toEqual(['Zoë 李 #1.png', 'side.png'])
    expect(inDialog().queryByRole('button', { name: 'Create character' })).toBeNull()
    expect(button('Done')).toHaveAttribute('data-variant', 'default')

    vi.mocked(api.uploadCharacterMedia).mockImplementation(realUpload)
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(inDialog().queryByRole('alert')).toBeNull())
    expect(api.uploadCharacterMedia).toHaveBeenLastCalledWith('new1', expect.objectContaining({ name: 'walk.mp4' }), 'video', { width: 720, height: 1280, duration_s: 4.5 })
    expect(server.find('new1').media.map((m) => m.label)).toContain('walk.mp4')
  })
})

describe('create: hand-off after a partial failure', () => {
  const failWalk = () => {
    const realUpload = vi.mocked(api.uploadCharacterMedia).getMockImplementation()!
    vi.mocked(api.uploadCharacterMedia).mockImplementation(async (id, file, kind, meta) => {
      if (file.name === 'walk.mp4') throw new Error('File is too large.')
      return realUpload(id, file, kind, meta)
    })
    return realUpload
  }

  it('keeps the failures when the list does not hold the new character yet', async () => {
    const realUpload = vi.mocked(api.uploadCharacterMedia).getMockImplementation()!
    vi.mocked(api.uploadCharacterMedia).mockImplementation(async (id, file, kind, meta) => {
      if (file.name !== 'walk.mp4') return realUpload(id, file, kind, meta)
      // A list read started before the create answers now, without the new character.
      vi.mocked(api.listCharacters).mockResolvedValueOnce([])
      // Past SWR's focus throttle, so the focus revalidates the list.
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_000)
      window.dispatchEvent(new Event('focus'))
      await waitFor(() => expect(api.listCharacters).toHaveBeenCalledTimes(2))
      clock.mockRestore()
      await new Promise((r) => setTimeout(r, 20))
      throw new Error('File is too large.')
    })
    await toLooks()
    fireEvent.drop(within(region('Looks')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [png('side.png'), mp4('walk.mp4')] } })
    await within(region('Looks')).findByLabelText('walk.mp4')
    await userEvent.click(button('Create character'))
    await waitFor(() => expect(params().get('edit')).toBe('1'))
    const panel = await inDialog().findByRole('alert')
    expect(panel).toHaveTextContent('walk.mp4: File is too large.')
    expect(params().get('id')).toBe('new1')
    // Its steps wait for the character; the title keeps the name.
    expect(screen.getByRole('dialog', { name: 'Edit Zoë "Ångström" 李' })).toBeInTheDocument()
    expect(inDialog().getByTestId('wizard-waiting')).toBeInTheDocument()
    // Retry still knows the character, and its answer brings it back into the list.
    vi.mocked(api.uploadCharacterMedia).mockImplementation(realUpload)
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(inDialog().queryByRole('alert')).toBeNull())
    expect(api.uploadCharacterMedia).toHaveBeenLastCalledWith('new1', expect.objectContaining({ name: 'walk.mp4' }), 'video', expect.anything())
    expect(await screen.findByRole('dialog', { name: 'Edit Zoë "Ångström" 李' })).toBeInTheDocument()
  })

  it('Done with files still not added asks first; Keep editing keeps them', async () => {
    failWalk()
    await toLooks()
    fireEvent.drop(within(region('Looks')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [mp4('walk.mp4')] } })
    await within(region('Looks')).findByLabelText('walk.mp4')
    await userEvent.click(button('Create character'))
    await screen.findByRole('dialog', { name: 'Edit Zoë "Ångström" 李' })
    await userEvent.click(button('Done'))
    const ask = await screen.findByRole('alertdialog', { name: 'Close without the files that were not added?' })
    expect(ask).toHaveTextContent('walk.mp4')
    await userEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }))
    expect(screen.getByRole('dialog', { name: 'Edit Zoë "Ångström" 李' })).toBeInTheDocument()
    expect(inDialog().getByRole('alert')).toHaveTextContent('walk.mp4: File is too large.')
    expect(params().get('edit')).toBe('1')
  })

  it('Done with files still not added closes after "Close"', async () => {
    failWalk()
    await toLooks()
    fireEvent.drop(within(region('Looks')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [mp4('walk.mp4')] } })
    await within(region('Looks')).findByLabelText('walk.mp4')
    await userEvent.click(button('Create character'))
    await screen.findByRole('dialog', { name: 'Edit Zoë "Ångström" 李' })
    await userEvent.click(button('Done'))
    const ask = await screen.findByRole('alertdialog')
    await userEvent.click(within(ask).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(params().get('edit')).toBeNull()
    expect(params().get('id')).toBe('new1')
  })
})

describe('create: closing', () => {
  it('with nothing staged, Cancel just closes and removes ?new', async () => {
    await openNew('new=1')
    await userEvent.click(button('Cancel'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(params().get('new')).toBeNull()
  })

  it('with something staged, Escape asks "Discard this character?"; keeping it keeps everything', async () => {
    await openNew()
    await stageFace()
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Discard this character?')).toBeInTheDocument()
    await userEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }))
    expect(screen.getByRole('dialog', { name: 'New character' })).toBeInTheDocument()
    expect(inDialog().getByRole('img', { name: 'Zoë 李 #1.png' })).toBeInTheDocument()
  })

  it('discarding closes, removes ?new, revokes every preview and sends nothing', async () => {
    await openNew()
    await stageFace()
    fireEvent.change(nameField(), { target: { value: 'Mia' } })
    await userEvent.click(button('Next'))
    fireEvent.drop(within(region('Looks')).getByTestId('loader-drop-zone'), { dataTransfer: { files: [png('side.png')] } })
    await within(region('Looks')).findByAltText('side.png')
    await userEvent.click(button('Cancel'))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(params().get('new')).toBeNull()
    expect(new Set(urls.revoked)).toEqual(new Set(urls.created))
    expect(writeCalls()).toBe(0)
  })
})

// ---- edit mode ----

describe('edit mode', () => {
  beforeEach(() => installServer([mia()]))

  async function openEdit() {
    renderPage('id=c1&edit=1')
    return screen.findByRole('dialog', { name: 'Edit Mia' })
  }

  it('is prefilled and live: the face portrait and the name', async () => {
    await openEdit()
    expect(nameField()).toHaveValue('Mia')
    expect(within(inDialog().getByRole('group', { name: 'Face' })).getByRole('img')).toHaveAttribute('src', '/outputs/characters/c1/i2.png')
    expect(inDialog().queryByRole('button', { name: 'Create character' })).toBeNull()
    expect(button('Done')).toHaveAttribute('data-variant', 'default')
    // Every step is reachable.
    await userEvent.click(stepButton(/Audio/))
    expect(within(region('Audio')).getByRole('button', { name: 'Use vo1.wav as the default audio' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(region('Audio')).getByRole('button', { name: 'Use au1.mp3 as the default audio' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('autosaves the name after a pause; a blank name is never saved and reverts on blur', async () => {
    await openEdit()
    fireEvent.change(nameField(), { target: { value: '   ' } })
    expect(nameField()).toHaveAttribute('aria-invalid', 'true')
    fireEvent.blur(nameField())
    expect(nameField()).toHaveValue('Mia')
    fireEvent.change(nameField(), { target: { value: 'Mia 李 <b>&' } })
    await waitFor(() => expect(api.updateCharacter).toHaveBeenCalledWith('c1', { name: 'Mia 李 <b>&' }), { timeout: 2000 })
    expect(api.updateCharacter).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('dialog', { name: 'Edit Mia 李 <b>&' })).toBeInTheDocument()
  })

  it('a new face is uploaded and set at once', async () => {
    await openEdit()
    fireEvent.drop(within(inDialog().getByRole('group', { name: 'Face' })).getByTestId('loader-drop-zone'), { dataTransfer: { files: [png('new face.png')] } })
    await waitFor(() => expect(api.uploadCharacterMedia).toHaveBeenCalledWith('c1', expect.objectContaining({ name: 'new face.png' }), 'image', { width: 600, height: 800 }))
    await waitFor(() => expect(api.updateCharacter).toHaveBeenCalledWith('c1', { default_face_id: expect.stringMatching(/^up/) }))
  })

  it('looks are live: add uploads, remove deletes, the face is locked', async () => {
    await openEdit()
    await userEvent.click(button('Next'))
    const looks = region('Looks')
    const faceTile = within(looks).getByAltText('i2.png').closest('li')!
    expect(within(faceTile).queryByRole('button', { name: /Remove/ })).toBeNull()
    fireEvent.drop(within(looks).getByTestId('loader-drop-zone'), { dataTransfer: { files: [mp4('clip.mp4')] } })
    await waitFor(() => expect(api.uploadCharacterMedia).toHaveBeenCalledWith('c1', expect.objectContaining({ name: 'clip.mp4' }), 'video', { width: 720, height: 1280, duration_s: 4.5 }))
    await userEvent.click(within(looks).getByRole('button', { name: 'Remove i1.png' }))
    expect(api.deleteCharacterMedia).toHaveBeenCalledWith('c1', 'i1')
  })

  it('the default-audio star is live', async () => {
    server.db[0].media.push(media('vo2', 'audio', 2, 'Zoë 李 take.wav'))
    server.db[0] = clone(server.db[0])
    await openEdit()
    await userEvent.click(stepButton(/Audio/))
    await userEvent.click(within(region('Audio')).getByRole('button', { name: 'Use Zoë 李 take.wav as the default audio' }))
    expect(api.updateCharacter).toHaveBeenCalledWith('c1', { default_audio_id: 'vo2' })
  })

  it('Done closes and removes ?edit, keeping the selection', async () => {
    await openEdit()
    await userEvent.click(button('Done'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(params().get('edit')).toBeNull()
    expect(params().get('id')).toBe('c1')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
