import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const swrMocks = vi.hoisted(() => ({ mutate: vi.fn() }))
vi.mock('swr', () => ({ mutate: swrMocks.mutate }))

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMocks }))

import { OnboardingDialog } from '../onboarding-dialog'
import { createFakeBackend, DEFAULT_FOLDER, json, type FakeBackend } from '../settings/__tests__/fake-settings-backend'

const KIE_KEY = 'kie-ONBOARD-0123456789WXYZ'
const PIAPI_KEY = 'piapi-ONBOARD-0123456789QRST'

let backend: FakeBackend
let onFinished: ReturnType<typeof vi.fn<() => void>>

function setup(configure?: (b: FakeBackend) => void) {
  backend = createFakeBackend()
  configure?.(backend)
  vi.stubGlobal('fetch', backend.fetch)
  onFinished = vi.fn<() => void>()
  const user = userEvent.setup()
  render(<OnboardingDialog open onFinished={onFinished} />)
  const dialog = screen.getByRole('dialog')
  return {
    user,
    dialog,
    kieInput: () => within(dialog).getByLabelText(/^kie api key$/i),
    piapiInput: () => within(dialog).getByLabelText(/^piapi api key$/i),
    save: () => within(dialog).getByRole('button', { name: /save and continue/i }),
    skip: () => within(dialog).getByRole('button', { name: /skip for now/i }),
    folderInput: () => within(dialog).getByLabelText(/^output folder$/i),
    chooseButton: () => within(dialog).getByRole('button', { name: /choose folder/i }),
  }
}

const folderPuts = () => backend.fetch.mock.calls
  .filter(([input, init]) => String(input) === '/api/settings/app-prefs/output_dir' && init?.method === 'PUT')
  .map(([, init]) => JSON.parse(String(init?.body)).value)

const putCalls = () => backend.calls().filter((c) => c.startsWith('PUT /api/settings/credentials/'))

beforeEach(() => {
  swrMocks.mutate.mockReset()
  Object.values(toastMocks).forEach((m) => m.mockReset())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OnboardingDialog content', () => {
  test('explains BYOK and offers two labelled password inputs', () => {
    const { dialog, kieInput, piapiInput, save, skip } = setup()

    expect(within(dialog).getByRole('heading', { name: /welcome to blockflow/i })).toBeInTheDocument()
    expect(dialog).toHaveTextContent(/you bring your own kie or piapi key; you pay the provider directly/i)
    expect(dialog).toHaveTextContent(/either key is enough/i)
    expect(kieInput()).toHaveAttribute('type', 'password')
    expect(piapiInput()).toHaveAttribute('type', 'password')
    expect(save()).toBeDisabled()
    expect(skip()).toBeEnabled()
    expect(dialog.textContent).not.toMatch(/runpod|serverless|comfy|topaz/i)
  })

  test('sign-up links use the referral URLs in a new tab', () => {
    const { dialog } = setup()
    const kie = within(dialog).getByRole('link', { name: /get a kie api key/i })
    const piapi = within(dialog).getByRole('link', { name: /get a piapi api key/i })
    expect(kie).toHaveAttribute('href', 'https://kie.ai/?ref=071ed206b70bc522e7626d3b4d1ad069')
    expect(piapi).toHaveAttribute('href', 'https://piapi.ai/?ref=dbc2855b-3394-4052-8b8a-6dcc471bfced')
    for (const link of [kie, piapi]) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
  })

  test('has a polite live region for status changes', () => {
    const { dialog } = setup()
    expect(within(dialog).getByRole('status')).toHaveAttribute('aria-live', 'polite')
  })

  test('save enables once one key is typed (whitespace does not count)', async () => {
    const { user, kieInput, save } = setup()
    await user.type(kieInput(), '   ')
    expect(save()).toBeDisabled()
    await user.type(kieInput(), 'k')
    expect(save()).toBeEnabled()
  })
})

describe('OnboardingDialog saving', () => {
  test('save with only a Kie key stores it, completes onboarding and defaults storage', async () => {
    const { user, kieInput, save } = setup()
    await user.type(kieInput(), KIE_KEY)
    await user.click(save())

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1))
    expect(backend.keys.get('kie_api_key')).toBe(KIE_KEY)
    expect(backend.keys.has('piapi_api_key')).toBe(false)
    expect(putCalls()).toEqual(['PUT /api/settings/credentials/kie_api_key'])
    expect(backend.prefs.get('onboarding_completed')).toBe('true')
    expect(backend.prefs.get('asset_storage_mode')).toBe('local_only')
    expect(swrMocks.mutate).toHaveBeenCalledWith('/api/providers/catalog')
  })

  test('save with both keys stores both', async () => {
    const { user, kieInput, piapiInput, save } = setup()
    await user.type(kieInput(), KIE_KEY)
    await user.type(piapiInput(), PIAPI_KEY)
    await user.click(save())

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1))
    expect(backend.keys.get('kie_api_key')).toBe(KIE_KEY)
    expect(backend.keys.get('piapi_api_key')).toBe(PIAPI_KEY)
    expect(backend.prefs.get('onboarding_completed')).toBe('true')
  })

  test('an existing storage mode is left alone', async () => {
    const { user, piapiInput, save } = setup()
    backend.prefs.set('asset_storage_mode', 'tmpfiles')
    await user.type(piapiInput(), PIAPI_KEY)
    await user.click(save())

    await waitFor(() => expect(onFinished).toHaveBeenCalled())
    expect(backend.prefs.get('asset_storage_mode')).toBe('tmpfiles')
  })

  test('a save failure keeps the dialog open with the typed input and the error', async () => {
    const { user, dialog, kieInput, piapiInput, save } = setup()
    backend.override('PUT /api/settings/credentials/piapi_api_key', () =>
      json({ detail: 'API key must not contain spaces or line breaks.' }, 422))

    await user.type(kieInput(), KIE_KEY)
    await user.type(piapiInput(), 'bad key')
    await user.click(save())

    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/piapi/i)
    expect(alert).toHaveTextContent(/must not contain spaces/i)
    expect(onFinished).not.toHaveBeenCalled()
    expect(backend.prefs.has('onboarding_completed')).toBe(false)
    expect(kieInput()).toHaveValue(KIE_KEY)
    expect(piapiInput()).toHaveValue('bad key')
    expect(save()).toBeEnabled()
  })

  test('a failure to mark onboarding complete keeps the dialog open', async () => {
    const { user, dialog, kieInput, save } = setup()
    backend.override('PUT /api/settings/app-prefs/onboarding_completed', () => json({ detail: 'disk full' }, 500))

    await user.type(kieInput(), KIE_KEY)
    await user.click(save())

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/disk full/i)
    expect(onFinished).not.toHaveBeenCalled()
    expect(kieInput()).toHaveValue(KIE_KEY)
  })

  test('after saving, the key check runs in the background and never blocks completion', async () => {
    const { user, kieInput, save } = setup()
    let resolveCheck!: (r: Response) => void
    backend.override('POST /api/providers/kie/validate-key', () => new Promise<Response>((resolve) => {
      resolveCheck = resolve
    }))

    await user.type(kieInput(), KIE_KEY)
    await user.click(save())

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1))
    expect(backend.calls()).toContain('POST /api/providers/kie/validate-key')
    expect(backend.calls()).not.toContain('POST /api/providers/piapi/validate-key')

    resolveCheck(json({ ok: true, valid: false, message: 'Kie rejected this key.' }))
    await waitFor(() => expect(toastMocks.warning).toHaveBeenCalledWith(expect.stringMatching(/kie rejected this key/i)))
  })

  test('a failing background check is silent', async () => {
    const { user, kieInput, save } = setup()
    backend.override('POST /api/providers/kie/validate-key', () => {
      throw new TypeError('Failed to fetch')
    })
    await user.type(kieInput(), KIE_KEY)
    await user.click(save())

    await waitFor(() => expect(onFinished).toHaveBeenCalled())
    expect(toastMocks.error).not.toHaveBeenCalled()
  })
})

describe('OnboardingDialog skip', () => {
  test('skip completes onboarding without saving keys and points to Settings', async () => {
    const { user, kieInput, skip } = setup()
    await user.type(kieInput(), KIE_KEY)
    await user.click(skip())

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1))
    expect(putCalls()).toEqual([])
    expect(backend.keys.size).toBe(0)
    expect(backend.prefs.get('onboarding_completed')).toBe('true')
    expect(backend.prefs.get('asset_storage_mode')).toBe('local_only')
    expect(toastMocks.info).toHaveBeenCalledWith(expect.stringMatching(/later in settings/i))
  })

  test('a skip failure keeps the dialog open and shows the error', async () => {
    const { user, dialog, skip } = setup()
    backend.override('PUT /api/settings/app-prefs/onboarding_completed', () => json({ detail: 'disk full' }, 500))
    await user.click(skip())

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/disk full/i)
    expect(onFinished).not.toHaveBeenCalled()
  })
})

describe('OnboardingDialog keyboard', () => {
  test('focus starts in the Kie field; Tab reaches PiAPI; Enter saves', async () => {
    const { user, kieInput, piapiInput } = setup()

    await waitFor(() => expect(kieInput()).toHaveFocus())
    await user.keyboard(KIE_KEY)
    await user.tab()
    // The Kie sign-up link sits between the two fields.
    expect(screen.getByRole('link', { name: /get a kie api key/i })).toHaveFocus()
    await user.tab()
    expect(piapiInput()).toHaveFocus()
    await user.keyboard(`${PIAPI_KEY}{Enter}`)

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1))
    expect(backend.keys.get('kie_api_key')).toBe(KIE_KEY)
    expect(backend.keys.get('piapi_api_key')).toBe(PIAPI_KEY)
  })

  test('Skip is reachable by keyboard and Escape does not discard typed keys', async () => {
    const { user, kieInput, skip } = setup()
    await waitFor(() => expect(kieInput()).toHaveFocus())
    await user.keyboard('partial-key{Escape}')

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(kieInput()).toHaveValue('partial-key')
    expect(onFinished).not.toHaveBeenCalled()

    skip().focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(onFinished).toHaveBeenCalled())
  })
})

describe('OnboardingDialog output folder', () => {
  test('shows the default folder as a real path with a choose button and the explanation', async () => {
    const { dialog, folderInput, chooseButton } = setup()
    await waitFor(() => expect(folderInput()).toHaveValue(DEFAULT_FOLDER))
    expect(folderInput()).toHaveAttribute('type', 'text')
    expect(chooseButton()).toBeEnabled()
    expect(dialog).toHaveTextContent(
      /generated images and videos and the files you add to loaders are saved here/i)
    expect(dialog).toHaveTextContent(/earlier files stay where they are and remain available/i)
    expect(dialog.textContent).not.toMatch(/restart/i)
  })

  test('saving keys with the default folder does not store a folder', async () => {
    const { user, kieInput, folderInput, save } = setup()
    await waitFor(() => expect(folderInput()).toHaveValue(DEFAULT_FOLDER))
    await user.type(kieInput(), KIE_KEY)
    await user.click(save())
    await waitFor(() => expect(onFinished).toHaveBeenCalled())
    expect(folderPuts()).toEqual([])
    expect(backend.prefs.has('output_dir')).toBe(false)
  })

  test('choose folder success fills the field; save stores keys and folder', async () => {
    const chosen = '/Volumes/Ext SSD/BlockFlow Ünï'
    const { user, kieInput, folderInput, chooseButton, save } = setup((b) => {
      b.folder.choose = { status: 'chosen', path: chosen }
    })
    await waitFor(() => expect(folderInput()).toHaveValue(DEFAULT_FOLDER))

    await user.click(chooseButton())
    await waitFor(() => expect(folderInput()).toHaveValue(chosen))
    const chooseCall = backend.fetch.mock.calls.find(([input]) => String(input) === '/api/settings/choose-folder')
    expect(JSON.parse(String(chooseCall?.[1]?.body))).toEqual({ initial: DEFAULT_FOLDER })

    await user.type(kieInput(), KIE_KEY)
    await user.click(save())
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1))
    expect(folderPuts()).toEqual([chosen])
    expect(backend.prefs.get('output_dir')).toBe(chosen)
    expect(backend.keys.get('kie_api_key')).toBe(KIE_KEY)
    expect(backend.prefs.get('onboarding_completed')).toBe('true')
    expect(toastMocks.info).toHaveBeenCalledWith(expect.stringMatching(/new files are saved to/i))
    expect(toastMocks.info.mock.calls.flat().join(' ')).not.toMatch(/restart/i)
  })

  test('cancelling the dialog leaves the field as it was', async () => {
    const { user, folderInput, chooseButton } = setup((b) => {
      b.folder.choose = { status: 'cancelled' }
    })
    await waitFor(() => expect(folderInput()).toHaveValue(DEFAULT_FOLDER))
    await user.click(chooseButton())
    await waitFor(() => expect(backend.calls()).toContain('POST /api/settings/choose-folder'))
    expect(folderInput()).toHaveValue(DEFAULT_FOLDER)
    expect(chooseButton()).toBeEnabled()
  })

  test('an unavailable dialog disables the button with a reason; typing still works', async () => {
    const { user, dialog, folderInput, chooseButton } = setup((b) => {
      b.folder.choose = { status: 'unavailable', message: 'There is no desktop display for a folder dialog.' }
    })
    await waitFor(() => expect(folderInput()).toHaveValue(DEFAULT_FOLDER))
    await user.click(chooseButton())

    await waitFor(() => expect(chooseButton()).toBeDisabled())
    expect(dialog).toHaveTextContent(/no desktop display/i)
    await user.clear(folderInput())
    await user.type(folderInput(), '/Users/ana/Typed')
    expect(folderInput()).toHaveValue('/Users/ana/Typed')
  })

  test('picker reported unavailable up front: button disabled with the reason', async () => {
    const { dialog, folderInput, chooseButton } = setup((b) => {
      b.folder.picker = { available: false, reason: 'Install zenity or kdialog to choose a folder with a dialog.' }
    })
    await waitFor(() => expect(folderInput()).toHaveValue(DEFAULT_FOLDER))
    expect(chooseButton()).toBeDisabled()
    expect(dialog).toHaveTextContent(/install zenity or kdialog/i)
  })

  test('a typed Windows path is saved as typed, even without a key', async () => {
    const typed = 'D:\\Renders\\BlockFlow Out'
    const { user, folderInput, save } = setup()
    await waitFor(() => expect(folderInput()).toHaveValue(DEFAULT_FOLDER))
    expect(save()).toBeDisabled()
    await user.clear(folderInput())
    await user.type(folderInput(), typed)
    expect(save()).toBeEnabled()
    await user.click(save())

    await waitFor(() => expect(onFinished).toHaveBeenCalled())
    expect(folderPuts()).toEqual([typed])
    expect(putCalls()).toEqual([])
  })

  test('an invalid folder keeps the dialog open with every typed value and saves no key', async () => {
    const { user, dialog, kieInput, folderInput, save } = setup()
    await waitFor(() => expect(folderInput()).toHaveValue(DEFAULT_FOLDER))
    await user.type(kieInput(), KIE_KEY)
    await user.clear(folderInput())
    await user.type(folderInput(), 'relative/out')
    await user.click(save())

    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/full folder path/i)
    expect(onFinished).not.toHaveBeenCalled()
    expect(folderInput()).toHaveValue('relative/out')
    expect(kieInput()).toHaveValue(KIE_KEY)
    expect(putCalls()).toEqual([])
    expect(backend.prefs.has('onboarding_completed')).toBe(false)
  })

  test('skip keeps the default folder even if one was typed', async () => {
    const { user, folderInput, skip } = setup()
    await waitFor(() => expect(folderInput()).toHaveValue(DEFAULT_FOLDER))
    await user.clear(folderInput())
    await user.type(folderInput(), '/Users/ana/Elsewhere')
    await user.click(skip())
    await waitFor(() => expect(onFinished).toHaveBeenCalled())
    expect(folderPuts()).toEqual([])
    expect(backend.prefs.get('onboarding_completed')).toBe('true')
  })

  test('if the folder status cannot be loaded the field is empty and keys still save', async () => {
    const { user, dialog, kieInput, folderInput, save } = setup((b) => {
      b.override('GET /api/settings/output-folder', () => json({ detail: 'boom' }, 500))
    })
    await waitFor(() => expect(dialog).toHaveTextContent(/leave it empty to use the default folder/i))
    expect(folderInput()).toHaveValue('')
    await user.type(kieInput(), KIE_KEY)
    await user.click(save())
    await waitFor(() => expect(onFinished).toHaveBeenCalled())
    expect(folderPuts()).toEqual([])
  })
})
