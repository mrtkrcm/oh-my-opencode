export interface ParsedTokenLimitError {
  currentTokens: number
  maxTokens: number
  requestId?: string
  errorType: string
  providerID?: string
  modelID?: string
  messageIndex?: number
}

export interface RetryState {
  attempt: number
  lastAttemptTime: number
}

export interface FallbackState {
  revertAttempt: number
  lastRevertedMessageID?: string
}

export interface TruncateState {
  truncateAttempt: number
  lastTruncatedPartId?: string
}

export interface DcpState {
  attempted: boolean
  itemsPruned: number
}

/**
 * Unified session recovery state - consolidates all per-session state into one object.
 * Reduces 5 Maps to 1 for better memory efficiency and simpler state management.
 */
export interface SessionRecoveryState {
  retry: RetryState
  fallback: FallbackState
  truncate: TruncateState
  dcp: DcpState
  emptyContentAttempt: number
}

/**
 * Creates a fresh session recovery state with default values.
 */
export function createDefaultSessionState(): SessionRecoveryState {
  return {
    retry: { attempt: 0, lastAttemptTime: 0 },
    fallback: { revertAttempt: 0 },
    truncate: { truncateAttempt: 0 },
    dcp: { attempted: false, itemsPruned: 0 },
    emptyContentAttempt: 0,
  }
}

export interface AutoCompactState {
  pendingCompact: Set<string>
  errorDataBySession: Map<string, ParsedTokenLimitError>
  /** Unified session state - replaces 5 separate Maps */
  sessionStateBySession: Map<string, SessionRecoveryState>
  compactionInProgress: Set<string>
  // Legacy Maps preserved for gradual migration (can be removed after full migration)
  retryStateBySession: Map<string, RetryState>
  fallbackStateBySession: Map<string, FallbackState>
  truncateStateBySession: Map<string, TruncateState>
  dcpStateBySession: Map<string, DcpState>
  emptyContentAttemptBySession: Map<string, number>
}

export const RETRY_CONFIG = {
  maxAttempts: 2,
  initialDelayMs: 2000,
  backoffFactor: 2,
  maxDelayMs: 30000,
} as const

export const FALLBACK_CONFIG = {
  maxRevertAttempts: 3,
  minMessagesRequired: 2,
} as const

export const TRUNCATE_CONFIG = {
  maxTruncateAttempts: 20,
  minOutputSizeToTruncate: 500,
  targetTokenRatio: 0.5,
  charsPerToken: 4,
} as const
