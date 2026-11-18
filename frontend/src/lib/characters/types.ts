/** Sound is one kind, `audio` (a voice sample or any other sound); the prompt says how the model uses it. */
export type CharacterMediaKind = 'image' | 'video' | 'audio'

export const CHARACTER_MEDIA_KINDS: readonly CharacterMediaKind[] = ['image', 'video', 'audio']

export interface CharacterMedia {
  id: string
  kind: CharacterMediaKind
  label: string
  /** `/outputs/characters/<character id>/<file>`: usable directly as an img/video/audio src and as a generation reference `local`. */
  local: string
  size_bytes: number
  width: number | null
  height: number | null
  duration_s: number | null
  position: number
  created_at: string
}

export interface Character {
  id: string
  name: string
  description: string
  created_at: string
  updated_at: string
  default_face_id: string | null
  /** The audio clip a Load Character block pre-selects; the first audio clip added becomes it. */
  default_audio_id: string | null
  /** Ordered by kind (image, video, audio) then position. */
  media: CharacterMedia[]
}

/** A character is created from a name and its face image (the first image and default face). */
export interface CharacterCreate {
  name: string
  face: File
  /** Probed size of the face image. */
  meta?: Pick<CharacterMediaMeta, 'width' | 'height'>
}

export type CharacterPatch = Partial<Pick<Character, 'name' | 'description' | 'default_face_id' | 'default_audio_id'>>

/** Probed metadata sent with an upload as query params. */
export interface CharacterMediaMeta {
  width?: number
  height?: number
  duration_s?: number
}
