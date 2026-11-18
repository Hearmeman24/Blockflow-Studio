import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NodeTypeDef } from '@/lib/pipeline/registry'
import type { BlockRole } from '@/lib/pipeline/block-role'
import { AddBlockButton } from './add-block-button'

function block(
  type: string,
  label: string,
  description: string,
  role?: BlockRole,
): NodeTypeDef {
  return {
    type,
    label,
    description,
    size: 'sm',
    ...(role ? { role } : {}),
    canStart: true,
    inputs: [],
    outputs: [],
  }
}

describe('AddBlockButton grouped picker', () => {
  it('renders a compact categorized menu with Suggested pinned first', async () => {
    const user = userEvent.setup()
    render(
      <AddBlockButton
        upstreamType="uploadImageToTmpfiles"
        onAdd={vi.fn()}
        validTypes={[
          block('audioViewer', 'Audio Viewer', 'Play audio from upstream blocks.', 'loader'),
          block('videoLoader', 'Video Loader', 'Load a video file and pass it downstream.', 'loader'),
          block('promptFromTxt', 'Prompt From TXT', 'Read prompts from a text file.', 'prompt'),
          block(
            'uploadImageToTmpfiles',
            'Upload Image',
            'Upload one or more images saved locally and to a public URL for remote endpoints automatically.',
            'loader',
          ),
          block('imageViewer', 'Image Viewer', 'View image outputs inline.', 'image'),
          block('textToImage', 'Text to Image', 'Generate an image.', 'image'),
          block('videoViewer', 'Video Viewer', 'Watch videos.', 'video'),
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /add block/i }))
    const menu = screen.getByRole('menu')

    expect(menu).toHaveClass('w-[min(440px,calc(100vw-2rem))]')

    const headings = within(menu).getAllByTestId('block-picker-group-label')
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'Suggested',
      'Image',
      'Video',
      'Loaders',
      'Prompts',
    ])
    // Each role section header is tinted in its role; Suggested is neutral.
    expect(headings.map((heading) => heading.getAttribute('data-role'))).toEqual([
      null,
      'image',
      'video',
      'loader',
      'prompt',
    ])

    const description = within(menu).getByText(/public URL for remote endpoints/i)
    expect(description).toHaveClass('line-clamp-2')

    expect(within(menu).getByText('Image Viewer')).toBeInTheDocument()
    expect(within(menu).getByText('Suggested')).toBeInTheDocument()
  })

  it('renders starter suggestions for an empty pipeline picker', async () => {
    const user = userEvent.setup()
    render(
      <AddBlockButton
        suggestionContext={{ kind: 'starter' }}
        onAdd={vi.fn()}
        validTypes={[
          block('promptFromTxt', 'Prompt From TXT', 'Read prompts from a text file.'),
          block('videoLoader', 'Video Loader', 'Load a video file and pass it downstream.'),
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /add block/i }))
    const menu = screen.getByRole('menu')

    const headings = within(menu).getAllByTestId('block-picker-group-label')
    expect(headings.map((heading) => heading.textContent)).toEqual(['Suggested'])
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Video LoaderLoad a video file and pass it downstream.',
      'Prompt From TXTRead prompts from a text file.',
    ])
  })

  it('filters visible block rows from the search field', async () => {
    const user = userEvent.setup()
    render(
      <AddBlockButton
        onAdd={vi.fn()}
        validTypes={[
          block('videoLoader', 'Video Loader', 'Load a video file and pass it downstream.'),
          block('promptFromTxt', 'Prompt From TXT', 'Read prompts from a text file.'),
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /add block/i }))
    const menu = screen.getByRole('menu')

    await user.type(within(menu).getByPlaceholderText('Search blocks...'), 'prompt')

    expect(within(menu).getByText('Prompt From TXT')).toBeInTheDocument()
    expect(within(menu).queryByText('Video Loader')).not.toBeInTheDocument()
  })

  it('marks every row with its own role, Suggested rows included, through a role icon tile', async () => {
    const user = userEvent.setup()
    render(
      <AddBlockButton
        suggestionContext={{ kind: 'starter' }}
        onAdd={vi.fn()}
        validTypes={[
          block('promptFromTxt', 'Prompt From TXT', 'Read prompts from a text file.', 'prompt'),
          block('videoLoader', 'Video Loader', 'Load a video file.', 'loader'),
          block('imageViewer', 'Image Viewer', 'View images.', 'image'),
          block('videoViewer', 'Video Viewer', 'Watch videos.', 'video'),
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /add block/i }))
    const menu = screen.getByRole('menu')
    const rows = within(menu).getAllByRole('menuitem')
    const expected = [
      ['Video Loader', 'loader'],
      ['Prompt From TXT', 'prompt'],
      ['Image Viewer', 'image'],
      ['Video Viewer', 'video'],
    ]
    expect(rows).toHaveLength(expected.length)
    rows.forEach((row, i) => {
      expect(row.textContent).toContain(expected[i][0])
      expect(row).toHaveAttribute('data-role', expected[i][1])
    })
    for (const row of rows) {
      const tile = row.querySelector('[data-slot="block-role-tile"]')
      expect(tile).not.toBeNull()
      expect(tile).toHaveAttribute('data-role', row.getAttribute('data-role'))
      expect(tile?.querySelector('svg')).not.toBeNull()
    }
  })
})
