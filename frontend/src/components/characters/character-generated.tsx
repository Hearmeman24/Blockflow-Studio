'use client'

/**
 * Everything made with one character, newest first: the Artifacts page's own
 * masonry grid, tiles and viewer over `useCharacterRuns`, so opening,
 * favouriting and restoring a run behave as they do there.
 */
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Sparkles } from 'lucide-react'
import { AlertPanel } from '@/components/alert-panel'
import { EmptyState } from '@/components/empty-state'
import { ArtifactTile } from '@/components/artifacts/artifact-tile'
import { ArtifactViewer } from '@/components/artifacts/artifact-viewer'
import { MasonryGrid, type MasonryItem } from '@/components/artifacts/masonry-grid'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { runAspect } from '@/lib/artifacts/run-media'
import type { CharacterRunsState } from '@/lib/characters/use-character-runs'
import type { Character } from '@/lib/characters/types'

/** Mixed shapes, so the skeleton reads as a masonry grid. */
const SKELETON_ASPECTS = [0.8, 1.25, 1, 0.75, 1.5, 1, 0.8, 1.33]
export const GALLERY_SKELETON: MasonryItem[] = SKELETON_ASPECTS.map((aspect, i) => ({
  key: `skeleton-${i}`,
  aspect,
  render: () => <Skeleton data-testid="gallery-skeleton" className="size-full rounded-lg" />,
}))

export function artifactsHref(characterId: string): string {
  return `/artifacts?${new URLSearchParams({ character: characterId })}`
}

export function CharacterGenerated({ character, runs: state }: { character: Character; runs: CharacterRunsState }) {
  const { runs, isLoading, isLoadingMore, error, retry, loadMore, hasMore, refresh } = state
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const shownIndex = viewerIndex !== null && viewerIndex < runs.length ? viewerIndex : null

  const tiles: MasonryItem[] = useMemo(() => runs.map((run, i): MasonryItem => ({
    key: `run-${run.id}`,
    aspect: runAspect(run),
    render: ({ reportAspect }) => (
      <ArtifactTile run={run} onAspect={reportAspect} onFavoriteToggled={refresh} onOpen={() => setViewerIndex(i)} />
    ),
  })), [runs, refresh])

  let body
  if (isLoading) {
    body = <MasonryGrid items={GALLERY_SKELETON} label="Loading generated media" />
  } else if (error && runs.length === 0) {
    body = (
      <div className="mx-auto max-w-md space-y-3 py-8">
        <AlertPanel variant="error" title="Could not load what was made with this character">{error.message}</AlertPanel>
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="sm" onClick={retry}>Retry</Button>
        </div>
      </div>
    )
  } else if (runs.length === 0) {
    body = (
      <EmptyState
        icon={Sparkles}
        title={`Nothing made with ${character.name} yet`}
        description="Add a Load Character block to a flow and run it. Everything it makes shows up here."
        action={(
          <Button asChild variant="outline" size="sm">
            <Link href="/generate">Open Generate</Link>
          </Button>
        )}
      />
    )
  } else {
    body = (
      <>
        <MasonryGrid items={tiles} label={`Made with ${character.name}`} />
        <ArtifactViewer runs={runs} index={shownIndex} onIndexChange={setViewerIndex} onFavoriteToggled={refresh} />
        {error && (
          <AlertPanel variant="error" title="Could not load more">{error.message}</AlertPanel>
        )}
        {(hasMore || (error && runs.length > 0)) && (
          <div className="flex justify-center">
            <Button type="button" variant="outline" size="sm" onClick={error ? retry : loadMore} disabled={isLoadingMore}>
              {isLoadingMore ? 'Loading more…' : error ? 'Retry' : 'Load more'}
            </Button>
          </div>
        )}
      </>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button asChild variant="link" size="sm" className="text-muted-foreground h-auto px-0">
          <Link href={artifactsHref(character.id)}>
            Open in Artifacts
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </Button>
      </div>
      {body}
    </div>
  )
}
