import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Project, Source } from '../src/model';

const { invoke, getDocument } = vi.hoisted(() => ({
  invoke: vi.fn(),
  getDocument: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument,
  GlobalWorkerOptions: {},
}));
vi.mock('../src/adapters/geometry.worker?worker', () => ({
  default: class {},
}));

import {
  loadPdf,
  openProject,
  pickSources,
  restoreProject,
  saveProject,
  stageBytes,
} from '../src/adapters/workbench';

const project: Project = {
  schemaVersion: 1,
  name: 'Cancellation fixture',
  sources: [],
  pages: [
    {
      id: 'blank',
      sourceId: null,
      page: 1,
      rotation: 0,
      blank: { width: 612, height: 792 },
    },
  ],
  history: [],
  future: [],
};

function pendingNative(command: string) {
  let finish!: (result: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  invoke.mockImplementation((name: string) => {
    if (name === command) return pending;
    if (name === 'cancel_job') return Promise.resolve();
    throw new Error(`Unexpected native command: ${name}`);
  });
  return finish;
}

describe('project cancellation across the native boundary', () => {
  beforeEach(() => {
    invoke.mockReset();
    getDocument.mockReset();
  });

  it.each(['open', 'restore'] as const)(
    'does not return a late %s result after cancellation',
    async (kind) => {
      const command = kind === 'open' ? 'open_project' : 'restore_project';
      const finish = pendingNative(command);
      const controller = new AbortController();
      const result =
        kind === 'open'
          ? openProject(controller.signal)
          : restoreProject(project, controller.signal);
      const failure = expect(result).rejects.toMatchObject({
        name: 'AbortError',
      });
      const args = invoke.mock.calls[0][1] as { jobId: string };
      expect(args.jobId).toEqual(expect.any(String));
      controller.abort();
      expect(invoke).toHaveBeenCalledWith('cancel_job', { jobId: args.jobId });
      finish({ path: '/fixture/project.json', project, sources: [] });
      await failure;
    },
  );

  it('retains a successful save path when cancellation arrives after native commit', async () => {
    const finish = pendingNative('save_project');
    const controller = new AbortController();
    const result = saveProject(project, controller.signal);
    controller.abort();
    finish('/fixture/saved-project.json');
    await expect(result).resolves.toBe('/fixture/saved-project.json');
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'save_project',
      'cancel_job',
    ]);
  });

  it('does not dispatch an already cancelled operation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      restoreProject(project, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('removes the cancellation listener after a successful restore', async () => {
    invoke.mockResolvedValue({ project, sources: [] });
    const controller = new AbortController();
    await expect(restoreProject(project, controller.signal)).resolves.toEqual(
      project,
    );
    controller.abort();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('cancels picker preflight and rejects a late selection', async () => {
    const finish = pendingNative('pick_sources');
    const controller = new AbortController();
    const result = pickSources('pdf', controller.signal);
    const failure = expect(result).rejects.toMatchObject({
      name: 'AbortError',
    });
    const args = invoke.mock.calls[0][1] as { jobId: string; kind: string };
    expect(args.kind).toBe('pdf');
    controller.abort();
    expect(invoke).toHaveBeenCalledWith('cancel_job', { jobId: args.jobId });
    finish([]);
    await failure;
  });

  it('cancels staged-file validation without exposing a late source result', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    invoke.mockImplementation((command: string) => {
      if (command === 'begin_stage') return Promise.resolve('stage-id');
      if (command === 'finish_stage') {
        started();
        return pending;
      }
      return Promise.resolve();
    });
    const controller = new AbortController();
    const result = stageBytes(
      new Uint8Array([1]),
      'fixture.pdf',
      'pdf',
      controller.signal,
    );
    const failure = expect(result).rejects.toMatchObject({
      name: 'AbortError',
    });
    await ready;
    const args = invoke.mock.calls.find(
      (call) => call[0] === 'finish_stage',
    )![1] as { jobId: string };
    controller.abort();
    expect(invoke).toHaveBeenCalledWith('cancel_job', { jobId: args.jobId });
    finish({ id: 'stage-id' });
    await failure;
    expect(invoke).toHaveBeenCalledWith('discard_stage', { id: 'stage-id' });
  });
});

describe('initial PDF loading cancellation', () => {
  const data = Uint8Array.from([37, 80, 68, 70]);
  const source: Source = {
    id: 'source',
    path: '/fixture/source.pdf',
    name: 'source.pdf',
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    pages: 1,
    kind: 'pdf',
    features: [],
    editable: true,
  };
  beforeEach(() => {
    invoke.mockReset();
    getDocument.mockReset();
  });

  it('stops after an in-flight input chunk before starting PDF.js', async () => {
    const finish = pendingNative('read_chunk');
    const controller = new AbortController();
    const result = loadPdf(source, controller.signal);
    const failure = expect(result).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    finish(data.buffer.slice(0));
    await failure;
    expect(getDocument).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('destroys a pending PDF.js loading task and rejects cancellation', async () => {
    invoke.mockResolvedValue(data.buffer.slice(0));
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const destroy = vi.fn().mockResolvedValue(undefined);
    getDocument.mockImplementation(() => {
      started();
      return { promise: new Promise(() => {}), destroy };
    });
    const controller = new AbortController();
    const result = loadPdf(source, controller.signal);
    const failure = expect(result).rejects.toMatchObject({
      name: 'AbortError',
    });
    await ready;
    controller.abort();
    await failure;
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('cleans up a loading failure and keeps the actual error', async () => {
    invoke.mockResolvedValue(data.buffer.slice(0));
    const destroy = vi.fn().mockResolvedValue(undefined);
    getDocument.mockImplementation(() => ({
      promise: Promise.reject(new Error('Malformed PDF fixture')),
      destroy,
    }));
    await expect(loadPdf(source)).rejects.toThrow('Malformed PDF fixture');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('releases the abort listener after a successful load', async () => {
    invoke.mockResolvedValue(data.buffer.slice(0));
    const destroy = vi.fn().mockResolvedValue(undefined);
    const document = { numPages: 1 };
    getDocument.mockImplementation(() => ({
      promise: Promise.resolve(document),
      destroy,
    }));
    const controller = new AbortController();
    await expect(loadPdf(source, controller.signal)).resolves.toBe(document);
    controller.abort();
    expect(destroy).not.toHaveBeenCalled();
  });
});
