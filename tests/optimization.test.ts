import { describe, expect, it, vi } from 'vitest';
import { validateProjectSchema, type Project, type Source } from '../src/model';
import { optimizationPresets } from '../src/optimization';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: {},
}));
vi.mock('../src/adapters/geometry.worker?worker', () => ({
  default: class {},
}));
import { exportPdf } from '../src/adapters/workbench';

const project: Project = {
  schemaVersion: 1,
  name: 'Owned example',
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
const source: Source = {
  id: 'input',
  path: '/fixture/example.pdf',
  name: 'example.pdf',
  bytes: 800,
  sha256: 'a'.repeat(64),
  kind: 'pdf',
  pages: 1,
  editable: true,
  features: [],
};
describe('optimization export and project compatibility', () => {
  it('old projects retain the lossless default; unknown settings fail explicitly', () => {
    expect(validateProjectSchema(project).optimization).toBeUndefined();
    for (const preset of optimizationPresets) {
      const saved = JSON.parse(
        JSON.stringify({
          ...project,
          optimization: { schemaVersion: 1, preset: preset.id },
        }),
      );
      expect(validateProjectSchema(saved).optimization?.preset).toBe(preset.id);
    }
    expect(() =>
      validateProjectSchema({
        ...project,
        optimization: { schemaVersion: 2, preset: 'images-small' },
      }),
    ).toThrow('settings');
    expect(() =>
      validateProjectSchema({
        ...project,
        optimization: { schemaVersion: 1, preset: 'unknown' },
      }),
    ).toThrow('settings');
  });
  it('regular export stays a copy even when the project has a lossy preference', async () => {
    invoke.mockReset();
    invoke.mockResolvedValue(null);
    const preference: Project = {
      ...project,
      optimization: { schemaVersion: 1, preset: 'images-small' },
    };
    await exportPdf(source, 'copy.pdf', null, preference, vi.fn());
    expect(invoke).toHaveBeenLastCalledWith(
      'export_file',
      expect.objectContaining({
        optimization: null,
        recipe: expect.objectContaining({
          exportOptions: { optimization: null },
        }),
      }),
    );
  });
  it('records the chosen preset and engine inventory in the export receipt', async () => {
    invoke.mockReset();
    invoke.mockImplementation(async (command) =>
      command === 'engine_info' ? { qpdf: '12.4.1' } : null,
    );
    await exportPdf(
      source,
      'balanced.pdf',
      'images-balanced',
      project,
      vi.fn(),
    );
    expect(invoke).toHaveBeenLastCalledWith(
      'export_file',
      expect.objectContaining({
        optimization: 'images-balanced',
        recipe: expect.objectContaining({
          engines: { qpdf: '12.4.1' },
          exportOptions: {
            optimization: { schemaVersion: 1, preset: 'images-balanced' },
          },
        }),
      }),
    );
  });
});
