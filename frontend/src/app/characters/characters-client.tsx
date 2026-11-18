'use client'

import { Suspense } from 'react'
import { CharactersPageBody, CharactersPageSkeleton } from '@/components/characters/characters-page-body'

// useSearchParams in the body needs a Suspense boundary for the Next.js prerender step.
export function CharactersClient() {
  return (
    <Suspense fallback={<CharactersPageSkeleton />}>
      <CharactersPageBody />
    </Suspense>
  )
}
