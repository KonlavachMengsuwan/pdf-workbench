import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPagePlan,
  completeSource,
  validateProjectSchema,
} from '../src/model';
import type { Page, Project, Source } from '../src/model';

const { invoke, GeometryWorker } = vi.hoisted(() => ({
  invoke: vi.fn(),
  GeometryWorker: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: {},
}));
vi.mock('../src/adapters/geometry.worker?worker', () => ({
  default: GeometryWorker,
}));
import {
  createEditingCopy,
  materialize,
  restoreProject,
} from '../src/adapters/workbench';

const publisher: Source = {
  id: 'publisher',
  path: '/fixture/publisher.pdf',
  name: 'Publisher article.pdf',
  bytes: 500,
  sha256: 'a'.repeat(64),
  kind: 'pdf',
  features: [
    'bookmarks',
    'accessibility tags',
    'XMP metadata',
    'annotations or links',
  ],
  editable: false,
  preserveDocument: true,
  canCreateEditingCopy: true,
  pages: 3,
};
const pages = (): Page[] =>
  Array.from({ length: 3 }, (_, index) => ({
    id: `page-${index}`,
    sourceId: publisher.id,
    page: index + 1,
    rotation: 0,
  }));
const project = (source = publisher): Project => ({
  schemaVersion: 1,
  name: 'Publisher article',
  sources: [source],
  pages: pages(),
  history: [],
  future: [],
});

describe('operation-aware preservation policy', () => {
  it('allows an unchanged complete PDF copy without requiring edit capabilities', () => {
    const signed = {
      ...publisher,
      features: ['digital signatures (unverified)'],
      preserveDocument: false,
      canCreateEditingCopy: false,
    };
    expect(classifyPagePlan(pages(), [signed])).toEqual({
      kind: 'unchanged',
      source: signed,
    });
  });

  it('routes full-document rotation/crop through preservation instead of assembly', () => {
    const plan = pages();
    plan[0].rotation = 90;
    plan[2].crop = { left: 10, right: 20, top: 30, bottom: 40 };
    expect(classifyPagePlan(plan, [publisher])).toEqual({
      kind: 'preserve',
      source: publisher,
    });
    expect(completeSource(plan, [publisher])).toBe(publisher);
  });

  it.each([
    'reorder',
    'extract',
    'duplicate',
    'blank',
    'resize',
    'merge',
  ] as const)(
    'rejects protected %s rather than dropping document structures',
    (operation) => {
      let plan = pages();
      if (operation === 'reorder') [plan[0], plan[1]] = [plan[1], plan[0]];
      if (operation === 'extract') plan = plan.slice(0, 2);
      if (operation === 'duplicate') plan[1] = { ...plan[0], id: 'duplicate' };
      if (operation === 'blank')
        plan[1] = {
          id: 'blank',
          sourceId: null,
          page: 1,
          rotation: 0,
          blank: { width: 612, height: 792 },
        };
      if (operation === 'resize')
        plan[0].resize = {
          width: 612,
          height: 792,
          mode: 'fit',
          anchor: 'center',
          margin: 0,
        };
      const sources = [
        publisher,
        { ...publisher, id: 'second', editable: true },
      ];
      if (operation === 'merge')
        plan.push({ ...plan[0], id: 'merged', sourceId: 'second' });
      expect(() => classifyPagePlan(plan, sources)).toThrow('cannot preserve');
    },
  );

  it('does not infer newly supported capabilities from old saved feature strings', () => {
    const old = { ...publisher, preserveDocument: undefined };
    const plan = pages();
    plan[0].rotation = 90;
    expect(() => classifyPagePlan(plan, [old])).toThrow('cannot preserve');
    expect(
      validateProjectSchema(project(old)).sources[0].preserveDocument,
    ).toBeUndefined();
  });

  it('keeps unrestricted PDF assembly and blank creation available', () => {
    const plain = { ...publisher, features: [], editable: true };
    expect(classifyPagePlan(pages().reverse(), [plain])).toEqual({
      kind: 'assemble',
    });
    expect(
      classifyPagePlan(
        [
          {
            id: 'blank',
            sourceId: null,
            page: 1,
            rotation: 0,
            blank: { width: 612, height: 792 },
          },
        ],
        [],
      ),
    ).toEqual({ kind: 'assemble' });
  });
});

describe('native preservation adapter boundary', () => {
  beforeEach(() => {
    invoke.mockReset();
    GeometryWorker.mockReset();
  });

  it('uses original bytes for unchanged copy and makes no processing call', async () => {
    await expect(materialize(pages(), [publisher], () => {})).resolves.toBe(
      publisher,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(GeometryWorker).not.toHaveBeenCalled();
  });

  it('sends only page number, relative rotation and crop to preserve_document', async () => {
    const plan = pages();
    plan[1].rotation = 180;
    plan[2].crop = { left: 5, bottom: 10, right: 15, top: 20 };
    const output = { ...publisher, id: 'preserved' };
    invoke.mockResolvedValue(output);
    await expect(materialize(plan, [publisher], () => {})).resolves.toBe(
      output,
    );
    expect(invoke).toHaveBeenCalledWith('preserve_document', {
      id: publisher.id,
      pages: plan.map(({ page, rotation, crop }) => ({ page, rotation, crop })),
      jobId: expect.any(String),
    });
    expect(GeometryWorker).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('never sends unsupported protected geometry to pdf-lib or page assembly', async () => {
    const plan = pages();
    plan[0].resize = {
      width: 612,
      height: 792,
      mode: 'bounds',
      anchor: 'center',
      margin: 0,
    };
    await expect(materialize(plan, [publisher], () => {})).rejects.toThrow(
      'cannot preserve',
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(GeometryWorker).not.toHaveBeenCalled();
  });

  it('records actual removed features and original hash on explicitly requested editing copies', async () => {
    const output = {
      ...publisher,
      id: 'editing-copy',
      editable: true,
      features: [],
      removedFeatures: ['bookmarks', 'XMP metadata'],
    };
    invoke.mockImplementation(async (command: string) =>
      command === 'engine_info' ? { qpdf: 'fixture-version' } : output,
    );
    const result = await createEditingCopy(publisher, () => {});
    expect(result.provenance?.kind).toBe('editing-copy');
    expect(result.provenance?.sources[0].sha256).toBe(publisher.sha256);
    expect(result.provenance?.settings.removedFeatures).toEqual(
      output.removedFeatures,
    );
    expect(invoke).toHaveBeenCalledWith('create_editing_copy', {
      id: publisher.id,
      jobId: expect.any(String),
    });
  });

  it('rejects editing copies without native eligibility', async () => {
    await expect(
      createEditingCopy(
        { ...publisher, canCreateEditingCopy: false },
        () => {},
      ),
    ).rejects.toThrow('not supported');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refreshes capabilities from native preflight rather than saved project flags', async () => {
    const stale = {
      ...publisher,
      preserveDocument: true,
      canCreateEditingCopy: true,
    };
    invoke.mockResolvedValue({
      project: project(stale),
      sources: [
        { ...publisher, preserveDocument: false, canCreateEditingCopy: false },
      ],
    });
    const restored = await restoreProject(project(stale));
    expect(restored.sources[0].preserveDocument).toBe(false);
    expect(restored.sources[0].canCreateEditingCopy).toBe(false);
  });
});
