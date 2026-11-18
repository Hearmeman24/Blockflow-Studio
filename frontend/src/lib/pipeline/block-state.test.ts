import { describe, expect, it } from 'vitest'
import { INTERRUPTED_RUN_MESSAGE, blockStateWith, interruptRunningBlocks, sanitizeBlockState } from './block-state'
import type { BlockState } from './types'

describe('blockStateWith', () => {
  it('keeps error text only on an error status', () => {
    expect(blockStateWith('error', {}, 'boom')).toEqual({ status: 'error', outputs: {}, error: 'boom' })
    expect(blockStateWith('completed', { a: 1 }, 'stale')).toEqual({ status: 'completed', outputs: { a: 1 } })
    expect(blockStateWith('idle', {}, undefined, 'note')).toEqual({ status: 'idle', outputs: {}, statusMessage: 'note' })
  })
})

describe('sanitizeBlockState', () => {
  it('loads a known status as it is and an unknown one as idle, keeping the outputs', () => {
    expect(sanitizeBlockState({ status: 'cancelled', outputs: { a: 1 } })).toEqual({ status: 'cancelled', outputs: { a: 1 } })
    expect(sanitizeBlockState({ status: 'paused', outputs: { a: 1 } })).toEqual({ status: 'idle', outputs: { a: 1 } })
    expect(sanitizeBlockState({ status: 7, outputs: {} })).toEqual({ status: 'idle', outputs: {} })
    expect(sanitizeBlockState({ outputs: {}, statusMessage: 'hi', error: 'x' })).toEqual({ status: 'idle', outputs: {}, statusMessage: 'hi' })
  })

  it('rejects what is not a block state', () => {
    for (const odd of [null, undefined, 'running', 3, [], {}, { status: 'idle' }, { status: 'idle', outputs: [] }, { status: 'idle', outputs: 'x' }]) {
      expect(sanitizeBlockState(odd)).toBeNull()
    }
  })
})

describe('interruptRunningBlocks', () => {
  const states = (): Map<string, BlockState> => new Map<string, BlockState>([
    ['a', { status: 'completed', outputs: { image: 'x' } }],
    ['b', { status: 'running', outputs: { image: 'y' }, statusMessage: 'Running 40%' }],
  ])

  it('ends a running block idle with the interrupted message, or cancelled', () => {
    expect(interruptRunningBlocks(states(), 'interrupted').get('b')).toEqual({ status: 'idle', outputs: { image: 'y' }, statusMessage: INTERRUPTED_RUN_MESSAGE })
    expect(interruptRunningBlocks(states(), 'cancelled').get('b')).toEqual({ status: 'cancelled', outputs: { image: 'y' } })
    expect(interruptRunningBlocks(states(), 'cancelled').get('a')).toEqual({ status: 'completed', outputs: { image: 'x' } })
  })

  it('returns the same map when nothing is running', () => {
    const idle = new Map<string, BlockState>([['a', { status: 'idle', outputs: {} }]])
    expect(interruptRunningBlocks(idle, 'interrupted')).toBe(idle)
  })
})
