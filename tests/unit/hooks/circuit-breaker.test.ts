import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('circuit-breaker', () => {
  beforeEach(async () => {
    vi.resetModules();
    // Reset circuit state before each test
    const { resetCircuitBreaker } = await import('../../../hooks/lib/circuit-breaker.js');
    resetCircuitBreaker();
  });

  describe('withCircuitBreaker', () => {
    it('executes function successfully in CLOSED state', async () => {
      const { withCircuitBreaker, getCircuitState } = await import(
        '../../../hooks/lib/circuit-breaker.js'
      );

      const result = await withCircuitBreaker(async () => 'success');

      expect(result).toBe('success');
      expect(getCircuitState().state).toBe('CLOSED');
      expect(getCircuitState().failures).toBe(0);
    });

    it('opens circuit after 3 consecutive failures', async () => {
      const { withCircuitBreaker, getCircuitState } = await import(
        '../../../hooks/lib/circuit-breaker.js'
      );

      const failingFn = async () => {
        throw new Error('test failure');
      };

      // First 2 failures - still CLOSED
      for (let i = 0; i < 2; i++) {
        await expect(withCircuitBreaker(failingFn)).rejects.toThrow('test failure');
        expect(getCircuitState().state).toBe('CLOSED');
      }

      // 3rd failure - opens circuit
      await expect(withCircuitBreaker(failingFn)).rejects.toThrow('test failure');
      expect(getCircuitState().state).toBe('OPEN');
      expect(getCircuitState().failures).toBe(3);
    });

    it('throws CircuitOpenError when circuit is OPEN', async () => {
      const { withCircuitBreaker, getCircuitState, CircuitOpenError } = await import(
        '../../../hooks/lib/circuit-breaker.js'
      );

      // Open the circuit
      const failingFn = async () => {
        throw new Error('test failure');
      };
      for (let i = 0; i < 3; i++) {
        await expect(withCircuitBreaker(failingFn)).rejects.toThrow();
      }

      expect(getCircuitState().state).toBe('OPEN');

      // Now any call should throw CircuitOpenError
      await expect(withCircuitBreaker(async () => 'success')).rejects.toThrow(
        'CIRCUIT_OPEN'
      );
    });

    it('transitions to HALF_OPEN after recovery timeout', async () => {
      const { withCircuitBreaker, getCircuitState, resetCircuitBreaker } = await import(
        '../../../hooks/lib/circuit-breaker.js'
      );

      // Open the circuit
      const failingFn = async () => {
        throw new Error('test failure');
      };
      for (let i = 0; i < 3; i++) {
        await expect(withCircuitBreaker(failingFn)).rejects.toThrow();
      }

      // Mock Date.now to simulate time passing
      const originalNow = Date.now;
      Date.now = vi.fn(() => originalNow() + 31000); // 31 seconds later

      // Should transition to HALF_OPEN and allow the call
      const result = await withCircuitBreaker(async () => 'recovery');
      expect(result).toBe('recovery');
      expect(getCircuitState().state).toBe('HALF_OPEN');

      Date.now = originalNow;
    });

    it('closes circuit after 2 successes in HALF_OPEN', async () => {
      const { withCircuitBreaker, getCircuitState } = await import(
        '../../../hooks/lib/circuit-breaker.js'
      );

      // Open the circuit
      const failingFn = async () => {
        throw new Error('test failure');
      };
      for (let i = 0; i < 3; i++) {
        await expect(withCircuitBreaker(failingFn)).rejects.toThrow();
      }

      // Mock time to transition to HALF_OPEN
      const originalNow = Date.now;
      const baseTime = originalNow();
      Date.now = vi.fn(() => baseTime + 31000);

      // First success in HALF_OPEN
      await withCircuitBreaker(async () => 'success1');
      expect(getCircuitState().state).toBe('HALF_OPEN');
      expect(getCircuitState().halfOpenSuccesses).toBe(1);

      // Second success - should close circuit
      await withCircuitBreaker(async () => 'success2');
      expect(getCircuitState().state).toBe('CLOSED');
      expect(getCircuitState().failures).toBe(0);

      Date.now = originalNow;
    });

    it('reopens circuit on failure in HALF_OPEN', async () => {
      const { withCircuitBreaker, getCircuitState } = await import(
        '../../../hooks/lib/circuit-breaker.js'
      );

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await expect(
          withCircuitBreaker(async () => {
            throw new Error('fail');
          })
        ).rejects.toThrow();
      }

      // Mock time to transition to HALF_OPEN
      const originalNow = Date.now;
      Date.now = vi.fn(() => originalNow() + 31000);

      // First success
      await withCircuitBreaker(async () => 'success');
      expect(getCircuitState().state).toBe('HALF_OPEN');

      // Failure - should reopen
      await expect(
        withCircuitBreaker(async () => {
          throw new Error('fail again');
        })
      ).rejects.toThrow();
      expect(getCircuitState().state).toBe('OPEN');

      Date.now = originalNow;
    });

    it('resets failures on success in CLOSED state', async () => {
      const { withCircuitBreaker, getCircuitState } = await import(
        '../../../hooks/lib/circuit-breaker.js'
      );

      // Cause 2 failures
      for (let i = 0; i < 2; i++) {
        await expect(
          withCircuitBreaker(async () => {
            throw new Error('fail');
          })
        ).rejects.toThrow();
      }
      expect(getCircuitState().failures).toBe(2);

      // Success should reset
      await withCircuitBreaker(async () => 'success');
      expect(getCircuitState().failures).toBe(0);
    });
  });

  describe('resetCircuitBreaker', () => {
    it('resets all state', async () => {
      const { withCircuitBreaker, getCircuitState, resetCircuitBreaker } = await import(
        '../../../hooks/lib/circuit-breaker.js'
      );

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await expect(
          withCircuitBreaker(async () => {
            throw new Error('fail');
          })
        ).rejects.toThrow();
      }
      expect(getCircuitState().state).toBe('OPEN');

      // Reset
      resetCircuitBreaker();

      expect(getCircuitState().state).toBe('CLOSED');
      expect(getCircuitState().failures).toBe(0);
      expect(getCircuitState().halfOpenSuccesses).toBe(0);
    });
  });
});
