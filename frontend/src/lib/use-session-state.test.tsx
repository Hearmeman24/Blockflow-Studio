import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import { useSessionState, useSessionValues } from './use-session-state'

beforeEach(() => sessionStorage.clear())

describe('useSessionState', () => {
  it('persists the value as JSON', () => {
    const { result } = renderHook(() => useSessionState('k1', 'a'))
    act(() => result.current[1]('b'))
    expect(sessionStorage.getItem('k1')).toBe('"b"')
  })
})

describe('useSessionValues', () => {
  function Writer() {
    const [value, setValue] = useSessionState<string | null>('block_x_model', null)
    return <button type="button" onClick={() => setValue('kling')}>{value ?? 'none'}</button>
  }
  function Reader() {
    const [model, provider] = useSessionValues(['block_x_model', 'block_x_provider'])
    return <p data-testid="read">{`${String(model)}|${String(provider)}`}</p>
  }

  it('reads parsed values, null when unset', () => {
    sessionStorage.setItem('block_x_provider', JSON.stringify('kie'))
    render(<Reader />)
    expect(screen.getByTestId('read')).toHaveTextContent('null|kie')
  })

  it('updates live when another component writes the key', () => {
    render(<><Writer /><Reader /></>)
    act(() => screen.getByRole('button').click())
    expect(screen.getByTestId('read')).toHaveTextContent('kling|null')
  })

  it('treats unparsable stored values as null', () => {
    sessionStorage.setItem('block_x_model', '{oops')
    render(<Reader />)
    expect(screen.getByTestId('read')).toHaveTextContent('null|null')
  })
})
