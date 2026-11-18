/**
 * Client for the output folder routes (`backend/settings_routes.py`,
 * `backend/output_folder.py`, `backend/folder_picker.py`).
 *
 * The folder is stored in the `output_dir` app pref ("" = default). A saved
 * change applies immediately. Files already saved stay where they are, and the
 * backend keeps serving `/outputs/...` from earlier folders (`previous`), so
 * existing references keep working until a folder is removed from that list.
 */

export const OUTPUT_DIR_PREF = 'output_dir'

export type OutputFolderStatus = {
  /** Folder the running backend writes to and serves at /outputs. */
  in_use: string
  /** Platform default (`<user data dir>/output`). */
  default: string
  /** Saved choice, or null when the default is used. */
  configured: string | null
  /** The saved folder is missing (e.g. an unplugged drive); the default is in use. */
  configured_unavailable: boolean
  /** Earlier output folders still read for `/outputs/...`, most recent first. */
  previous: { path: string; available: boolean }[]
  picker: { available: boolean; reason: string | null }
}

export type ChooseFolderResult =
  | { status: 'chosen'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' | 'busy'; message: string }

async function detail(res: Response): Promise<string> {
  try {
    const body = await res.json()
    return typeof body?.detail === 'string' && body.detail ? body.detail : `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export async function getOutputFolder(): Promise<OutputFolderStatus> {
  const res = await fetch('/api/settings/output-folder', { method: 'GET' })
  if (!res.ok) throw new Error(await detail(res))
  return (await res.json()) as OutputFolderStatus
}

/** Validate (server-side), create if needed and store the folder. "" = default. */
export async function saveOutputFolder(path: string): Promise<void> {
  const res = await fetch(`/api/settings/app-prefs/${OUTPUT_DIR_PREF}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: path }),
  })
  if (!res.ok) throw new Error(await detail(res))
}

/** Stop reading an earlier output folder. Its files are not touched. */
export async function forgetOutputFolder(path: string): Promise<OutputFolderStatus> {
  const res = await fetch('/api/settings/output-folder/forget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!res.ok) throw new Error(await detail(res))
  return (await res.json()) as OutputFolderStatus
}

/** Ask the local backend to open the operating system's folder dialog. */
export async function chooseFolder(initial?: string): Promise<ChooseFolderResult> {
  try {
    const res = await fetch('/api/settings/choose-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initial ? { initial } : {}),
    })
    if (!res.ok) throw new Error(await detail(res))
    return (await res.json()) as ChooseFolderResult
  } catch {
    return { status: 'unavailable', message: 'Could not reach BlockFlow to open a folder dialog. Type the folder path instead.' }
  }
}
