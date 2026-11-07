import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkflowGrantLeaseStore,
  type WorkflowGrantLeaseActions,
  type WorkflowGrantLeaseInput,
} from '../src/services/workflow-grant-lease-store.js';

const LEASE_A = '11111111-1111-4111-8111-111111111111';
const LEASE_B = '22222222-2222-4222-8222-222222222222';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function input(leaseId: string, operation: 'grant' | 'revoke', overrides: Partial<WorkflowGrantLeaseInput> = {}): WorkflowGrantLeaseInput {
  return {
    leaseId,
    receiverLarkAppId: 'cli_receiver',
    chatId: 'oc_chat',
    subjectOpenId: 'ou_subject',
    operation,
    ...overrides,
  };
}

function callbacks(state: { granted: boolean; grants: number; revokes: number }): WorkflowGrantLeaseActions {
  return {
    hasGrant: () => state.granted,
    grant: async () => {
      state.grants += 1;
      state.granted = true;
    },
    revoke: async () => {
      state.revokes += 1;
      state.granted = false;
    },
  };
}

describe('WorkflowGrantLeaseStore', () => {
  const directories: string[] = [];

  function makeStore(): { store: WorkflowGrantLeaseStore; filePath: string } {
    const directory = mkdtempSync(join(tmpdir(), 'botmux-grant-lease-'));
    directories.push(directory);
    const filePath = join(directory, 'private', 'leases.json');
    return { store: new WorkflowGrantLeaseStore(filePath), filePath };
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('keeps a revoke tombstone authoritative over a late grant without callbacks or ledger writes', async () => {
    const { store, filePath } = makeStore();
    const state = { granted: false, grants: 0, revokes: 0 };
    const actions = callbacks(state);

    await store.apply(input(LEASE_A, 'revoke'), actions);
    const before = readFileSync(filePath, 'utf8');

    await expect(store.apply(input(LEASE_A, 'grant'), actions)).rejects.toMatchObject({
      code: 'LEASE_REVOKED',
    });
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(state).toEqual({ granted: false, grants: 0, revokes: 0 });
  });

  it('holds the file lock across grant so a concurrent revoke waits and then removes it', async () => {
    const { store } = makeStore();
    const enteredGrant = deferred();
    const releaseGrant = deferred();
    let granted = false;
    let revokeCalls = 0;
    const actions: WorkflowGrantLeaseActions = {
      hasGrant: () => granted,
      grant: async () => {
        enteredGrant.resolve();
        await releaseGrant.promise;
        granted = true;
      },
      revoke: async () => {
        revokeCalls += 1;
        granted = false;
      },
    };

    const granting = store.apply(input(LEASE_A, 'grant'), actions);
    await enteredGrant.promise;
    const revoking = store.apply(input(LEASE_A, 'revoke'), actions);
    await Promise.resolve();
    expect(revokeCalls).toBe(0);

    releaseGrant.resolve();
    await granting;
    await expect(revoking).resolves.toEqual({ leaseActive: false, changed: true });
    expect(granted).toBe(false);
    expect(revokeCalls).toBe(1);
  });

  it('does not let an old lease revoke remove a newer active lease for the same target', async () => {
    const { store } = makeStore();
    const state = { granted: false, grants: 0, revokes: 0 };
    const actions = callbacks(state);

    await store.apply(input(LEASE_A, 'grant'), actions);
    await store.apply(input(LEASE_B, 'grant'), actions);
    await expect(store.apply(input(LEASE_A, 'revoke'), actions)).resolves.toEqual({
      leaseActive: false,
      changed: false,
    });

    expect(state.granted).toBe(true);
    expect(state.grants).toBe(1);
    expect(state.revokes).toBe(0);
  });

  it('preserves a manually preexisting generic grant through grant and revoke', async () => {
    const { store } = makeStore();
    const state = { granted: true, grants: 0, revokes: 0 };
    const actions = callbacks(state);

    await expect(store.apply(input(LEASE_A, 'grant'), actions)).resolves.toEqual({
      leaseActive: true,
      changed: false,
    });
    await expect(store.apply(input(LEASE_A, 'revoke'), actions)).resolves.toEqual({
      leaseActive: false,
      changed: false,
    });

    expect(state).toEqual({ granted: true, grants: 0, revokes: 0 });
  });

  it('rejects rather than recreating an active grant removed manually', async () => {
    const { store } = makeStore();
    const state = { granted: false, grants: 0, revokes: 0 };
    const actions = callbacks(state);

    await store.apply(input(LEASE_A, 'grant'), actions);
    state.granted = false;

    await expect(store.apply(input(LEASE_A, 'grant'), actions)).rejects.toMatchObject({
      code: 'ACTIVE_GRANT_MISSING',
    });
    expect(state.grants).toBe(1);
  });

  it('rejects reuse of a lease id with a different identity', async () => {
    const { store } = makeStore();
    const state = { granted: false, grants: 0, revokes: 0 };
    const actions = callbacks(state);

    await store.apply(input(LEASE_A, 'grant'), actions);
    await expect(store.apply(input(LEASE_A, 'revoke', { chatId: 'oc_other' }), actions)).rejects.toMatchObject({
      code: 'LEASE_IDENTITY_CONFLICT',
    });
    expect(state.revokes).toBe(0);
  });

  it('heals a persisted pending lease after grant took effect and failed without repeating grant', async () => {
    const { store, filePath } = makeStore();
    let granted = false;
    let grantCalls = 0;
    const actions: WorkflowGrantLeaseActions = {
      hasGrant: () => granted,
      grant: async () => {
        grantCalls += 1;
        granted = true;
        throw new Error('ack lost after grant');
      },
      revoke: async () => { granted = false; },
    };

    await expect(store.apply(input(LEASE_A, 'grant'), actions)).rejects.toMatchObject({
      code: 'ACTION_FAILED',
    });
    expect(JSON.parse(readFileSync(filePath, 'utf8')).leases[LEASE_A].state).toBe('pending');

    await expect(store.apply(input(LEASE_A, 'grant'), actions)).resolves.toEqual({
      leaseActive: true,
      changed: false,
    });
    expect(grantCalls).toBe(1);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).leases[LEASE_A].state).toBe('active');
  });
});
