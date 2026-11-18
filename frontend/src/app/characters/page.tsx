import type { Metadata } from 'next'

import { CharactersClient } from './characters-client'

export const metadata: Metadata = {
  title: 'Characters',
  description: 'Faces, audio and reference clips for your flows.',
}

export default function CharactersPage() {
  return <CharactersClient />
}
