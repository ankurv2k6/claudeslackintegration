/**
 * M-07: Hook Helpers
 *
 * Utilities for Claude Code hooks: stdin parsing, stdout output, exit helpers.
 * Implements HookInput/HookOutput contracts from impl-contracts.md S3.
 */

import { z } from 'zod';

/**
 * HookInput schema - Claude Code provides this on stdin
 * Contract: LOCKED (impl-contracts.md S3)
 */
export const HookInputSchema = z.object({
  session_id: z.string().uuid(),
  cwd: z.string(),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().optional(),
  request_id: z.string().optional(),
});

export type HookInput = z.infer<typeof HookInputSchema>;

/**
 * HookOutput schema - Hook outputs this on stdout
 * Contract: LOCKED (impl-contracts.md S3)
 */
export const HookOutputSchema = z.object({
  decision: z.enum(['allow', 'block']),
  reason: z.string().optional(),
});

export type HookOutput = z.infer<typeof HookOutputSchema>;

/**
 * Read and parse JSON from stdin
 * Claude Code passes hook input as JSON on stdin
 *
 * @returns Parsed and validated HookInput
 * @throws Error with HOOK_PARSE_FAILED if parsing or validation fails
 */
export async function readStdin(): Promise<HookInput> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      try {
        if (!data.trim()) {
          // Empty stdin - return minimal valid input
          reject(new Error('HOOK_PARSE_FAILED: Empty stdin'));
          return;
        }

        const parsed = JSON.parse(data);
        const result = HookInputSchema.safeParse(parsed);

        if (!result.success) {
          const errors = result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join(', ');
          reject(new Error(`HOOK_PARSE_FAILED: Validation error - ${errors}`));
          return;
        }

        resolve(result.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(new Error(`HOOK_PARSE_FAILED: ${message}`));
      }
    });

    process.stdin.on('error', (err) => {
      reject(new Error(`HOOK_PARSE_FAILED: stdin error - ${err.message}`));
    });

    // Handle timeout - stdin should complete quickly
    setTimeout(() => {
      reject(new Error('HOOK_PARSE_FAILED: stdin timeout'));
    }, 5000);
  });
}

/**
 * Output allow decision and exit
 * Use when hook should not block Claude's execution
 */
export function exitAllow(): never {
  const output: HookOutput = { decision: 'allow' };
  console.log(JSON.stringify(output));
  process.exit(0);
}

/**
 * Output block decision with prompt injection and exit
 * Use when hook should inject a new prompt into Claude
 *
 * @param prompt - The prompt to inject as Claude's next task
 */
export function exitBlock(prompt: string): never {
  const output: HookOutput = { decision: 'block', reason: prompt };
  console.log(JSON.stringify(output));
  process.exit(0);
}

/**
 * Exit with error (fail open - allow Claude to continue)
 * Logs error to stderr for debugging, outputs allow decision
 *
 * @param error - Error message to log
 */
export function exitWithError(error: string): never {
  console.error(`[HOOK_ERROR] ${error}`);
  exitAllow();
}
