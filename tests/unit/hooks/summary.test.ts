import { describe, it, expect } from 'vitest';
import { extractSummary, createCompletionSummary } from '../../../hooks/lib/summary.js';

describe('summary', () => {
  describe('extractSummary', () => {
    it('returns text as-is if within limit', () => {
      const text = 'Short text that fits.';
      expect(extractSummary(text, 500)).toBe(text);
    });

    it('handles empty input', () => {
      expect(extractSummary('')).toBe('No output available.');
      expect(extractSummary('   ')).toBe('No output available.');
      // @ts-expect-error - Test null handling
      expect(extractSummary(null)).toBe('No output available.');
      // @ts-expect-error - Test undefined handling
      expect(extractSummary(undefined)).toBe('No output available.');
    });

    it('preserves trailing code block', () => {
      const text = 'Here is the code:\n```typescript\nconst x = 1;\n```';
      const result = extractSummary(text, 500);
      expect(result).toContain('```typescript');
      expect(result).toContain('const x = 1;');
    });

    it('truncates at sentence boundary', () => {
      const text =
        'First sentence. Second sentence. Third sentence. Fourth sentence that is very long and will be truncated.';
      const result = extractSummary(text, 50);
      expect(result.endsWith('...')).toBe(true);
      // Should end at a sentence boundary
      expect(result).toMatch(/\.\.\./);
    });

    it('handles text with unclosed code block', () => {
      const text = 'Some text\n```typescript\nconst x = 1;\nmore code here';
      const result = extractSummary(text, 30);
      // Should truncate before the unclosed block or add truncation notice
      expect(result).not.toContain('more code here');
    });

    it('truncates long code blocks', () => {
      const longCode = 'x'.repeat(600);
      const text = `Here is code:\n\`\`\`typescript\n${longCode}\n\`\`\``;
      const result = extractSummary(text, 200);
      expect(result.length).toBeLessThanOrEqual(200);
      expect(result).toContain('[Code truncated...]');
    });

    it('preserves context line before code block', () => {
      const text = 'The implementation:\n```js\nconst a = 1;\n```';
      const result = extractSummary(text, 500);
      expect(result).toContain('implementation');
      expect(result).toContain('```js');
    });

    it('handles multiple paragraphs', () => {
      const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph with more content.';
      const result = extractSummary(text, 40);
      expect(result.endsWith('...')).toBe(true);
    });

    it('handles bullet lists', () => {
      const text = 'Items:\n- Item 1\n- Item 2\n- Item 3\n- Item 4';
      const result = extractSummary(text, 25);
      expect(result.endsWith('...')).toBe(true);
    });

    it('respects maxLength parameter', () => {
      const text = 'x'.repeat(1000);
      const result = extractSummary(text, 100);
      expect(result.length).toBeLessThanOrEqual(103); // +3 for ...
    });

    it('uses default maxLength of 500', () => {
      const text = 'x'.repeat(1000);
      const result = extractSummary(text);
      expect(result.length).toBeLessThanOrEqual(503);
    });
  });

  describe('createCompletionSummary', () => {
    it('returns default message for empty input', () => {
      expect(createCompletionSummary()).toBe('✅ Session completed.');
      expect(createCompletionSummary('')).toBe('✅ Session completed.');
      expect(createCompletionSummary('   ')).toBe('✅ Session completed.');
    });

    it('adds completion prefix to summary', () => {
      const message = 'Task completed successfully.';
      const result = createCompletionSummary(message);
      expect(result).toContain('✅ Completed:');
      expect(result).toContain('Task completed');
    });

    it('preserves existing completion prefix', () => {
      const message = '✅ Already marked complete.';
      const result = createCompletionSummary(message);
      expect(result).not.toContain('Completed:');
      expect(result).toContain('✅ Already marked');
    });

    it('truncates long messages', () => {
      const longMessage = 'x'.repeat(600);
      const result = createCompletionSummary(longMessage);
      expect(result.length).toBeLessThanOrEqual(420); // 400 + prefix + ...
    });
  });
});
