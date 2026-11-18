import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  chooseFolder,
  forgetOutputFolder,
  getOutputFolder,
  saveOutputFolder,
  type OutputFolderStatus,
} from './output-folder'

function respond(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

afterEach(() => vi.unstubAllGlobals())

const STATUS: OutputFolderStatus = {
  in_use: '/Users/a/Library/Application Support/BlockFlow Studio/output',
  default: '/Users/a/Library/Application Support/BlockFlow Studio/output',
  configured: null,
  configured_unavailable: false,
  previous: [{ path: '/Volumes/Old/Out', available: true }],
  picker: { available: true, reason: null },
}

describe('output folder client', () => {
  test('getOutputFolder reads the status route', async () => {
    const fetchMock = respond(STATUS)
    vi.stubGlobal('fetch', fetchMock)
    expect(await getOutputFolder()).toEqual(STATUS)
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/output-folder', expect.objectContaining({ method: 'GET' }))
  })

  test('getOutputFolder throws the server detail', async () => {
    vi.stubGlobal('fetch', respond({ detail: 'database is locked' }, 500))
    await expect(getOutputFolder()).rejects.toThrow('database is locked')
  })

  test('saveOutputFolder PUTs the output_dir pref', async () => {
    const fetchMock = respond({ name: 'output_dir', saved: true })
    vi.stubGlobal('fetch', fetchMock)
    await saveOutputFolder('D:\\Renders\\BlockFlow Out')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings/app-prefs/output_dir')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ value: 'D:\\Renders\\BlockFlow Out' })
  })

  test('saveOutputFolder throws the validation message', async () => {
    vi.stubGlobal('fetch', respond({ detail: 'That folder is read-only: /x. Choose a folder you can write to.' }, 400))
    await expect(saveOutputFolder('/x')).rejects.toThrow(/read-only/)
  })

  test('chooseFolder POSTs the initial folder and returns the outcome', async () => {
    const fetchMock = respond({ status: 'chosen', path: '/Users/a/Out' })
    vi.stubGlobal('fetch', fetchMock)
    expect(await chooseFolder('/Users/a')).toEqual({ status: 'chosen', path: '/Users/a/Out' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings/choose-folder')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ initial: '/Users/a' })
  })

  test('forgetOutputFolder POSTs the folder and returns the new status', async () => {
    const fetchMock = respond({ ...STATUS, previous: [] })
    vi.stubGlobal('fetch', fetchMock)
    expect((await forgetOutputFolder('/Volumes/Old/Out')).previous).toEqual([])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings/output-folder/forget')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ path: '/Volumes/Old/Out' })
  })

  test('forgetOutputFolder throws the server detail', async () => {
    vi.stubGlobal('fetch', respond({ detail: 'That folder is not in the list of earlier output folders.' }, 404))
    await expect(forgetOutputFolder('/x')).rejects.toThrow(/not in the list/)
  })

  test('chooseFolder turns a network failure into unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const result = await chooseFolder()
    expect(result.status).toBe('unavailable')
  })
})
