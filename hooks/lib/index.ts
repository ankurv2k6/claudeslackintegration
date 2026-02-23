/**
 * M-07: Hook Library Exports
 *
 * Consolidated exports for hook utilities.
 */

// Hook helpers (stdin/stdout)
export {
  readStdin,
  exitAllow,
  exitBlock,
  exitWithError,
  HookInput,
  HookOutput,
  HookInputSchema,
  HookOutputSchema,
} from './hook-helpers.js';

// Logging
export {
  createHookLogger,
  withSessionId,
  type HookLogger,
  type HookLogEntry,
} from './hook-logger.js';

// Circuit breaker
export {
  withCircuitBreaker,
  getCircuitState,
  resetCircuitBreaker,
  CircuitOpenError,
  type CircuitState,
  type CircuitBreakerState,
} from './circuit-breaker.js';

// Daemon client
export {
  DaemonClient,
  createDaemonClient,
  type SessionInfo,
  type Task,
  type DaemonClientOptions,
} from './daemon-client.js';

// Summary extraction
export { extractSummary, createCompletionSummary } from './summary.js';
