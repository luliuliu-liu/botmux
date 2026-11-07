import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

export type WorkflowGrantLeaseOperation = 'grant' | 'revoke';

export interface WorkflowGrantLeaseInput {
  leaseId: string;
  receiverLarkAppId: string;
  chatId: string;
  subjectOpenId: string;
  operation: WorkflowGrantLeaseOperation;
}

export interface WorkflowGrantLeaseActions {
  hasGrant: () => boolean;
  grant: () => Promise<void>;
  revoke: () => Promise<void>;
}

export interface WorkflowGrantLeaseResult {
  leaseActive: boolean;
  changed: boolean;
}

export class WorkflowGrantLeaseError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkflowGrantLeaseError';
  }
}

type LeaseState = 'pending' | 'active' | 'revoked';

interface LeaseIdentity {
  receiverLarkAppId: string;
  chatId: string;
  subjectOpenId: string;
}

interface LeaseRecord extends LeaseIdentity {
  state: LeaseState;
}

interface TargetRecord {
  preexisting: boolean;
}

interface LeaseLedger {
  schema: 1;
  leases: Record<string, LeaseRecord>;
  targets: Record<string, TargetRecord>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ID_LENGTH = 512;

function leaseError(code: string, message: string, cause?: unknown): WorkflowGrantLeaseError {
  return new WorkflowGrantLeaseError(code, message, cause === undefined ? undefined : { cause });
}

function identityOf(input: WorkflowGrantLeaseInput): LeaseIdentity {
  return {
    receiverLarkAppId: input.receiverLarkAppId,
    chatId: input.chatId,
    subjectOpenId: input.subjectOpenId,
  };
}

function targetKey(identity: LeaseIdentity): string {
  return JSON.stringify([
    identity.receiverLarkAppId,
    identity.chatId,
    identity.subjectOpenId,
  ]);
}

function sameIdentity(left: LeaseIdentity, right: LeaseIdentity): boolean {
  return left.receiverLarkAppId === right.receiverLarkAppId &&
    left.chatId === right.chatId &&
    left.subjectOpenId === right.subjectOpenId;
}

function validateInput(input: WorkflowGrantLeaseInput): void {
  if (!UUID_RE.test(input.leaseId)) {
    throw leaseError('INVALID_INPUT', 'leaseId must be a UUID');
  }
  for (const [name, value] of Object.entries(identityOf(input))) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH || value.includes('\0')) {
      throw leaseError('INVALID_INPUT', `${name} must be a non-empty bounded string`);
    }
  }
  if (input.operation !== 'grant' && input.operation !== 'revoke') {
    throw leaseError('INVALID_INPUT', 'operation must be grant or revoke');
  }
}

function emptyLedger(): LeaseLedger {
  return { schema: 1, leases: {}, targets: {} };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseIdentity(value: unknown): LeaseRecord | undefined {
  if (!isPlainRecord(value)) return undefined;
  const { receiverLarkAppId, chatId, subjectOpenId, state } = value;
  if (typeof receiverLarkAppId !== 'string' || !receiverLarkAppId ||
      typeof chatId !== 'string' || !chatId ||
      typeof subjectOpenId !== 'string' || !subjectOpenId ||
      (state !== 'pending' && state !== 'active' && state !== 'revoked')) return undefined;
  return { receiverLarkAppId, chatId, subjectOpenId, state };
}

function parseLedger(raw: string): LeaseLedger {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw leaseError('INVALID_LEDGER', 'lease ledger is not valid JSON', error);
  }
  if (!isPlainRecord(value) || value.schema !== 1 ||
      !isPlainRecord(value.leases) || !isPlainRecord(value.targets)) {
    throw leaseError('INVALID_LEDGER', 'lease ledger has an unsupported schema');
  }

  const leases: Record<string, LeaseRecord> = {};
  for (const [leaseId, record] of Object.entries(value.leases)) {
    if (!UUID_RE.test(leaseId)) throw leaseError('INVALID_LEDGER', 'lease ledger contains an invalid lease id');
    const parsed = parseIdentity(record);
    if (!parsed) throw leaseError('INVALID_LEDGER', 'lease ledger contains an invalid lease record');
    const canonical=leaseId.toLowerCase();
    if(leases[canonical])throw leaseError('INVALID_LEDGER','lease ledger contains duplicate canonical ids');
    leases[canonical] = parsed;
  }

  const targets: Record<string, TargetRecord> = {};
  for (const [key, record] of Object.entries(value.targets)) {
    if (!isPlainRecord(record) || typeof record.preexisting !== 'boolean') {
      throw leaseError('INVALID_LEDGER', 'lease ledger contains an invalid target record');
    }
    targets[key] = { preexisting: record.preexisting };
  }
  return { schema: 1, leases, targets };
}

function ensurePrivateDirectory(filePath: string): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw leaseError('UNSAFE_LEDGER_PATH', 'lease ledger directory must be a real directory');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw leaseError('UNSAFE_LEDGER_PATH', 'lease ledger directory has a different owner');
  }
  chmodSync(directory, 0o700);
}

function readLedger(filePath: string): LeaseLedger {
  let fd: number;
  try {
    fd = openSync(
      filePath,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger();
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw leaseError('UNSAFE_LEDGER_PATH', 'lease ledger must not be a symlink', error);
    }
    throw error;
  }

  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1) {
      throw leaseError('UNSAFE_LEDGER_PATH', 'lease ledger must be a single-link regular file');
    }
    if (typeof process.getuid === 'function' && opened.uid !== process.getuid()) {
      throw leaseError('UNSAFE_LEDGER_PATH', 'lease ledger has a different owner');
    }
    if ((opened.mode & 0o077) !== 0) {
      throw leaseError('UNSAFE_LEDGER_PATH', 'lease ledger permissions must not exceed 0600');
    }
    const raw = readFileSync(fd, 'utf8');
    const current = lstatSync(filePath);
    if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw leaseError('UNSAFE_LEDGER_PATH', 'lease ledger changed while being read');
    }
    return parseLedger(raw);
  } finally {
    closeSync(fd);
  }
}

function writeLedger(filePath: string, ledger: LeaseLedger): void {
  atomicWriteFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function callHasGrant(actions: WorkflowGrantLeaseActions): boolean {
  try {
    return actions.hasGrant();
  } catch (error) {
    throw leaseError('ACTION_FAILED', 'hasGrant callback failed', error);
  }
}

async function callAction(kind: 'grant' | 'revoke', action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    throw leaseError('ACTION_FAILED', `${kind} callback failed`, error);
  }
}

export class WorkflowGrantLeaseStore {
  constructor(readonly filePath: string) {
    if (!filePath) throw leaseError('INVALID_INPUT', 'filePath must not be empty');
  }

  async apply(
    input: WorkflowGrantLeaseInput,
    actions: WorkflowGrantLeaseActions,
  ): Promise<WorkflowGrantLeaseResult> {
    validateInput(input);
    input={...input,leaseId:input.leaseId.toLowerCase()};
    ensurePrivateDirectory(this.filePath);
    return withFileLock(this.filePath, async () => {
      const ledger = readLedger(this.filePath);
      const identity = identityOf(input);
      const existing = ledger.leases[input.leaseId];
      if (existing && !sameIdentity(existing, identity)) {
        throw leaseError('LEASE_IDENTITY_CONFLICT', 'leaseId is already bound to another identity');
      }
      return input.operation === 'grant'
        ? this.applyGrant(ledger, input.leaseId, identity, existing, actions)
        : this.applyRevoke(ledger, input.leaseId, identity, existing, actions);
    });
  }

  private async applyGrant(
    ledger: LeaseLedger,
    leaseId: string,
    identity: LeaseIdentity,
    existing: LeaseRecord | undefined,
    actions: WorkflowGrantLeaseActions,
  ): Promise<WorkflowGrantLeaseResult> {
    if (existing?.state === 'revoked') {
      throw leaseError('LEASE_REVOKED', 'a revoked lease can never be granted again');
    }
    if (existing?.state === 'active') {
      if (!callHasGrant(actions)) {
        throw leaseError('ACTIVE_GRANT_MISSING', 'active lease grant was removed outside the lease store');
      }
      return { leaseActive: true, changed: false };
    }

    const key = targetKey(identity);
    if (!existing) {
      const currentlyGranted = callHasGrant(actions);
      const anotherActiveLease = Object.values(ledger.leases).some(lease =>
        sameIdentity(lease, identity) && lease.state === 'active');
      if (!currentlyGranted && anotherActiveLease) {
        throw leaseError('ACTIVE_GRANT_MISSING', 'active lease grant was removed outside the lease store');
      }
      const anotherLiveLease=Object.values(ledger.leases).some(lease=>sameIdentity(lease,identity)&&(lease.state==='pending'||lease.state==='active'));
      if (!ledger.targets[key]||!anotherLiveLease) ledger.targets[key] = { preexisting: currentlyGranted };
      ledger.leases[leaseId] = { ...identity, state: 'pending' };
      writeLedger(this.filePath, ledger);
      if (currentlyGranted) {
        ledger.leases[leaseId].state = 'active';
        writeLedger(this.filePath, ledger);
        return { leaseActive: true, changed: false };
      }
    } else if (callHasGrant(actions)) {
      existing.state = 'active';
      writeLedger(this.filePath, ledger);
      return { leaseActive: true, changed: false };
    }

    await callAction('grant', actions.grant);
    ledger.leases[leaseId].state = 'active';
    writeLedger(this.filePath, ledger);
    return { leaseActive: true, changed: true };
  }

  private async applyRevoke(
    ledger: LeaseLedger,
    leaseId: string,
    identity: LeaseIdentity,
    existing: LeaseRecord | undefined,
    actions: WorkflowGrantLeaseActions,
  ): Promise<WorkflowGrantLeaseResult> {
    if (!existing) {
      ledger.leases[leaseId] = { ...identity, state: 'revoked' };
      writeLedger(this.filePath, ledger);
      return { leaseActive: false, changed: false };
    }

    if (existing.state !== 'revoked') {
      existing.state = 'revoked';
      writeLedger(this.filePath, ledger);
    }

    const key = targetKey(identity);
    const target = ledger.targets[key];
    if (!target || target.preexisting) return { leaseActive: false, changed: false };

    const anotherLiveLease = Object.entries(ledger.leases).some(([otherId, lease]) =>
      otherId !== leaseId && sameIdentity(lease, identity) &&
      (lease.state === 'pending' || lease.state === 'active'));
    if (anotherLiveLease || !callHasGrant(actions)) {
      return { leaseActive: false, changed: false };
    }

    await callAction('revoke', actions.revoke);
    return { leaseActive: false, changed: true };
  }
}
