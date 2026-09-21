/**
 * Read-only scheduler projection over the local PostgreSQL adapter.
 *
 * All decisions remain owned by upstream `materialize` and `decideNext`.
 * This adapter only supplies the durable event stream and returns the actions
 * a controller composition layer must realize.
 */

import { validateDag, type V3Dag } from '../../dag.js';
import { decideNext, type V3Action } from '../../orchestrator.js';
import { materialize, type V3RunSnapshot } from '../../state.js';
import type { StoredEvent } from '../../event-contract.js';

export interface DurableWorkflowEventReader {
  readStoredEvents(runId: string): Promise<StoredEvent[]>;
}

export interface DurableWorkflowPlan {
  readonly events: readonly StoredEvent[];
  readonly snapshot: V3RunSnapshot;
  readonly actions: readonly V3Action[];
}

export class PostgresWorkflowScheduler {
  constructor(private readonly repository: DurableWorkflowEventReader) {}

  async plan(dag: V3Dag): Promise<DurableWorkflowPlan> {
    const normalized = validateDag(dag);
    const events = await this.repository.readStoredEvents(normalized.runId);
    const snapshot = materialize(events);
    const actions = decideNext(
      normalized,
      snapshot.nodes,
      snapshot.loops,
      snapshot.edges,
      snapshot.instances,
    );
    return { events, snapshot, actions };
  }
}
