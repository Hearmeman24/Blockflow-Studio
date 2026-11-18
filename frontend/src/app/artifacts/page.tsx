import type { Metadata } from 'next'

import { ArtifactsClient } from './artifacts-client'

export const metadata: Metadata = {
  title: 'Artifacts',
  description: 'Browse generated runs, images, and videos.',
}

export default function ArtifactsPage() {
  return <ArtifactsClient />
}
