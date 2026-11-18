import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/settings/client', () => ({
  getAssetStorageMode: vi.fn(),
  setAssetStorageMode: vi.fn(),
}))

import { getAssetStorageMode, setAssetStorageMode } from '@/lib/settings/client'
import { StorageTab } from '../storage-tab'

const save = () => screen.getByRole('button', { name: /^save$/i })

describe('StorageTab', () => {
  beforeEach(() => {
    vi.mocked(getAssetStorageMode).mockReset().mockResolvedValue('tmpfiles')
    vi.mocked(setAssetStorageMode).mockReset().mockResolvedValue(undefined)
  })

  test('offers exactly the local-only and tmpfiles modes', async () => {
    render(<StorageTab />)

    expect(await screen.findByRole('radio', { name: /local only/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /temporary public urls/i })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
  })

  test('loads the stored asset storage mode as the selected card', async () => {
    vi.mocked(getAssetStorageMode).mockResolvedValue('local_only')

    render(<StorageTab />)

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /local only/i })).toBeChecked()
    })
    expect(screen.getByRole('radio', { name: /temporary public urls/i })).not.toBeChecked()
  })

  test('Save is disabled until the selection differs from the saved mode', async () => {
    render(<StorageTab />)
    await screen.findByRole('radio', { name: /local only/i })

    // saved == staged == tmpfiles → nothing to save
    expect(save()).toBeDisabled()
  })

  test('selecting a different mode enables Save and persists on click', async () => {
    const user = userEvent.setup()
    render(<StorageTab />)

    await user.click(await screen.findByRole('radio', { name: /local only/i }))
    expect(save()).toBeEnabled()

    // Selecting does NOT auto-persist.
    expect(setAssetStorageMode).not.toHaveBeenCalled()

    await user.click(save())
    await waitFor(() => {
      expect(setAssetStorageMode).toHaveBeenCalledWith('local_only')
    })
    await waitFor(() => expect(save()).toBeDisabled())
  })

  test('a failed save surfaces the error and keeps the change unsaved', async () => {
    const user = userEvent.setup()
    vi.mocked(setAssetStorageMode).mockRejectedValue(new Error('Settings store unavailable'))
    render(<StorageTab />)

    await user.click(await screen.findByRole('radio', { name: /local only/i }))
    await user.click(save())

    expect(await screen.findByText(/settings store unavailable/i)).toBeInTheDocument()
    expect(save()).toBeEnabled()
  })

  test('a load error says so and offers a Retry that loads the setting', async () => {
    vi.mocked(getAssetStorageMode)
      .mockRejectedValueOnce(new Error('Settings store unavailable'))
      .mockResolvedValueOnce('local_only')
    const user = userEvent.setup()
    render(<StorageTab />)

    expect(await screen.findByText(/settings store unavailable/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /local only/i })).toBeChecked())
    expect(screen.queryByText(/settings store unavailable/i)).not.toBeInTheDocument()
    expect(getAssetStorageMode).toHaveBeenCalledTimes(2)
  })

  test('no mode is shown as selected while the saved mode is loading', async () => {
    vi.mocked(getAssetStorageMode).mockImplementation(() => new Promise(() => {}))
    render(<StorageTab />)

    expect(screen.getByRole('radio', { name: /local only/i })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /temporary public urls/i })).not.toBeChecked()
    expect(save()).toBeDisabled()
  })

  test('copy says local files go to the provider only when a generation needs them', async () => {
    const { container } = render(<StorageTab />)
    await screen.findByRole('radio', { name: /local only/i })

    expect(screen.getByText(/uploaded to the provider only when a generation needs it/i)).toBeInTheDocument()
    expect(screen.getByText(/uploaded to kie or piapi only when a generation uses them/i)).toBeInTheDocument()
    expect(screen.getByText(/anyone with that link can open the file/i)).toBeInTheDocument()
    // Loaders do not publish files; only a refused provider upload can go to tmpfiles.
    expect(container.textContent).not.toMatch(/loaders also create/i)
    expect(container.textContent).not.toMatch(/runpod|serverless|comfy|topaz|provider blocks/i)
  })
})
