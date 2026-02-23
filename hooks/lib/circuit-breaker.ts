/**
 * M-07: Circuit Breaker
 *
 * Implements circuit breaker pattern to prevent cascade failures when daemon is unavailable.
 * States: CLOSED (normal) -> OPEN (failures exceeded) -> HALF_OPEN (recovery test)
 *
 * Pattern: 3 failures → OPEN → 30s recovery → HALF_OPEN → 2 successes → CLOSED
 */

const FAILURE_THRESHOLD = 3;
const RECOVERY_TIMEOUT_MS = 30000; // 30 seconds
const SUCCESS_THRESHOLD = 2;

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: CircuitState;
  halfOpenSuccesses: number;
}

// Circuit state is stored in memory (resets per hook invocation)
// This is intentional - each hook run starts fresh
const state: CircuitBreakerState = {
  failures: 0,
  lastFailure: 0,
  state: 'CLOSED',
  halfOpenSuccesses: 0,
};

/**
 * Error thrown when circuit breaker is open
 */
export class CircuitOpenError extends Error {
  constructor() {
    super('CIRCUIT_OPEN: Daemon unavailable');
    this.name = 'CircuitOpenError';
  }
}

/**
 * Execute a function with circuit breaker protection
 *
 * @param fn - Async function to execute
 * @returns Result of fn()
 * @throws CircuitOpenError if circuit is open
 * @throws Original error from fn() if it fails
 */
export async function withCircuitBreaker<T>(fn: () => Promise<T>): Promise<T> {
  // Check if circuit should transition from OPEN to HALF_OPEN
  if (state.state === 'OPEN') {
    const timeSinceFailure = Date.now() - state.lastFailure;
    if (timeSinceFailure > RECOVERY_TIMEOUT_MS) {
      state.state = 'HALF_OPEN';
      state.halfOpenSuccesses = 0;
    } else {
      throw new CircuitOpenError();
    }
  }

  try {
    const result = await fn();

    // On success
    if (state.state === 'HALF_OPEN') {
      state.halfOpenSuccesses++;
      if (state.halfOpenSuccesses >= SUCCESS_THRESHOLD) {
        // Recovery complete - close circuit
        state.state = 'CLOSED';
        state.failures = 0;
      }
    } else {
      // Reset failures on success in CLOSED state
      state.failures = 0;
    }

    return result;
  } catch (err) {
    // On failure
    state.failures++;
    state.lastFailure = Date.now();

    if (state.state === 'HALF_OPEN') {
      // Failed during recovery - reopen circuit
      state.state = 'OPEN';
    } else if (state.failures >= FAILURE_THRESHOLD) {
      // Threshold exceeded - open circuit
      state.state = 'OPEN';
    }

    throw err;
  }
}

/**
 * Get current circuit breaker state (for logging/debugging)
 */
export function getCircuitState(): CircuitBreakerState {
  return { ...state };
}

/**
 * Reset circuit breaker state (for testing)
 */
export function resetCircuitBreaker(): void {
  state.failures = 0;
  state.lastFailure = 0;
  state.state = 'CLOSED';
  state.halfOpenSuccesses = 0;
}
