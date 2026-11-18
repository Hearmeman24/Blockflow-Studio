import '@/test-utils/ui-sdk-jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
/** `toast(message, options)`; the library's Undo toast uses it. */
const toastFn = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: Object.assign(toastFn, toastMocks) }))

import { blockDef } from '@/components/pipeline/custom_blocks/generated/prompt_writer'
import { exportFlow, importFlowWithReport } from '@/lib/pipeline/flow-io'
import { getBlockPickerGroups } from '@/components/pipeline/block-picker-groups'
import { getBlockDef, getStarterTypes, registerBlockDef, type BlockComponentProps } from '@/lib/pipeline/registry'
import { DEFAULT_VIDEO_SYSTEM_PROMPT } from '@/lib/prompt-writer/config'
import type { WriterProviderStatus } from '@/lib/prompt-writer/types'
import { PromptWriterBlock } from './prompt-writer-block'

// ---- fixtures --------------------------------------------------------------

const OPENROUTER_UP: WriterProviderStatus = {
  id: 'openrouter', label: 'OpenRouter', kind: 'hosted', available: true, reason: null,
  models: [
    { id: 'anthropic/claude-sonnet', name: 'Anthropic: Claude Sonnet', accepts: ['image'] },
    { id: 'x-ai/grok-4.1-fast', name: 'xAI: Grok 4.1 Fast', accepts: [] },
  ],
  models_error: null, base_url: null,
}
const OPENROUTER_NO_KEY: WriterProviderStatus = {
  ...OPENROUTER_UP, available: false, reason: 'No OpenRouter API key is saved', models: [],
}
const OPENROUTER_NO_LIST: WriterProviderStatus = {
  ...OPENROUTER_UP, models: [], models_error: 'Could not load the OpenRouter model list; type a model ID instead.',
}
const OLLAMA_UP: WriterProviderStatus = {
  id: 'ollama', label: 'Ollama', kind: 'local', available: true, reason: null,
  models: [
    { id: 'llama3.2:latest', name: 'llama3.2:latest (3.2B)', accepts: [] },
    { id: 'qwen3:8b', name: 'qwen3:8b', accepts: ['image'] },
  ],
  models_error: null, base_url: 'http://localhost:11434',
}
const OLLAMA_DOWN: WriterProviderStatus = {
  ...OLLAMA_UP, available: false, reason: 'Ollama is not running at http://localhost:11434', models: [],
}
const LMSTUDIO_EMPTY: WriterProviderStatus = {
  id: 'lmstudio', label: 'LM Studio', kind: 'local', available: false,
  reason: 'LM Studio is running but has no model loaded', models: [], models_error: null,
  base_url: 'http://localhost:1234',
}
const LMSTUDIO_DOWN: WriterProviderStatus = { ...LMSTUDIO_EMPTY, reason: 'LM Studio is not running at http://localhost:1234' }

// ---- fetch mock ------------------------------------------------------------

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface Backend {
  providers: WriterProviderStatus[]
  /** Answer for `?refresh=1`; defaults to `providers`. */
  recheck?: WriterProviderStatus[]
  generate?: (body: Record<string, unknown>, init: RequestInit | undefined) => Response | Promise<Response>
}

let backend: Backend
let fetchMock: ReturnType<typeof vi.fn>

function calls(path: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(path))
}

function generateBodies() {
  return calls('/api/blocks/prompt_writer/generate').map(([, init]) => JSON.parse(String((init as RequestInit).body)))
}

beforeEach(() => {
  sessionStorage.clear()
  Object.values(toastMocks).forEach((m) => m.mockReset())
  backend = { providers: [OPENROUTER_UP, OLLAMA_DOWN, LMSTUDIO_EMPTY] }
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/blocks/prompt_writer/providers') return json({ providers: backend.providers })
    if (url === '/api/blocks/prompt_writer/providers?refresh=1') {
      return json({ providers: backend.recheck ?? backend.providers })
    }
    if (url === '/api/blocks/prompt_writer/generate') {
      const body = JSON.parse(String(init?.body))
      return backend.generate ? backend.generate(body, init) : json({ ok: true, text: 'A red fox crosses a frozen lake at dawn.', provider: body.provider, model: body.model })
    }
    return json({ detail: `unexpected ${url}` }, 500)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ---- render helper ---------------------------------------------------------

type Execute = (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

function renderBlock(blockId = 'pw1', initialInputs: Record<string, unknown> = {}) {
  let execute: Execute | null = null
  const props: BlockComponentProps = {
    blockId,
    inputs: initialInputs,
    setOutput: vi.fn(),
    registerExecute: vi.fn((fn) => { execute = fn as Execute }),
    setStatusMessage: vi.fn(),
  }
  const user = userEvent.setup()
  const tree = (p: BlockComponentProps) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, focusThrottleInterval: 0 }}>
      <PromptWriterBlock {...p} />
    </SWRConfig>
  )
  const view = render(tree(props))
  /** New upstream values, as the pipeline passes them on a re-render. */
  const setInputs = (inputs: Record<string, unknown>) => {
    props.inputs = inputs
    view.rerender(tree({ ...props }))
  }
  // Errors are caught inside act so React flushes the error state before the test asserts.
  // The runner passes the inputs resolved at run time; by default the ones on screen.
  const run = async (signal = new AbortController().signal, inputs?: Record<string, unknown>) => {
    let failure: unknown = null
    let failed = false
    await act(async () => {
      try {
        await execute!(inputs ?? props.inputs, signal)
      } catch (err) {
        failed = true
        failure = err
      }
    })
    if (failed) throw failure
  }
  return { ...view, user, props, run, setInputs, getExecute: () => execute! }
}

async function openProviders(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('combobox', { name: 'Provider' }))
  return screen.getAllByRole('option')
}

const option = (label: string) => screen.getAllByRole('option').find((o) => o.textContent?.startsWith(label))!

async function typeIdea(user: ReturnType<typeof userEvent.setup>, text: string) {
  const idea = screen.getByLabelText('User Prompt')
  await user.clear(idea)
  await user.type(idea, text)
}

// ---- tests -----------------------------------------------------------------

describe('Prompt Writer block definition', () => {
  it('keeps the pre-fork type, output port and config keys, and adds optional media inputs and the send_media key', () => {
    expect(blockDef.type).toBe('promptWriter')
    expect(blockDef.size).toBe('lg')
    expect(blockDef.role).toBe('prompt')
    expect(blockDef.canStart).toBe(true)
    expect(blockDef.inputs).toEqual([
      { name: 'image', kind: 'image', required: false },
      { name: 'video', kind: 'video', required: false },
      { name: 'audio', kind: 'audio', required: false },
    ])
    expect(blockDef.outputs).toEqual([{ name: 'prompt', kind: 'text' }])
    expect(blockDef.configKeys).toEqual(['local_settings', 'user_prompt', 'output', 'send_media'])
    expect(blockDef.starterPrereqs).toBeUndefined()
  })

  it('is offered in the block picker as a suggested starter, under Prompts otherwise', () => {
    if (!getBlockDef('promptWriter')) registerBlockDef(blockDef)
    const starters = getStarterTypes()
    expect(starters.map((d) => d.type)).toContain('promptWriter')
    const suggested = getBlockPickerGroups(starters, { kind: 'starter' }).find((g) => g.key === 'suggested')
    expect(suggested?.items.map((i) => i.def.type)).toContain('promptWriter')
    const plain = getBlockPickerGroups(starters).find((g) => g.key === 'prompt')
    expect(plain?.items.map((i) => i.def.type)).toContain('promptWriter')
  })
})

describe('provider list', () => {
  it('shows a skeleton while checking, then every provider with unavailable ones greyed out and explained', async () => {
    const { user } = renderBlock()
    expect(screen.getByLabelText('Checking providers')).toHaveAttribute('aria-busy', 'true')
    const options = await openProviders(user)
    expect(options.map((o) => o.textContent?.split(/Local|Hosted/)[0])).toEqual(['OpenRouter', 'Ollama', 'LM Studio'])
    expect(option('OpenRouter')).not.toHaveAttribute('aria-disabled')
    const ollama = option('Ollama')
    expect(ollama).toHaveAttribute('aria-disabled', 'true')
    expect(ollama).toHaveAttribute('aria-description', 'Ollama is not running at http://localhost:11434')
    expect(ollama).toHaveTextContent('Ollama is not running at http://localhost:11434')
    expect(option('LM Studio')).toHaveAttribute('aria-description', 'LM Studio is running but has no model loaded')
  })

  it('selects the first available provider by default', async () => {
    renderBlock()
    expect(await screen.findByRole('combobox', { name: 'Provider' })).toHaveTextContent('OpenRouter')
    expect(screen.getByTestId('provider-summary')).toHaveTextContent('Available: OpenRouter')
  })

  it('never selects an unavailable provider by click or keyboard', async () => {
    const { user } = renderBlock()
    const trigger = await screen.findByRole('combobox', { name: 'Provider' })
    await openProviders(user)
    await user.click(option('Ollama'))
    expect(trigger).toHaveTextContent('OpenRouter')
    for (let i = 0; i < 4; i++) {
      if (document.querySelector('[role="option"][data-highlighted]')?.textContent?.startsWith('Ollama')) break
      await user.keyboard('{ArrowDown}')
    }
    await user.keyboard('{Enter}')
    expect(trigger).toHaveTextContent('OpenRouter')
    expect(JSON.parse(sessionStorage.getItem('block_pw1_local_settings') ?? 'null')?.provider ?? null).toBeNull()
  })

  it('makes a provider selectable after Re-check finds it running', async () => {
    backend.recheck = [OPENROUTER_UP, OLLAMA_UP, LMSTUDIO_EMPTY]
    const { user } = renderBlock()
    await user.click(await screen.findByRole('button', { name: 'Re-check' }))
    await waitFor(() => expect(screen.getByTestId('provider-summary')).toHaveTextContent('Available: OpenRouter, Ollama'))
    expect(calls('/api/blocks/prompt_writer/providers?refresh=1')).toHaveLength(1)
    await openProviders(user)
    expect(option('Ollama')).not.toHaveAttribute('aria-disabled')
    await user.click(option('Ollama'))
    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveTextContent('Ollama')
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('llama3.2:latest (3.2B)')
  })

  it('refreshes the list when the window regains focus', async () => {
    renderBlock()
    await screen.findByRole('combobox', { name: 'Provider' })
    const before = calls('/api/blocks/prompt_writer/providers').length
    backend.providers = [OPENROUTER_UP, OLLAMA_UP, LMSTUDIO_EMPTY]
    await act(async () => {
      // SWR ignores a focus in the same millisecond as the last revalidation.
      await new Promise((resolve) => setTimeout(resolve, 5))
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(calls('/api/blocks/prompt_writer/providers').length).toBeGreaterThan(before))
    await waitFor(() => expect(screen.getByTestId('provider-summary')).toHaveTextContent('Ollama'))
  })

  it('shows setup guidance instead of the form when nothing is available', async () => {
    backend.providers = [OPENROUTER_NO_KEY, OLLAMA_DOWN, LMSTUDIO_DOWN]
    const { run } = renderBlock()
    expect(await screen.findByText('Set up a model to write prompts')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings')
    expect(screen.getByText(/ollama pull llama3.2/)).toBeInTheDocument()
    expect(screen.getByText(/start the local server/)).toBeInTheDocument()
    expect(screen.getByText('Ollama is not running at http://localhost:11434.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Provider' })).not.toBeInTheDocument()
    await expect(run()).rejects.toThrow('No provider is available')
    expect(calls('/api/blocks/prompt_writer/generate')).toHaveLength(0)
  })

  it('shows an error with a retry when the provider check fails or answers oddly', async () => {
    let broken = true
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (broken) return json({ ok: true })
      return String(input).includes('/providers') ? json({ providers: backend.providers }) : json({}, 500)
    })
    const { user } = renderBlock()
    expect(await screen.findByText('Could not check the providers')).toBeInTheDocument()
    broken = false
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('combobox', { name: 'Provider' })).toBeInTheDocument()
  })
})

describe('models', () => {
  it('lists the provider models and stores the choice per provider', async () => {
    const { user } = renderBlock()
    const model = await screen.findByRole('combobox', { name: 'Model' })
    expect(model).toHaveTextContent('Choose a model')
    await user.click(model)
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('xAI: Grok'))!)
    expect(model).toHaveTextContent('xAI: Grok 4.1 Fast')
    const saved = JSON.parse(sessionStorage.getItem('block_pw1_local_settings')!)
    expect(saved.models).toEqual({ openrouter: 'x-ai/grok-4.1-fast' })
  })

  it('falls back to a model ID input when the OpenRouter list could not load', async () => {
    backend.providers = [OPENROUTER_NO_LIST, OLLAMA_DOWN, LMSTUDIO_EMPTY]
    const { user, run } = renderBlock()
    const input = await screen.findByRole('textbox', { name: 'Model ID' })
    expect(screen.getByText(/type a model ID instead/)).toBeInTheDocument()
    await user.type(input, 'openai/gpt-4o-mini')
    await typeIdea(user, 'a fox')
    await run()
    expect(generateBodies()[0].model).toBe('openai/gpt-4o-mini')
  })
})

describe('running', () => {
  it('sends the idea and style, then sets the prompt output and the result', async () => {
    backend.providers = [OPENROUTER_UP, OLLAMA_UP, LMSTUDIO_EMPTY]
    const { user, run, props } = renderBlock()
    await openProviders(user)
    await user.click(option('Ollama'))
    await typeIdea(user, 'a fox in the snow 🦊')
    await run()
    expect(generateBodies()).toEqual([{
      provider: 'ollama',
      model: 'llama3.2:latest',
      input: 'a fox in the snow 🦊',
      system_prompt: DEFAULT_VIDEO_SYSTEM_PROMPT,
      // No temperature or max tokens: Ollama uses its own settings.
    }])
    expect(props.setOutput).toHaveBeenCalledWith('prompt', 'A red fox crosses a frozen lake at dawn.')
    expect(screen.getByLabelText('Result')).toHaveValue('A red fox crosses a frozen lake at dawn.')
    expect(within(screen.getByTestId('run-status')).getByText('Done')).toBeInTheDocument()
    expect(props.setStatusMessage).toHaveBeenCalledWith('Writing the prompt…')
    // The automatically chosen model is remembered with the flow.
    expect(JSON.parse(sessionStorage.getItem('block_pw1_local_settings')!)).toMatchObject({
      provider: 'ollama', models: { ollama: 'llama3.2:latest' },
    })
  })

  it('switches the style preset and sends its instructions', async () => {
    const { user, run } = renderBlock()
    await user.click(await screen.findByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option')[0])
    await user.click(screen.getByRole('button', { name: 'Style: Video prompt' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Image prompt' }))
    await typeIdea(user, 'lighthouse')
    await run()
    expect(generateBodies()[0].system_prompt).toMatch(/^You are writing a concise visual description for AI image generation/)
  })

  it('rejects an empty idea without calling the provider', async () => {
    const { user, run } = renderBlock()
    await user.click(await screen.findByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option')[0])
    await typeIdea(user, '   ')
    await expect(run()).rejects.toThrow('Write a user prompt first.')
    expect(calls('/api/blocks/prompt_writer/generate')).toHaveLength(0)
    expect(screen.getByTestId('run-error-kind')).toHaveAttribute('data-kind', 'validation')
  })

  it.each([
    ['auth', 'The API key was rejected', 'OpenRouter rejected the API key. Check it in Settings → API keys.'],
    ['rate_limited', 'Rate limited', 'OpenRouter is rate limiting requests. Try again shortly.'],
    ['unavailable', 'The provider is not available', 'Ollama is not running at http://localhost:11434.'],
    ['model_not_found', 'Model not found', 'Model "x" is not available on OpenRouter.'],
    ['timeout', 'The model took too long', 'OpenRouter did not answer within 110 s.'],
    ['network', 'Could not connect', 'Could not reach OpenRouter.'],
    ['provider_failure', 'The provider could not write the prompt', 'OpenRouter could not complete the request.'],
    ['malformed_response', 'Unexpected answer from the provider', 'OpenRouter returned a response without any text.'],
    ['insufficient_credits', 'Not enough credits', 'Your OpenRouter account does not have enough credits.'],
  ])('shows a %s error with its title and message', async (kind, title, message) => {
    backend.generate = () => json({ ok: false, kind, message }, 502)
    const { user, run, props } = renderBlock()
    await user.click(await screen.findByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option')[0])
    await typeIdea(user, 'a fox')
    await expect(run()).rejects.toThrow(message)
    const status = screen.getByTestId('run-status')
    expect(within(status).getByText(title)).toBeInTheDocument()
    expect(within(status).getByText(message)).toBeInTheDocument()
    expect(screen.getByTestId('run-error-kind')).toHaveAttribute('data-kind', kind)
    expect(props.setOutput).not.toHaveBeenCalled()
    if (kind === 'auth') expect(within(status).getByRole('link', { name: 'Open Settings' })).toBeInTheDocument()
    if (kind === 'unavailable') expect(within(status).getByRole('button', { name: 'Re-check' })).toBeInTheDocument()
  })

  it('treats an unusable answer as malformed', async () => {
    backend.generate = () => new Response('<html>oops</html>', { status: 200 })
    const { user, run } = renderBlock()
    await user.click(await screen.findByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option')[0])
    await typeIdea(user, 'a fox')
    await expect(run()).rejects.toThrow(/unexpected answer/)
    expect(screen.getByTestId('run-error-kind')).toHaveAttribute('data-kind', 'malformed_response')
  })

  it.each([500, 502, 504])('says the backend did not answer when the proxy fails with a non-JSON HTTP %i, not that the provider did', async (status) => {
    backend.generate = () => new Response('Internal Server Error', { status })
    const { user, run } = renderBlock()
    await user.click(await screen.findByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option')[0])
    await typeIdea(user, 'a fox')
    const message = `BlockFlow's backend did not answer (HTTP ${status}). Make sure BlockFlow is running, then press Run Pipeline again.`
    await expect(run()).rejects.toThrow(message)
    expect(screen.getByTestId('run-error-kind')).toHaveAttribute('data-kind', 'network')
    expect(screen.getByText('Could not connect')).toBeInTheDocument()
    expect(screen.queryByText(/unexpected answer/)).toBeNull()
  })

  it('shows the backend timeout in plain words in the block body', async () => {
    backend.providers = [OPENROUTER_UP, OLLAMA_UP, LMSTUDIO_EMPTY]
    const message = 'Ollama did not finish writing within 600 s. Try a faster model or a shorter prompt, then run again.'
    backend.generate = () => json({ ok: false, kind: 'timeout', message }, 504)
    const { user, run } = renderBlock()
    await openProviders(user)
    await user.click(option('Ollama'))
    await typeIdea(user, 'a fox')
    await expect(run()).rejects.toThrow(message)
    expect(screen.getByTestId('run-error-kind')).toHaveAttribute('data-kind', 'timeout')
    expect(screen.getByText('The model took too long')).toBeInTheDocument()
    expect(screen.getByTestId('prompt-writer-block')).toContainElement(screen.getByTestId('run-error-kind'))
  })

  it('aborts the request when the run is cancelled', async () => {
    let seenSignal: AbortSignal | undefined
    backend.generate = (_body, init) => new Promise<Response>((_resolve, reject) => {
      seenSignal = init?.signal ?? undefined
      seenSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
    const { user, getExecute, props } = renderBlock()
    await user.click(await screen.findByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option')[0])
    await typeIdea(user, 'a fox')
    const controller = new AbortController()
    let pending!: Promise<unknown>
    act(() => { pending = getExecute()({}, controller.signal) })
    await waitFor(() => expect(seenSignal).toBeDefined())
    await act(async () => {
      controller.abort()
      await expect(pending).rejects.toThrow('Aborted')
    })
    expect(seenSignal?.aborted).toBe(true)
    expect(within(screen.getByTestId('run-status')).getByText('Cancelled')).toBeInTheDocument()
    expect(props.setOutput).not.toHaveBeenCalled()
  })

  it('does not call the provider when the signal is already aborted', async () => {
    const { user, run } = renderBlock()
    await user.click(await screen.findByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option')[0])
    await typeIdea(user, 'a fox')
    const controller = new AbortController()
    controller.abort()
    await expect(run(controller.signal)).rejects.toThrow()
    expect(calls('/api/blocks/prompt_writer/generate')).toHaveLength(0)
  })

  it('says so when the selected provider stops, keeps the text and fails fast', async () => {
    backend.providers = [OPENROUTER_UP, OLLAMA_UP, LMSTUDIO_EMPTY]
    backend.recheck = [OPENROUTER_UP, OLLAMA_DOWN, LMSTUDIO_EMPTY]
    const { user, run } = renderBlock()
    await openProviders(user)
    await user.click(option('Ollama'))
    await typeIdea(user, 'keep me')
    await user.click(screen.getByRole('button', { name: 'Re-check' }))
    expect(await screen.findByText('Ollama is not available')).toBeInTheDocument()
    expect(screen.getByText(/Your text and settings are kept/)).toBeInTheDocument()
    expect(screen.getByLabelText('User Prompt')).toHaveValue('keep me')
    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveTextContent('Ollama')
    await expect(run()).rejects.toThrow('Ollama is not running at http://localhost:11434.')
    expect(calls('/api/blocks/prompt_writer/generate')).toHaveLength(0)
  })

  it('reuses the edited result without calling the model when Keep is on', async () => {
    const { user, run, props } = renderBlock()
    await screen.findByRole('combobox', { name: 'Provider' })
    await user.type(screen.getByLabelText('Result'), 'My hand-edited prompt')
    await user.click(screen.getByRole('switch', { name: 'Keep this result on the next run' }))
    await run()
    expect(props.setOutput).toHaveBeenCalledWith('prompt', 'My hand-edited prompt')
    expect(calls('/api/blocks/prompt_writer/generate')).toHaveLength(0)
  })

  it('the Keep and Copy row is its own top-level item, spaced like every other field, not tucked into the Result field', async () => {
    renderBlock()
    await screen.findByRole('combobox', { name: 'Provider' })
    const root = screen.getByTestId('prompt-writer-block')
    const topLevel = (el: Element) => Array.from(root.children).find((child) => child.contains(el))!
    const result = topLevel(screen.getByLabelText('Result'))
    const keepRow = topLevel(screen.getByRole('switch', { name: 'Keep this result on the next run' }))
    expect(keepRow).not.toBe(result)
    expect(keepRow.contains(screen.getByRole('button', { name: 'Copy' }))).toBe(true)
    expect(result.nextElementSibling).toBe(keepRow)
  })

  it('copies the result', async () => {
    sessionStorage.setItem('block_pw1_output', JSON.stringify('Copy me'))
    const { user } = renderBlock()
    await user.click(await screen.findByRole('button', { name: 'Copy' }))
    expect(await navigator.clipboard.readText()).toBe('Copy me')
    expect(toastMocks.success).toHaveBeenCalledWith('Prompt copied.')
  })
})

describe('saved flows', () => {
  it('round-trips its config through export and import', async () => {
    if (!getBlockDef('promptWriter')) registerBlockDef(blockDef)
    backend.providers = [OPENROUTER_UP, OLLAMA_UP, LMSTUDIO_EMPTY]
    const first = renderBlock('src1')
    await openProviders(first.user)
    await first.user.click(option('Ollama'))
    await first.user.click(screen.getByRole('combobox', { name: 'Model' }))
    await first.user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('qwen3'))!)
    await typeIdea(first.user, 'round trip idea')
    const flow = exportFlow({ id: 'p', blocks: [{ id: 'src1', type: 'promptWriter' }] }, 'RT')
    first.unmount()
    sessionStorage.clear()

    const imported = importFlowWithReport(JSON.parse(JSON.stringify(flow)))
    if (!imported.ok) throw new Error(imported.error)
    const id = imported.pipeline.blocks[0].id
    renderBlock(id)
    expect(await screen.findByRole('combobox', { name: 'Provider' })).toHaveTextContent('Ollama')
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('qwen3:8b')
    expect(screen.getByLabelText('User Prompt')).toHaveValue('round trip idea')
  })

  it('restores a Prompt Writer saved before the fork', async () => {
    if (!getBlockDef('promptWriter')) registerBlockDef(blockDef)
    // Built from the original block's configKeys (40721f3:custom_blocks/prompt_writer).
    const oldFlow = {
      name: 'Pre-fork flow',
      version: 1,
      created_at: '2026-06-01T00:00:00Z',
      blocks: [{
        type: 'promptWriter',
        config: {
          local_settings: {
            mode: 'image',
            system_prompt: 'My image style',
            video_system_prompt: 'My video style',
            image_system_prompt: 'My image style',
            model: 'x-ai/grok-4.1-fast',
            temperature: 0.9,
            max_tokens: 100000,
            reasoning_effort: 'high',
          },
          variants: 2,
          num_prompts: 3,
          user_prompt: 'old idea about a lighthouse',
          extra_user_prompts: ['second idea'],
          output: 'old generated prompt',
        },
      }],
    }
    const imported = importFlowWithReport(oldFlow)
    if (!imported.ok) throw new Error(imported.error)
    expect(imported.report.unsupported).toEqual([])
    const id = imported.pipeline.blocks[0].id
    const { run, props } = renderBlock(id)
    expect(await screen.findByRole('combobox', { name: 'Provider' })).toHaveTextContent('OpenRouter')
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('xAI: Grok 4.1 Fast')
    expect(screen.getByLabelText('User Prompt')).toHaveValue('old idea about a lighthouse')
    expect(screen.getByLabelText('Result')).toHaveValue('old generated prompt')
    expect(screen.getByRole('button', { name: 'Style: Image prompt' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Temperature: 0.9' })).toBeInTheDocument()
    await run()
    expect(generateBodies()).toEqual([{
      provider: 'openrouter',
      model: 'x-ai/grok-4.1-fast',
      input: 'old idea about a lighthouse',
      system_prompt: 'My image style',
      temperature: 0.9,
      max_tokens: 100000,
    }])
    expect(props.setOutput).toHaveBeenCalledWith('prompt', 'A red fox crosses a frozen lake at dawn.')
  })
})

describe('User Prompt and System Prompt with the prompt library', () => {
  let library: Array<{ id: string; name: string; type: string; content: string; created_at: string }>

  beforeEach(() => {
    toastFn.mockReset()
    library = [
      { id: 'u1', name: 'Fox idea', type: 'user', content: 'a fox on a frozen lake', created_at: '' },
      { id: 's1', name: 'Noir', type: 'system', content: 'Write film-noir prompts.', created_at: '' },
      { id: 'g1', name: 'Gen only', type: 'generation', content: 'never here', created_at: '' },
    ]
    const base = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/prompt-library' && (init?.method ?? 'GET') === 'GET') return json({ ok: true, prompts: library })
      if (url === '/api/prompt-library' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const created = { id: `n${library.length}`, created_at: '', ...body, name: body.name.trim() }
        library = [...library, created]
        return json({ ok: true, prompt: created })
      }
      return base(input, init)
    })
  })

  const settingsOf = (id = 'pw1') => JSON.parse(sessionStorage.getItem(`block_${id}_local_settings`) ?? 'null')
  const IMAGE_DEFAULT = /^You are writing a concise visual description for AI image generation/

  it('names the fields User Prompt, System Prompt and Result; Result has no library', async () => {
    const { user } = renderBlock()
    expect(await screen.findByLabelText('User Prompt')).toBeInTheDocument()
    expect(screen.getByLabelText('Result')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saved user prompts' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saved system prompts' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Saved generation prompts' })).toBeNull()
    expect(screen.queryByText('Idea')).toBeNull()
    expect(screen.queryByText(/Style instructions/)).toBeNull()
    await user.click(screen.getByRole('button', { name: /^System Prompt/ }))
    expect(screen.getByLabelText('System Prompt')).toHaveValue(DEFAULT_VIDEO_SYSTEM_PROMPT)
  })

  it('the User Prompt library lists user prompts only and replaces the text', async () => {
    const { user } = renderBlock()
    await screen.findByRole('combobox', { name: 'Model' })
    await typeIdea(user, 'my draft')
    await user.click(screen.getByRole('button', { name: 'Saved user prompts' }))
    const dialog = await screen.findByRole('dialog', { name: 'Saved user prompts' })
    await user.click(await within(dialog).findByRole('button', { name: /^Use Fox idea/ }))
    expect(screen.getByLabelText('User Prompt')).toHaveValue('a fox on a frozen lake')
    expect(JSON.parse(sessionStorage.getItem('block_pw1_user_prompt')!)).toBe('a fox on a frozen lake')
    await user.click(screen.getByRole('button', { name: 'Saved user prompts' }))
    const again = await screen.findByRole('dialog', { name: 'Saved user prompts' })
    expect(within(again).queryByRole('button', { name: /^Use Noir/ })).toBeNull()
    expect(within(again).queryByRole('button', { name: /^Use Gen only/ })).toBeNull()
  })

  it('saves the active mode system prompt as a system prompt', async () => {
    const { user } = renderBlock()
    await user.click(await screen.findByRole('button', { name: 'Style: Video prompt' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Image prompt' }))
    await user.click(screen.getByRole('button', { name: 'Saved system prompts' }))
    const dialog = await screen.findByRole('dialog', { name: 'Saved system prompts' })
    await within(dialog).findByRole('button', { name: /^Use Noir/ })
    await user.type(within(dialog).getByLabelText('Name'), 'My image style')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await within(dialog).findByRole('button', { name: /^Use My image style/ })
    const post = fetchMock.mock.calls.find(([u, init]) => String(u) === '/api/prompt-library' && (init as RequestInit)?.method === 'POST')!
    const body = JSON.parse(String((post[1] as RequestInit).body))
    expect(body).toMatchObject({ type: 'system', name: 'My image style' })
    expect(body.content).toMatch(IMAGE_DEFAULT)
  })

  it('using a system prompt replaces only the active mode and shows it; Undo after a mode switch restores that mode', async () => {
    const { user, run } = renderBlock()
    await user.click(await screen.findByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option')[0])
    await user.click(screen.getByRole('button', { name: 'Saved system prompts' }))
    const dialog = await screen.findByRole('dialog', { name: 'Saved system prompts' })
    await user.click(await within(dialog).findByRole('button', { name: /^Use Noir/ }))
    // The collapsed box opens so the replaced text is visible.
    expect(screen.getByLabelText('System Prompt')).toHaveValue('Write film-noir prompts.')
    expect(settingsOf().video_system_prompt).toBe('Write film-noir prompts.')
    expect(settingsOf().image_system_prompt).toMatch(IMAGE_DEFAULT)

    await user.click(screen.getByRole('button', { name: 'Style: Video prompt' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Image prompt' }))
    const [, options] = toastFn.mock.calls.at(-1)!
    act(() => (options.action.onClick as () => void)())
    expect(settingsOf().video_system_prompt).toBe(DEFAULT_VIDEO_SYSTEM_PROMPT)
    expect(settingsOf().image_system_prompt).toMatch(IMAGE_DEFAULT)
    expect(settingsOf().mode).toBe('image')

    await typeIdea(user, 'lighthouse')
    await run()
    expect(generateBodies()[0].system_prompt).toMatch(IMAGE_DEFAULT)
  })
})

// ---- media from upstream ---------------------------------------------------

const IMG_A = { kind: 'image-ref', local: '/outputs/media/a.png', label: 'a.png', width: 64, height: 64 }
const IMG_B = { kind: 'image-ref', local: '/outputs/media/b%C3%BC.png', label: 'bü.png' }
const VID = { kind: 'video-ref', local: '/outputs/media/clip.mp4', label: 'clip.mp4', duration_s: 4 }
const AUD = { kind: 'audio-ref', local: '/outputs/media/voice.mp3', label: 'voice.mp3' }

async function chooseModel(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('combobox', { name: 'Model' }))
  await user.click(option(name))
}

const sendGroup = () => screen.queryByRole('group', { name: 'Send to the model' })

describe('sending upstream media to the model', () => {
  it('shows no Send group with nothing upstream, and the block still runs as a first block', async () => {
    const { user, run } = renderBlock()
    await chooseModel(user, 'Anthropic')
    expect(sendGroup()).toBeNull()
    await typeIdea(user, 'a fox')
    await run()
    expect(generateBodies()[0]).not.toHaveProperty('media')
  })

  it('shows one unticked box per kind upstream, with counts, and none for kinds not upstream', async () => {
    renderBlock('pw1', { image: [IMG_A, IMG_B], video: VID })
    await screen.findByRole('combobox', { name: 'Model' })
    const group = sendGroup()!
    expect(within(group).getAllByRole('checkbox')).toHaveLength(2)
    expect(within(group).getByRole('checkbox', { name: 'Images (2)' })).not.toBeChecked()
    expect(within(group).getByRole('checkbox', { name: 'Videos (1)' })).not.toBeChecked()
    expect(within(group).queryByRole('checkbox', { name: /Audio/ })).toBeNull()
  })

  it('is one top-level item of the block (the body sets the gap)', async () => {
    renderBlock('pw1', { image: IMG_A })
    await screen.findByRole('combobox', { name: 'Model' })
    const root = screen.getByTestId('prompt-writer-block')
    expect(Array.from(root.children)).toContain(sendGroup())
  })

  it('saves the ticks with the flow, and sends the ticked kinds read from the run-time inputs', async () => {
    const { user, run } = renderBlock('pw1', { image: IMG_A, video: VID })
    await chooseModel(user, 'Anthropic')
    await user.click(screen.getByRole('checkbox', { name: 'Images (1)' }))
    expect(JSON.parse(sessionStorage.getItem('block_pw1_send_media')!)).toEqual({ image: true, video: false, audio: false })
    await typeIdea(user, 'describe it')
    // The runner resolves fresh inputs: two images now, plus a video that is not ticked.
    await run(undefined, { image: [IMG_A, IMG_B], video: VID })
    expect(generateBodies()[0].media).toEqual([
      { kind: 'image', role: 'reference', local: '/outputs/media/a.png', width: 64, height: 64 },
      { kind: 'image', role: 'reference', local: '/outputs/media/b%C3%BC.png' },
    ])
  })

  it('a flow saved before the boxes existed loads with them unticked and sends nothing', async () => {
    sessionStorage.setItem('block_pw1_local_settings', JSON.stringify({ provider: 'openrouter', models: { openrouter: 'anthropic/claude-sonnet' } }))
    sessionStorage.setItem('block_pw1_user_prompt', JSON.stringify('old idea'))
    const { run } = renderBlock('pw1', { image: IMG_A })
    expect(await screen.findByRole('checkbox', { name: 'Images (1)' })).not.toBeChecked()
    await run()
    expect(generateBodies()[0]).not.toHaveProperty('media')
  })

  it('round-trips the ticks through flow export and import', async () => {
    if (!getBlockDef('promptWriter')) registerBlockDef(blockDef)
    const first = renderBlock('src1', { video: VID })
    await first.user.click(await screen.findByRole('checkbox', { name: 'Videos (1)' }))
    const flow = exportFlow({ id: 'p', blocks: [{ id: 'src1', type: 'promptWriter' }] }, 'RT')
    first.unmount()
    sessionStorage.clear()
    const imported = importFlowWithReport(JSON.parse(JSON.stringify(flow)))
    if (!imported.ok) throw new Error(imported.error)
    renderBlock(imported.pipeline.blocks[0].id, { video: VID })
    expect(await screen.findByRole('checkbox', { name: 'Videos (1)' })).toBeChecked()
  })

  it('greys out models that do not take a ticked kind, with the reason', async () => {
    const { user } = renderBlock('pw1', { image: IMG_A })
    await screen.findByRole('combobox', { name: 'Model' })
    await user.click(screen.getByRole('checkbox', { name: 'Images (1)' }))
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    expect(option('Anthropic')).not.toHaveAttribute('aria-disabled')
    expect(option('xAI')).toHaveAttribute('aria-disabled', 'true')
    expect(option('xAI')).toHaveAttribute('aria-description', 'Does not accept images')
    await user.click(option('xAI'))
    expect(screen.getByRole('combobox', { name: 'Model' })).not.toHaveTextContent('xAI')
  })

  it('keeps the selected model when it cannot take a ticked kind, blocks the run with a readable error, and unticking clears it', async () => {
    const { user, run } = renderBlock('pw1', { image: IMG_A })
    await chooseModel(user, 'xAI')
    await typeIdea(user, 'a fox')
    await user.click(screen.getByRole('checkbox', { name: 'Images (1)' }))
    const message = 'xAI: Grok 4.1 Fast does not accept images. Pick a model that accepts images, or untick Images.'
    expect(screen.getByTestId('media-blocker')).toHaveTextContent(message)
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('xAI: Grok 4.1 Fast')
    await expect(run()).rejects.toThrow(message)
    expect(calls('/api/blocks/prompt_writer/generate')).toHaveLength(0)

    await user.click(screen.getByRole('checkbox', { name: 'Images (1)' }))
    expect(screen.queryByTestId('media-blocker')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('xAI: Grok 4.1 Fast')
    await run()
    expect(generateBodies()).toHaveLength(1)
  })

  it('says plainly when no model of a local provider takes the ticked kind', async () => {
    backend.providers = [OPENROUTER_UP, OLLAMA_UP, LMSTUDIO_EMPTY]
    const { user, run } = renderBlock('pw1', { video: VID, audio: AUD })
    await openProviders(user)
    await user.click(option('Ollama'))
    await user.click(screen.getByRole('checkbox', { name: 'Videos (1)' }))
    const message = 'No Ollama model accepts videos. Untick Videos, or choose OpenRouter and a model that accepts videos.'
    expect(screen.getByTestId('media-blocker')).toHaveTextContent(message)
    await typeIdea(user, 'a fox')
    await expect(run()).rejects.toThrow(message)
    expect(calls('/api/blocks/prompt_writer/generate')).toHaveLength(0)
  })

  it('a file that was never saved locally fails the run with a readable message', async () => {
    const { user, run } = renderBlock('pw1', { image: IMG_A })
    await chooseModel(user, 'Anthropic')
    await user.click(screen.getByRole('checkbox', { name: 'Images (1)' }))
    await typeIdea(user, 'a fox')
    await expect(run(undefined, { image: { kind: 'image-ref', url: 'https://example.com/x.png', label: 'x.png' } }))
      .rejects.toThrow('x.png is not saved in BlockFlow. Add it again in the block that loads it.')
    expect(calls('/api/blocks/prompt_writer/generate')).toHaveLength(0)
  })

  it('shows the backend refusal of a deleted file as a validation error', async () => {
    backend.generate = () => json({ ok: false, kind: 'validation', message: 'a.png no longer exists. Add it again in the block that loads it.' }, 422)
    const { user, run } = renderBlock('pw1', { image: IMG_A })
    await chooseModel(user, 'Anthropic')
    await user.click(screen.getByRole('checkbox', { name: 'Images (1)' }))
    await typeIdea(user, 'a fox')
    await expect(run()).rejects.toThrow('a.png no longer exists.')
    expect(screen.getByTestId('run-error-kind')).toHaveAttribute('data-kind', 'validation')
  })

  it('cancelling aborts a request that carries media', async () => {
    let seenSignal: AbortSignal | undefined
    backend.generate = (_body, init) => new Promise<Response>((_resolve, reject) => {
      seenSignal = init?.signal ?? undefined
      seenSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
    const { user, getExecute, props } = renderBlock('pw1', { image: IMG_A })
    await chooseModel(user, 'Anthropic')
    await user.click(screen.getByRole('checkbox', { name: 'Images (1)' }))
    await typeIdea(user, 'a fox')
    const controller = new AbortController()
    let pending!: Promise<unknown>
    act(() => { pending = getExecute()({ image: IMG_A }, controller.signal) })
    await waitFor(() => expect(seenSignal).toBeDefined())
    expect(generateBodies()[0].media).toHaveLength(1)
    await act(async () => {
      controller.abort()
      await expect(pending).rejects.toThrow('Aborted')
    })
    expect(seenSignal?.aborted).toBe(true)
    expect(within(screen.getByTestId('run-status')).getByText('Cancelled')).toBeInTheDocument()
    expect(props.setOutput).not.toHaveBeenCalled()
  })

  it('hides a ticked kind that is no longer upstream and stops filtering by it', async () => {
    const { user, setInputs } = renderBlock('pw1', { image: IMG_A })
    await chooseModel(user, 'xAI')
    await user.click(screen.getByRole('checkbox', { name: 'Images (1)' }))
    expect(screen.getByTestId('media-blocker')).toBeInTheDocument()
    act(() => setInputs({}))
    expect(sendGroup()).toBeNull()
    expect(screen.queryByTestId('media-blocker')).toBeNull()
  })
})

// ---- sampling settings for local providers ---------------------------------

describe('temperature and max tokens', () => {
  const chip = (name: RegExp) => screen.queryByRole('button', { name })

  it('shows them for OpenRouter, hides them for local providers at once, and keeps the saved values', async () => {
    backend.providers = [OPENROUTER_UP, OLLAMA_UP, LMSTUDIO_EMPTY]
    sessionStorage.setItem('block_pw1_local_settings', JSON.stringify({ temperature: 1.2, max_tokens: 900 }))
    const { user } = renderBlock()
    expect(await screen.findByRole('button', { name: 'Temperature: 1.2' })).toBeInTheDocument()
    expect(chip(/^Max tokens/)).toBeInTheDocument()
    await openProviders(user)
    await user.click(option('Ollama'))
    expect(chip(/^Temperature/)).toBeNull()
    expect(chip(/^Max tokens/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Style: Video prompt' })).toBeInTheDocument()
    expect(screen.getByText(/set in Ollama/)).toBeInTheDocument()
    await openProviders(user)
    await user.click(option('OpenRouter'))
    expect(screen.getByRole('button', { name: 'Temperature: 1.2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Max tokens: 900' })).toBeInTheDocument()
  })

  it('an old flow with saved values and a local provider runs without sending them', async () => {
    backend.providers = [OPENROUTER_UP, OLLAMA_UP, LMSTUDIO_EMPTY]
    sessionStorage.setItem('block_pw1_local_settings', JSON.stringify({
      provider: 'ollama', models: { ollama: 'qwen3:8b' }, temperature: 1.4, max_tokens: 5000,
    }))
    sessionStorage.setItem('block_pw1_user_prompt', JSON.stringify('old idea'))
    const { run } = renderBlock()
    expect(await screen.findByRole('combobox', { name: 'Provider' })).toHaveTextContent('Ollama')
    await run()
    const body = generateBodies()[0]
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).toMatchObject({ provider: 'ollama', model: 'qwen3:8b', input: 'old idea' })
    expect(JSON.parse(sessionStorage.getItem('block_pw1_local_settings')!)).toMatchObject({ temperature: 1.4, max_tokens: 5000 })
  })
})
