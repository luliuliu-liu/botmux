import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyRequest, createDraft } from '../src/dashboard/web/workflow-draft-api.js';
import { runTemplate } from '../src/dashboard/web/workflow-library-api.js';
import { ui } from '../src/dashboard/web/ui.js';
import { V3RunsPage } from '../src/dashboard/web/v3-components.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  ui.platformManaged = false;
  const location = { hash: '' };
  vi.stubGlobal('window', { location, setTimeout, clearTimeout });
  vi.stubGlobal('location', location);
});
afterEach(() => vi.unstubAllGlobals());

describe('ACP Workflow is read-only', () => {
  it('keeps the run list and template link but hides draft creation and draft polling', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/settings') return json({ settings: { workflow: { enabled: true, nodeExecutor: 'ephemeral' } } });
      if (url === '/api/v3/runs') return json({ runs: [] });
      return json({});
    }));
    ui.platformManaged = true;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(V3RunsPage)); });
    await flush();
    const links = renderer.root.findAllByType('a').map((node) => node.props.href);
    expect(links).toContain('#/workflows/library');
    expect(links).not.toContain('#/workflows/new');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === '/api/v3/runs')).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === '/api/v3/orchestration/drafts')).toBe(false);
    await act(async () => renderer.unmount());
  });

  it.each(['#/workflows/new', '#/workflows/drafts/draft-261101-080000-000-aaaa0001'])('blocks the managed write hash %s', async (hash) => {
    window.location.hash = hash;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/settings') return json({ settings: { workflow: { enabled: true, nodeExecutor: 'bot' } } });
      if (url === '/api/v3/runs') return json({ runs: [] });
      return json({});
    }));
    ui.platformManaged = true;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(V3RunsPage)); });
    await flush();
    expect(renderer.root.findAllByProps({ id: 'wfd-goal' })).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/orchestration/drafts'))).toBe(false);
    expect(renderer.root.findAllByProps({ className: 'v3r-run-list' })).toHaveLength(1);
    await act(async () => renderer.unmount());
  });

  it('does not extend native web API bodies with poolId', async () => {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return json({ draft: { runId: 'new' } });
    });
    await createDraft({ larkAppId: 'app', goal: 'goal' }, fetcher);
    await runTemplate('template', { params: {}, expectedRevisionId: 'rev' }, fetcher);
    expect(sent.every((item) => !Object.hasOwn(item.body, 'poolId'))).toBe(true);
    expect(copyRequest({ kind: 'run', runId: 'source' }).body).not.toHaveProperty('poolId');
  });
});
