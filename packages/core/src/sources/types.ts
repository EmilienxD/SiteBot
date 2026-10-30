/** Application-selected evidence. Text and metadata are untrusted reference data, never instructions. */
export interface SourceInput {
  /** Stable application identity; use a new ID when the underlying source changes. */
  id: string
  title: string
  /** Absolute HTTP(S) provenance URL, without credentials. SiteBot never fetches it. */
  url: string
  /** Original evidence; only the first 280 characters persist as a snippet. */
  text: string
  lang?: string
}

export interface SourceReference {
  /** Conversation-wide number for the model's [n] citation marker. */
  n: number
  /** Wire identity, e.g. c1. */
  id: string
}

export interface SourceRegistrar {
  /**
   * Stage a source for this server tool call. Published only after successful output
   * validation. Throws on invalid metadata, exhausted limits, or a closed/aborted call.
   * Returning URLs or citation-shaped output alone never registers evidence.
   */
  register(source: SourceInput): SourceReference
}

/** Existing widget transport; chunkId carries the application's source ID. */
export interface Citation {
  id: string
  chunkId?: string
  title: string
  url: string
  snippet: string
  lang?: string
}

export interface CitationsPayload {
  items: Citation[]
}
