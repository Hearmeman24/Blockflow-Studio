import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { JobSnapshot } from '@/lib/types'
import { McpJobTile, isActiveJob, jobAspect } from './mcp-job-tile'

function job(over: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    job_id: 'j1', source: 'mcp', provider: 'kie', model: 'seedream-5.5', mode: 'text_to_image', status: 'RUNNING',
    remote_job_id: 'r1', remote_status: 'generating', progress: null, message: null, error: null, outputs: [],
    request: { prompt: 'a red fox in the snow', aspect_ratio: '16:9' },
    created_at: Date.now() / 1000 - 5, updated_at: Date.now() / 1000, completed_at: null, cancel_requested: false,
    ...over,
  }
}

describe('isActiveJob', () => {
  it('treats QUEUED and RUNNING as active and terminal statuses as inactive', () => {
    expect(isActiveJob(job({ status: 'RUNNING' }))).toBe(true)
    expect(isActiveJob(job({ status: 'QUEUED' }))).toBe(true)
    for (const s of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const) expect(isActiveJob(job({ status: s }))).toBe(false)
  })
})

describe('jobAspect', () => {
  it("reserves the requested aspect ratio, square otherwise", () => {
    expect(jobAspect(job())).toBeCloseTo(16 / 9)
    expect(jobAspect(job({ request: {} }))).toBe(1)
  })
})

describe('McpJobTile', () => {
  it('shows progress and the model as a gallery tile', () => {
    render(<McpJobTile job={job({ progress: 0.42 })} />)
    const tile = screen.getByRole('status', { name: 'Generating with seedream-5.5' })
    expect(tile).toHaveTextContent('42%')
    expect(tile).toHaveTextContent('seedream-5.5')
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('says "Generating" while progress is unknown', () => {
    render(<McpJobTile job={job()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Generating')
  })

  it('shows the first output once one exists', () => {
    render(<McpJobTile job={job({ outputs: [{ kind: 'image', url: 'https://cdn/a.png', local_url: '/outputs/a.png' }] })} />)
    expect(screen.getByRole('img', { name: 'a red fox in the snow' })).toHaveAttribute('src', '/outputs/a.png')
  })
})
