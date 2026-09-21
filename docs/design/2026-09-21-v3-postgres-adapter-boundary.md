# Workflow v3 PostgreSQL adapter boundary

## Intent

The PostgreSQL/OpenSandbox controller path is product integration code, not a
new prerequisite for Botmux's portable Workflow v3 core. It must remain easy
to carry across upstream Botmux releases and easy to remove or upstream later.

## Ownership split

| Area | Owner | Rule |
|---|---|---|
| `src/workflows/v3/**` existing runtime, journal, DAG and Dashboard code | upstream Botmux | Do not change semantics or default file-journal behavior for the PostgreSQL integration. |
| `src/workflows/v3/adapters/postgres/**` | local integration | Holds only PostgreSQL schema mapping, event/outbox persistence and fenced attempt leases. |
| OpenSandbox/Pi image, Worker contract and migrations | platform repository | Must not be imported by Botmux core. |
| Future composition root | local integration | Creates a database pool, supplies the adapter through an explicit host interface, and is the only layer that reads controller configuration. |

## Compatibility rules

1. The adapter depends on structural `pg.Pool`/`pg.PoolClient` shapes instead
   of importing a driver or adding a Botmux-wide database dependency.
2. Adapter modules may import stable Workflow value types, but no upstream core
   module imports the adapter. This one-way dependency prevents a local database
   feature from changing normal Botmux CLI behavior.
3. Database migration ownership stays in the platform repository under
   `agent_workflow`; the adapter never creates application tables or uses
   `public` as a fallback.
4. Upstream changes are merged first. Local commits are then replayed as a
   small adapter-only series, with tests confined to `v3-postgres-*.test.ts`.
5. If a core seam must become async (for durable journal or lease injection),
   first propose an upstream-neutral host interface with an in-process default.
   Do not thread PostgreSQL options through `shared-node-runtime` directly.

## Current boundary

`event-store.ts` atomically allocates a per-run sequence, writes the immutable
event, updates the run projection and enqueues an outbox row. `attempt-store.ts`
owns the fenced lease lifecycle. Neither module is yet activated by the
portable runtime; that activation requires the upstream-neutral asynchronous
persistence interface described above.
