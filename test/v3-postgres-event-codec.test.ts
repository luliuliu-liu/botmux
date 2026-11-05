import { describe, expect, it } from 'vitest';
import { decodeStoredEvents } from '../src/workflows/v3/adapters/postgres/event-codec.js';

describe('PostgreSQL v3 event codec', () => {
  it('rebuilds upstream StoredEvent values in database sequence order', () => {
    expect(decodeStoredEvents([{
      runId: 'run-1', sequence: 1, eventType: 'runStarted',
      payload: { runId: 'run-1' }, occurredAt: '2026-09-21T12:00:00.000Z',
    }, {
      runId: 'run-1', sequence: 2, eventType: 'nodeDispatched',
      payload: { nodeId: 'node-1', instanceId: 'node-1#1', attemptId: 'attempt-1' },
      occurredAt: '2026-09-21T12:00:01.000Z',
    }])).toEqual([{
      type: 'runStarted', runId: 'run-1', ts: 1_789_992_000_000,
    }, {
      type: 'nodeDispatched', nodeId: 'node-1', instanceId: 'node-1#1',
      attemptId: 'attempt-1', ts: 1_789_992_001_000,
    }]);
  });

  it('fails closed on gaps, unknown upstream events and envelope shadowing', () => {
    expect(() => decodeStoredEvents([{
      runId: 'run-1', sequence: 2, eventType: 'runStarted', payload: { runId: 'run-1' },
      occurredAt: '2026-09-21T12:00:00.000Z',
    }])).toThrow('non-contiguous event sequence');
    expect(() => decodeStoredEvents([{
      runId: 'run-1', sequence: 1, eventType: 'futureEvent', payload: {},
      occurredAt: '2026-09-21T12:00:00.000Z',
    }])).toThrow('unsupported v3 event type');
    expect(() => decodeStoredEvents([{
      runId: 'run-1', sequence: 1, eventType: 'runStarted', payload: { type: 'runFailed' },
      occurredAt: '2026-09-21T12:00:00.000Z',
    }])).toThrow('shadows envelope fields');
  });
});

it('preserves flow revision and external handoff records through PostgreSQL replay',()=>{
  const rows=[{runId:'run-1',sequence:1,eventType:'dagRevisionProposed',payload:{revision:2,baseRevision:1,sha256:'digest',patchSha256:'patch',summary:'change',by:'owner',reasons:[],touched:['work']},occurredAt:'2026-11-05T12:00:00.000Z'},
    {runId:'run-1',sequence:2,eventType:'nodeHandoffAccepted',payload:{nodeId:'work',attemptId:'work/001',acceptedAt:1},occurredAt:'2026-11-05T12:00:01.000Z'}];
  const events=decodeStoredEvents(rows);expect(events[0]).toMatchObject({type:'dagRevisionProposed',revision:2,touched:['work']});expect(events[1]).toMatchObject({type:'nodeHandoffAccepted',attemptId:'work/001'});
});
