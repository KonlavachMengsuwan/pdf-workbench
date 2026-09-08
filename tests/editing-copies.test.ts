import { describe, expect, it, vi } from 'vitest';
import {
  editingCopyCandidates,
  prepareEditingCopies,
  useEditingCopies,
} from '../src/editingCopies';
import {
  classifyPagePlan,
  pagesForSource,
  validateProjectSchema,
} from '../src/model';
import type { Project, Source } from '../src/model';

const publisher = (id: string): Source => ({
  id,
  name: `${id}.pdf`,
  path: `/fixtures/${id}.pdf`,
  sha256: id === 'first' ? 'a'.repeat(64) : 'b'.repeat(64),
  bytes: 100,
  pages: 2,
  kind: 'pdf',
  editable: false,
  preserveDocument: true,
  canCreateEditingCopy: true,
  features: ['bookmarks', 'XMP metadata', 'annotations or links'],
});
const copyOf = (source: Source): Source => ({
  ...source,
  id: `${source.id}-copy`,
  path: `/copies/${source.id}.pdf`,
  editable: true,
  features: [],
  removedFeatures: [...source.features],
});

describe('editing-copy batch transaction', () => {
  it('converts each restricted source once and leaves plain sources alone', async () => {
    const first = publisher('first');
    const second = publisher('second');
    const plain = { ...publisher('plain'), editable: true, features: [] };
    const convert = vi.fn(async (source: Source) => copyOf(source));
    const replacements = await prepareEditingCopies(
      [first, plain, second, first],
      convert,
    );
    expect([...replacements.keys()]).toEqual(['first', 'second']);
    expect(convert).toHaveBeenCalledTimes(2);
    expect(editingCopyCandidates([plain])).toEqual([]);
  });

  it('rejects all unsafe inputs before starting any copies, identifying each file and feature', async () => {
    const convert = vi.fn(async (source: Source) => copyOf(source));
    const signed = {
      ...publisher('signed'),
      canCreateEditingCopy: false,
      features: ['digital signatures (unverified)'],
    };
    await expect(
      prepareEditingCopies([publisher('first'), signed], convert),
    ).rejects.toThrow('signed.pdf (digital signatures (unverified))');
    expect(convert).not.toHaveBeenCalled();
  });

  it('does not publish a partial batch if a later conversion fails', async () => {
    const first = publisher('first');
    const second = publisher('second');
    const originalPages = pagesForSource(first);
    let currentPages = originalPages;
    const convert = vi.fn(async (source: Source) => {
      if (source.id === second.id)
        throw new Error('Second copy failed graph verification');
      return copyOf(source);
    });
    await expect(
      (async () => {
        const replacements = await prepareEditingCopies(
          [first, second],
          convert,
        );
        currentPages = useEditingCopies(currentPages, replacements);
      })(),
    ).rejects.toThrow('graph verification');
    expect(currentPages).toBe(originalPages);
    expect(first.editable).toBe(false);
    expect(first.path).toBe('/fixtures/first.pdf');
  });

  it('cancellation after a copy completes stops the batch and leaves the project unchanged', async () => {
    const controller = new AbortController();
    const first = publisher('first');
    const originalPages = pagesForSource(first);
    let currentPages = originalPages;
    const convert = vi.fn(async (source: Source, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return copyOf(source);
    });
    await expect(
      (async () => {
        const replacements = await prepareEditingCopies(
          [first, publisher('second')],
          convert,
          controller.signal,
        );
        currentPages = useEditingCopies(currentPages, replacements);
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(convert).toHaveBeenCalledTimes(1);
    expect(currentPages).toBe(originalPages);
  });

  it('does no work after cancellation before the batch starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const convert = vi.fn(async (source: Source) => copyOf(source));
    await expect(
      prepareEditingCopies([publisher('first')], convert, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(convert).not.toHaveBeenCalled();
  });

  it.each(['page count', 'identity', 'still restricted'])(
    'rejects an invalid converted source: %s',
    async (reason) => {
      const first = publisher('first');
      const invalid = copyOf(first);
      if (reason === 'page count') invalid.pages = 1;
      if (reason === 'identity') invalid.id = first.id;
      if (reason === 'still restricted') invalid.editable = false;
      await expect(
        prepareEditingCopies([first], async () => invalid),
      ).rejects.toThrow('failed verification');
    },
  );

  it('retains geometry, page selection IDs, and source references needed to undo a publisher merge', async () => {
    const first = publisher('first');
    const second = publisher('second');
    const originalPages = pagesForSource(first);
    originalPages[0] = {
      ...originalPages[0],
      rotation: 90,
      crop: { left: 10, right: 12, top: 14, bottom: 16 },
    };
    const replacements = await prepareEditingCopies(
      [first, second],
      async (source) => copyOf(source),
    );
    const currentPages = useEditingCopies(originalPages, replacements);
    expect(currentPages[0]).toEqual({
      ...originalPages[0],
      sourceId: 'first-copy',
    });
    expect(originalPages[0].sourceId).toBe('first');
    const mergedPages = [
      ...currentPages,
      ...pagesForSource(replacements.get('second')!),
    ];
    const project: Project = {
      schemaVersion: 1,
      name: 'Publisher merge',
      sources: [first, ...replacements.values()],
      pages: mergedPages,
      history: [
        {
          label: 'Prepare editing copies and insert PDF pages',
          pages: originalPages,
        },
      ],
      future: [],
    };
    expect(validateProjectSchema(project)).toEqual(project);
    expect(classifyPagePlan(project.pages, project.sources).kind).toBe(
      'assemble',
    );
    expect(
      classifyPagePlan(project.history[0].pages, project.sources).kind,
    ).toBe('preserve');
  });
});
