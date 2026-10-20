import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PI_INITIAL_PROMPT_COMMAND,
  PI_INITIAL_PROMPT_FILE_ENV,
} from './pi-initial-prompt-extension.js';
import { PI_INITIAL_PROMPT_EXTENSION_SOURCE } from './pi-initial-prompt-extension-data.js';

export const PI_INITIAL_PROMPT_ARG_BYTE_LIMIT = 4096;

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function safeSessionFileStem(sessionId: string): string {
  if (SAFE_SESSION_ID.test(sessionId) && !/^\.+$/.test(sessionId)) return sessionId;
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_');
}

export function piInitialPromptNeedsFile(prompt: string | undefined): boolean {
  return !!prompt && (
    Buffer.byteLength(prompt, 'utf8') > PI_INITIAL_PROMPT_ARG_BYTE_LIMIT
    // Herdr 0.7.5 rejects control characters in managed-agent argv. Its macOS
    // integration can also bypass the PATH launcher, so even short routed
    // Botmux prompts must use Pi's safe @file positional form.
    || /[\x00-\x1f\x7f]/.test(prompt)
  );
}

export function piInitialPromptRootDir(sessionDataDir: string): string {
  return join(sessionDataDir, 'pi-initial-prompts');
}

export function piInitialPromptDir(sessionDataDir: string, sessionId: string): string {
  return join(piInitialPromptRootDir(sessionDataDir), safeSessionFileStem(sessionId));
}

export function piInitialPromptFilePath(sessionDataDir: string, sessionId: string): string {
  return join(piInitialPromptDir(sessionDataDir, sessionId), 'initial.prompt.md');
}

/** Resolve an explicitly supplied extension from a real filesystem path.
 * A stale override is intentionally treated as unavailable so Pi never gets
 * a fatal --extension argument.
 */
export function piInitialPromptExtensionPath(): string | undefined {
  const configured = process.env.BOTMUX_PI_INITIAL_PROMPT_EXTENSION?.trim();
  if (configured) return existsSync(configured) ? configured : undefined;
  return undefined;
}

export function preparePiInitialPromptArg(opts: {
  prompt: string;
  sessionId: string;
  sessionDataDir?: string;
}): {
  initialPromptArg: string;
  filePath?: string;
  extensionPath?: string;
  readonlyRoot?: string;
  cleanupDir?: string;
  deferredInput?: {
    content: string;
    additionalArgs: string[];
    env: Record<string, string>;
  };
} {
  if (!piInitialPromptNeedsFile(opts.prompt)) {
    return { initialPromptArg: opts.prompt };
  }

  const sessionDataDir = opts.sessionDataDir?.trim();
  if (!sessionDataDir) {
    throw new Error('Pi long initial prompt requires SESSION_DATA_DIR for @file delivery; refusing TUI paste fallback');
  }

  const dir = piInitialPromptDir(sessionDataDir, opts.sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = piInitialPromptFilePath(sessionDataDir, opts.sessionId);
  writeFileSync(filePath, opts.prompt, { encoding: 'utf8', mode: 0o600 });
  const configuredExtension = process.env.BOTMUX_PI_INITIAL_PROMPT_EXTENSION?.trim();
  const resolvedExtension = piInitialPromptExtensionPath();
  // An explicit stale override is fail-open: do not hand Pi a fatal
  // --extension path. The worker can still deliver the prompt through its
  // regular input queue.
  if (configuredExtension && !resolvedExtension) {
    return {
      initialPromptArg: `@${filePath}`,
      filePath,
      readonlyRoot: dir,
      cleanupDir: dir,
    };
  }
  // Pi is a separate process, so the extension must be a real filesystem
  // file. In compiled Bun binaries, materialize the generated source per
  // session instead of passing a /$bunfs path.
  const extensionPath = resolvedExtension ?? join(dir, 'pi-initial-prompt-extension.mjs');
  if (!resolvedExtension) {
    writeFileSync(extensionPath, PI_INITIAL_PROMPT_EXTENSION_SOURCE, {
      encoding: 'utf8', mode: 0o600,
    });
  }
  return {
    initialPromptArg: `@${filePath}`,
    filePath,
    extensionPath,
    readonlyRoot: dir,
    cleanupDir: dir,
    deferredInput: {
      content: PI_INITIAL_PROMPT_COMMAND,
      additionalArgs: ['--extension', extensionPath],
      env: { [PI_INITIAL_PROMPT_FILE_ENV]: filePath },
    },
  };
}
