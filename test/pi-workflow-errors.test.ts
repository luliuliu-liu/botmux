import { describe, expect, it } from 'vitest';

import { classifyPiWorkflowFailure } from '../src/workflows/v3/pi-workflow-errors.js';

describe('classifyPiWorkflowFailure', () => {
  it('recognizes the Ark 401 API-key-format error', () => {
    expect(classifyPiWorkflowFailure(
      '\u001b[38;5;131mError: 401: {"code":"AuthenticationError","message":"The API key format is incorrect."}',
    )).toContain('HTTP 401');
  });

  it('recognizes the provider message even when the terminal splits or decorates it', () => {
    expect(classifyPiWorkflowFailure(
      'Error: 401: {"code":"AuthenticationError"}\nAPI key format is incorrect',
    )).toBe('Pi workflow worker failed: provider rejected model authentication (HTTP 401; API key format is incorrect)');
  });

  it('ignores ordinary task output that mentions HTTP 401', () => {
    expect(classifyPiWorkflowFailure('The test endpoint returned HTTP 401 for the fixture')).toBeUndefined();
  });

  it('ignores a task that discusses the error wording without provider context', () => {
    expect(classifyPiWorkflowFailure('Explain why the API key format is incorrect')).toBeUndefined();
  });

  it('does not leak provider response text', () => {
    const result = classifyPiWorkflowFailure('Error: 401: request-id=secret AuthenticationError API key format is incorrect');
    expect(result).not.toContain('secret');
  });
});
