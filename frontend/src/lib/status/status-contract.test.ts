/**
 * The frontend status vocabularies must equal the backend's
 * (`backend/statuses.py`), through the generated fixture. Regenerate the
 * fixture with `uv run python tests/test_status_contract_fixture.py`.
 */
import { describe, expect, it } from 'vitest'
import contract from './__fixtures__/status-contract.json'
import {
  ACTIVE_GENERATION_RUN_STATUSES,
  ACTIVE_JOB_STATUSES,
  ACTIVE_UPDATE_STATES,
  ASSET_STORAGE_MODES,
  BALANCE_STATUSES,
  BLOCK_STATUSES,
  FINISHED_UPDATE_STATES,
  GENERATION_RUN_STATUSES,
  GENERATION_RUN_STATUS_BY_JOB,
  GENERATION_RUN_STATUS_LABEL,
  JOB_STATUSES,
  REFERENCE_HEALTH_STATUSES,
  RUN_STATUSES,
  SAVED_BLOCK_STATUSES,
  TERMINAL_JOB_STATUSES,
  UPDATE_STATES,
  UPDATE_STEP_STATUSES,
  runStatusBadge,
} from '.'
import * as types from '@/lib/types'
import * as settingsClient from '@/lib/settings/client'

/** Fixture key -> the frontend list that must equal it. */
const MIRRORED: Record<string, readonly string[]> = {
  job_status: JOB_STATUSES,
  job_status_active: ACTIVE_JOB_STATUSES,
  job_status_terminal: TERMINAL_JOB_STATUSES,
  run_status: RUN_STATUSES,
  block_result_status: SAVED_BLOCK_STATUSES,
  update_state: UPDATE_STATES,
  update_state_active: ACTIVE_UPDATE_STATES,
  update_state_finished: FINISHED_UPDATE_STATES,
  update_step_status: UPDATE_STEP_STATUSES,
  storage_mode: ASSET_STORAGE_MODES,
  balance_status: BALANCE_STATUSES,
  reference_check_status: REFERENCE_HEALTH_STATUSES,
}

/** Backend vocabularies the frontend does not declare (it only shows the text). */
const BACKEND_ONLY = ['error_kind', 'price_refresh_status']

describe('status contract', () => {
  it.each(Object.keys(MIRRORED))('%s equals the backend list', (key) => {
    expect([...MIRRORED[key]]).toEqual((contract as Record<string, string[]>)[key])
  })

  it('every backend vocabulary is either mirrored or listed as backend-only', () => {
    expect(Object.keys(contract).sort()).toEqual([...Object.keys(MIRRORED), ...BACKEND_ONLY].sort())
  })

  it('the old export locations still expose the same lists', () => {
    expect(types.TERMINAL_STATUSES).toEqual(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])
    expect(types.ACTIVE_STATUSES).toEqual(['QUEUED', 'RUNNING'])
    expect(settingsClient.ASSET_STORAGE_MODES).toEqual(['local_only', 'tmpfiles'])
  })
})

describe('frontend-only vocabularies', () => {
  it('a live block status is a saved block status without "cancelled"', () => {
    expect(BLOCK_STATUSES).toEqual(['idle', 'running', 'completed', 'error', 'skipped'])
    expect(SAVED_BLOCK_STATUSES.filter((s) => s !== 'cancelled')).toEqual([...BLOCK_STATUSES])
  })

  it('generation run statuses, their job mapping and labels keep their exact text', () => {
    expect(GENERATION_RUN_STATUSES).toEqual([
      'validating', 'submitting', 'queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out',
    ])
    expect(ACTIVE_GENERATION_RUN_STATUSES).toEqual(['validating', 'submitting', 'queued', 'running'])
    expect(GENERATION_RUN_STATUS_BY_JOB).toEqual({
      QUEUED: 'queued', RUNNING: 'running', COMPLETED: 'completed',
      FAILED: 'failed', CANCELLED: 'cancelled', TIMED_OUT: 'timed_out',
    })
    expect(Object.keys(GENERATION_RUN_STATUS_BY_JOB)).toEqual([...JOB_STATUSES])
    expect(GENERATION_RUN_STATUS_LABEL).toEqual({
      validating: 'Checking the request…',
      submitting: 'Submitting…',
      queued: 'Queued',
      running: 'Running…',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
      timed_out: 'Timed out',
    })
  })

  it('run status badges: none for completed or unknown values, the old text otherwise', () => {
    expect(runStatusBadge('completed')).toBeNull()
    expect(runStatusBadge('partial')).toEqual({ label: 'Partial', tone: 'warning' })
    expect(runStatusBadge('failed')).toEqual({ label: 'Failed', tone: 'error' })
    for (const odd of ['', 'cancelled', 'FAILED', 'constructor', 'toString', '__proto__']) {
      expect(runStatusBadge(odd)).toBeNull()
    }
  })
})
