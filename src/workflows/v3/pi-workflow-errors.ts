/**
 * Workflow-only Pi failure classification.
 *
 * Pi renders provider failures in its terminal instead of emitting a
 * Botmux-native worker error.  Keep the classifier separate from the native
 * Pi adapter so upstream Pi changes remain easy to merge and ordinary Pi
 * sessions keep their existing behaviour.
 */

const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Return a stable, secret-free terminal failure message when Pi reports a
 * provider authentication error.  The full terminal text is intentionally
 * not returned because it can contain request ids or user-visible content.
 */
export function classifyPiWorkflowFailure(transcript: string): string | undefined {
  const plain = transcript.replace(ANSI_ESCAPE_RE, '');
  const apiKeyFormatError = /API key format is incorrect/i.test(plain);
  const authentication401 = /\bError:\s*401\b/i.test(plain) && /AuthenticationError/i.test(plain);
  if (!apiKeyFormatError && !authentication401) return undefined;
  return 'Pi workflow worker failed: provider rejected model authentication (HTTP 401; API key format is incorrect)';
}
