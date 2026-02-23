/**
 * M-07: Summary Extraction
 *
 * Smart text truncation for sending Claude's output to Slack.
 * Preserves code blocks, finds good break points, handles edge cases.
 */

// Regex patterns for code block detection
const TRAILING_BLOCK_REGEX = /```(\w+)?\n[\s\S]*?```\s*$/;
const OPEN_CODE_BLOCK_COUNT_REGEX = /```/g;

/**
 * Extract a summary from Claude's output for Slack
 *
 * Features:
 * - Preserves trailing code blocks when possible
 * - Truncates at sentence boundaries for readability
 * - Handles open code blocks gracefully
 * - Respects maxLength limit (default 500 chars)
 *
 * @param text - The full text to summarize
 * @param maxLength - Maximum length of summary (default 500)
 * @returns Truncated summary text
 */
export function extractSummary(text: string, maxLength = 500): string {
  // Handle empty/null input
  if (!text || !text.trim()) {
    return 'No output available.';
  }

  const trimmedText = text.trim();

  // If text fits within limit, return as-is
  if (trimmedText.length <= maxLength) {
    return trimmedText;
  }

  // Try to preserve trailing code block (high value content)
  const trailingMatch = trimmedText.match(TRAILING_BLOCK_REGEX);
  if (trailingMatch) {
    const blockContent = trailingMatch[0];

    // If the code block alone fits, try to include context
    if (blockContent.length < maxLength) {
      const beforeBlock = trimmedText.slice(0, trimmedText.lastIndexOf('```'));
      const lines = beforeBlock.split('\n').filter((l) => l.trim());
      const lastLine = lines.pop() || '';

      // Include last context line if it fits
      if (lastLine.length + blockContent.length + 1 < maxLength) {
        return lastLine + '\n' + blockContent;
      }

      // Just return the code block
      return blockContent;
    }

    // Code block too large - truncate it
    const langMatch = blockContent.match(/^```(\w+)?\n/);
    const lang = langMatch ? langMatch[1] || '' : '';
    const codeStart = blockContent.indexOf('\n') + 1;
    const codeEnd = blockContent.lastIndexOf('```');
    const code = blockContent.slice(codeStart, codeEnd);

    // Calculate available space for code
    const overhead = `\`\`\`${lang}\n\n[Code truncated...]\n\`\`\``.length;
    const availableCodeLength = maxLength - overhead;

    if (availableCodeLength > 50) {
      // Truncate code at a newline if possible
      const truncatedCode = code.slice(0, availableCodeLength);
      const lastNewline = truncatedCode.lastIndexOf('\n');
      const finalCode =
        lastNewline > availableCodeLength * 0.5
          ? truncatedCode.slice(0, lastNewline)
          : truncatedCode;

      return `\`\`\`${lang}\n${finalCode.trim()}\n[Code truncated...]\n\`\`\``;
    }
  }

  // Standard truncation - find good break point
  const truncated = trimmedText.slice(0, maxLength);

  // Check if we're inside an unclosed code block
  const openBlocks = (truncated.match(OPEN_CODE_BLOCK_COUNT_REGEX) || []).length;
  if (openBlocks % 2 !== 0) {
    // We're inside a code block - truncate before it
    const lastBlockStart = truncated.lastIndexOf('```');
    if (lastBlockStart > maxLength * 0.3) {
      const beforeBlock = truncated.slice(0, lastBlockStart).trim();
      if (beforeBlock) {
        return beforeBlock + '\n\n[Code truncated...]';
      }
    }
  }

  // Find good natural break points
  const breakPoints = [
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('.\n'),
    truncated.lastIndexOf('\n\n'),
    truncated.lastIndexOf(':\n'),
    truncated.lastIndexOf('\n- '),
    truncated.lastIndexOf('\n* '),
  ].filter((pos) => pos > 0);

  // Use the furthest good break point (at least 50% through)
  const minPosition = maxLength * 0.5;
  const validBreaks = breakPoints.filter((pos) => pos > minPosition);

  if (validBreaks.length > 0) {
    const bestBreak = Math.max(...validBreaks);
    const result = truncated.slice(0, bestBreak + 1).trim();
    return result + '...';
  }

  // No good break point - hard truncate
  return truncated.trim() + '...';
}

/**
 * Create a completion summary for a Claude session
 * Used when session ends without pending tasks
 *
 * @param lastMessage - Last assistant message (if any)
 * @returns Summary suitable for Slack
 */
export function createCompletionSummary(lastMessage?: string): string {
  if (!lastMessage || !lastMessage.trim()) {
    return '✅ Session completed.';
  }

  const summary = extractSummary(lastMessage, 400);

  // Add completion indicator if not already present
  if (!summary.startsWith('✅')) {
    return `✅ Completed:\n${summary}`;
  }

  return summary;
}
