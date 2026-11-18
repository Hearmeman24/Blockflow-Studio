/**
 * The "Use the upstream prompt" switch follows the upstream prompt source:
 * no source -> a source turns it on, a source -> none turns it off, and a
 * choice the user makes in between is kept.
 */
import { describe, expect, it } from 'vitest'
import { initialSeenSource, nextUpstreamChoice } from './upstream-prompt-choice'

describe('nextUpstreamChoice', () => {
  it.each([
    // [switch now, had a source, has a source, switch after]
    [false, false, true, true], // a source appears: on
    [true, false, true, true], // already on (stored choice): still on
    [true, true, false, false], // the source goes away: off
    [false, true, false, false], // turned off by the user, source goes away: off
    [false, true, true, false], // the user turned it off while a source is wired: kept
    [true, true, true, true], // the user turned it on: kept
    [false, false, false, false], // no source, nothing changes
    [true, false, false, true], // no source, a stored "on" is kept
  ])('switch %s, source %s -> %s: %s', (current, hadSource, hasSource, expected) => {
    expect(nextUpstreamChoice(current, hadSource, hasSource)).toBe(expected)
  })
})

describe('initialSeenSource', () => {
  it('a stored choice (reload, flow load) counts as having seen the source already: no transition at mount', () => {
    expect(initialSeenSource(true, true)).toBe(true)
    expect(initialSeenSource(true, false)).toBe(false)
  })

  it('without a stored choice the block starts as having seen no source, so a wired source turns it on', () => {
    expect(initialSeenSource(false, true)).toBe(false)
    expect(initialSeenSource(false, false)).toBe(false)
    expect(nextUpstreamChoice(false, initialSeenSource(false, true), true)).toBe(true)
  })
})
