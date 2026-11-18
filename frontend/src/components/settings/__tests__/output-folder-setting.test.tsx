import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

import { OutputFolderSetting } from '../output-folder-setting'
import { createFakeBackend, DEFAULT_FOLDER, json, type FakeBackend } from './fake-settings-backend'

let backend: FakeBackend

function setup(configure?: (b: FakeBackend) => void) {
  backend = createFakeBackend()
  configure?.(backend)
  vi.stubGlobal('fetch', backend.fetch)
  const user = userEvent.setup()
  render(<OutputFolderSetting />)
  return {
    user,
    input: () => screen.getByLabelText(/^output folder$/i),
    save: () => screen.getByRole('button', { name: /save folder/i }),
    choose: () => screen.getByRole('button', { name: /choose folder/i }),
  }
}

const folderPuts = () => backend.fetch.mock.calls
  .filter(([input, init]) => String(input) === '/api/settings/app-prefs/output_dir' && init?.method === 'PUT')
  .map(([, init]) => JSON.parse(String(init?.body)).value)

beforeEach(() => Object.values(toastMocks).forEach((m) => m.mockReset()))
afterEach(() => vi.unstubAllGlobals())

describe('OutputFolderSetting', () => {
  test('loading skeleton, then the folder in use and a pre-filled field', async () => {
    let release!: () => void
    const { input } = setup((b) => b.override('GET /api/settings/output-folder', () => new Promise((resolve) => {
      release = () => resolve(json({
        in_use: DEFAULT_FOLDER, default: DEFAULT_FOLDER, configured: null,
        configured_unavailable: false, previous: [], picker: { available: true, reason: null },
      }))
    })))
    expect(screen.getByText(/loading the output folder/i)).toBeInTheDocument()
    release()
    await waitFor(() => expect(input()).toHaveValue(DEFAULT_FOLDER))
    expect(screen.getByText(/in use now/i)).toHaveTextContent(DEFAULT_FOLDER)
    expect(screen.getByText(/earlier files stay where they are and remain available/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/restart/i)
  })

  test('error with retry', async () => {
    let fail = true
    const { user, input } = setup((b) => b.override('GET /api/settings/output-folder', () => (fail
      ? json({ detail: 'database is locked' }, 500)
      : json({ in_use: DEFAULT_FOLDER, default: DEFAULT_FOLDER, configured: null,
        configured_unavailable: false, previous: [], picker: { available: true, reason: null } }))))
    expect(await screen.findByText(/could not load the output folder/i)).toBeInTheDocument()
    expect(screen.getByText(/database is locked/i)).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(input()).toHaveValue(DEFAULT_FOLDER))
  })

  test('choose and save: the new folder is in use at once, the old one is listed', async () => {
    const chosen = 'E:\\BlockFlow Ünï'
    const { user, input, save, choose } = setup((b) => {
      b.folder.choose = { status: 'chosen', path: chosen }
    })
    await waitFor(() => expect(input()).toHaveValue(DEFAULT_FOLDER))
    expect(save()).toBeDisabled()

    await user.click(choose())
    await waitFor(() => expect(input()).toHaveValue(chosen))
    await user.click(save())

    await waitFor(() => expect(folderPuts()).toEqual([chosen]))
    await waitFor(() => expect(screen.getByText(/in use now/i)).toHaveTextContent(chosen))
    expect(toastMocks.success).toHaveBeenCalledWith(expect.stringMatching(/new files are saved to/i))
    expect(toastMocks.success.mock.calls[0][0]).not.toMatch(/restart/i)
    const earlier = screen.getByRole('list', { name: /earlier output folders/i })
    expect(earlier).toHaveTextContent(DEFAULT_FOLDER)
  })

  test('a rejected folder shows the reason and keeps what was typed', async () => {
    const { user, input, save } = setup()
    await waitFor(() => expect(input()).toHaveValue(DEFAULT_FOLDER))
    await user.clear(input())
    await user.type(input(), 'nope/relative')
    await user.click(save())
    expect(await screen.findByRole('alert')).toHaveTextContent(/full folder path/i)
    expect(input()).toHaveValue('nope/relative')
    expect(backend.prefs.has('output_dir')).toBe(false)
  })

  test('use default folder clears the saved choice', async () => {
    const { user } = setup((b) => b.prefs.set('output_dir', '/Volumes/Ext/Out'))
    await user.click(await screen.findByRole('button', { name: /use default folder/i }))
    await waitFor(() => expect(folderPuts()).toEqual(['']))
    expect(backend.prefs.get('output_dir')).toBe('')
  })

  test('picker unavailable: the button is disabled with the reason; typing still works', async () => {
    const { user, input, choose, save } = setup((b) => {
      b.folder.picker = { available: false, reason: 'There is no desktop display for a folder dialog.' }
    })
    await waitFor(() => expect(input()).toHaveValue(DEFAULT_FOLDER))
    expect(choose()).toBeDisabled()
    expect(screen.getByText(/no desktop display/i)).toBeInTheDocument()
    await user.clear(input())
    await user.type(input(), '/Users/ana/Typed')
    await user.click(save())
    await waitFor(() => expect(folderPuts()).toEqual(['/Users/ana/Typed']))
  })

  test('a saved folder that is missing is explained', async () => {
    setup((b) => b.override('GET /api/settings/output-folder', () => json({
      in_use: DEFAULT_FOLDER, default: DEFAULT_FOLDER, configured: '/Volumes/Unplugged/Out',
      configured_unavailable: true, previous: [], picker: { available: true, reason: null },
    })))
    expect(await screen.findByText(/isn't available/i)).toHaveTextContent('/Volumes/Unplugged/Out')
  })

  test('earlier folders: stop reading one after a confirmation', async () => {
    const { user } = setup((b) => {
      b.folder.previous = ['/Volumes/Old/Out', '/Users/ana/Older']
    })
    const list = await screen.findByRole('list', { name: /earlier output folders/i })
    expect(list).toHaveTextContent('/Volumes/Old/Out')
    expect(list).toHaveTextContent('/Users/ana/Older')

    await user.click(screen.getByRole('button', { name: /stop reading \/volumes\/old\/out/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(/will show as missing/i)
    expect(dialog).toHaveTextContent(/nothing is deleted/i)

    await user.click(within(dialog).getByRole('button', { name: /cancel/i }))
    expect(backend.folder.previous).toEqual(['/Volumes/Old/Out', '/Users/ana/Older'])

    await user.click(screen.getByRole('button', { name: /stop reading \/volumes\/old\/out/i }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /stop reading/i }))
    await waitFor(() => expect(backend.folder.previous).toEqual(['/Users/ana/Older']))
    await waitFor(() => expect(screen.getByRole('list', { name: /earlier output folders/i }))
      .not.toHaveTextContent('/Volumes/Old/Out'))
  })

  test('no earlier folders: no list', async () => {
    const { input } = setup()
    await waitFor(() => expect(input()).toHaveValue(DEFAULT_FOLDER))
    expect(screen.queryByRole('list', { name: /earlier output folders/i })).not.toBeInTheDocument()
  })
})
