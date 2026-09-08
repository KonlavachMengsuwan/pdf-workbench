import type { OptimizationPreset } from '../optimization';
import { invoke } from '@tauri-apps/api/core';
import {
  getDocument,
  GlobalWorkerOptions,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import GeometryWorker from './geometry.worker?worker';
import type { Source, Page, Project, ExportReport } from '../model';
import { classifyPagePlan, validateProjectSchema } from '../model';
import { extractPageText } from './text';
export { extractPageText } from './text';
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const CHUNK = 128 * 1024;
export const pickSources = async (
  kind: 'pdf' | 'images',
  signal?: AbortSignal,
) => {
  const sources = await nativeJob<Source[]>('pick_sources', { kind }, signal);
  check(signal);
  return sources;
};
export const saveProject = (project: Project, signal?: AbortSignal) =>
  nativeJob<string | null>('save_project', { project }, signal);
export const openProject = async (signal?: AbortSignal) => {
  const r = await nativeJob<{
    path: string;
    project: Project;
    sources: Source[];
  } | null>('open_project', {}, signal);
  check(signal);
  if (r) {
    r.sources = r.sources.map((s) => ({
      ...s,
      provenance: r.project.sources.find((p) => p.id === s.id)?.provenance,
    }));
    r.project = validateProjectSchema({ ...r.project, sources: r.sources });
  }
  return r;
};
export const restoreProject = async (
  project: Project,
  signal?: AbortSignal,
) => {
  const result = await nativeJob<{ project: Project; sources: Source[] }>(
    'restore_project',
    { project },
    signal,
  );
  check(signal);
  return validateProjectSchema({
    ...result.project,
    sources: result.sources.map((s) => ({
      ...s,
      provenance: project.sources.find((p) => p.id === s.id)?.provenance,
    })),
  });
};
export const engineInfo = () => invoke<unknown>('engine_info');
function check(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException('Operation cancelled.', 'AbortError');
}
export async function readSource(source: Source, signal?: AbortSignal) {
  if (source.bytes > 50 * 1024 * 1024)
    throw new Error('This release supports files up to 50 MiB.');
  const result = new Uint8Array(source.bytes);
  for (let offset = 0; offset < source.bytes; offset += CHUNK) {
    check(signal);
    const data = await invoke<ArrayBuffer>('read_chunk', {
      id: source.id,
      offset,
      length: Math.min(CHUNK, source.bytes - offset),
    });
    result.set(new Uint8Array(data), offset);
  }
  check(signal);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', result)),
  )
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
  if (digest !== source.sha256)
    throw new Error(
      'Source content changed since opening. Reopen it before continuing.',
    );
  return result;
}
export async function loadPdf(source: Source, signal?: AbortSignal) {
  const bytes = await readSource(source, signal);
  check(signal);
  const task = getDocument({
    data: bytes,
    enableXfa: false,
    useSystemFonts: true,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    disableAutoFetch: true,
  });
  let destroying: Promise<void> | undefined;
  const destroy = () => (destroying ??= task.destroy().catch(() => {}));
  let rejectCancellation!: (error: DOMException) => void;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const abort = () => {
    void destroy();
    rejectCancellation(new DOMException('Operation cancelled.', 'AbortError'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const doc = await Promise.race([task.promise, cancellation]);
    check(signal);
    return doc;
  } catch (error) {
    await destroy();
    check(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
function workerJob(
  message: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    check(signal);
    const worker = new GeometryWorker();
    const cancel = () => {
      worker.terminate();
      reject(new DOMException('Operation cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', cancel);
    };
    worker.onmessage = (e) => {
      finish();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(new Uint8Array(e.data.bytes));
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message));
    };
    const transfer: Transferable[] = [];
    if (message.bytes instanceof Uint8Array)
      transfer.push(message.bytes.buffer as ArrayBuffer);
    if (Array.isArray(message.images))
      for (const item of message.images)
        if (item.bytes instanceof Uint8Array)
          transfer.push(item.bytes.buffer as ArrayBuffer);
    worker.postMessage(message, transfer);
  });
}
export async function stageBytes(
  bytes: Uint8Array,
  name: string,
  kind: string,
  signal?: AbortSignal,
) {
  check(signal);
  if (bytes.length > 50 * 1024 * 1024)
    throw new Error(
      'Output exceeds the 50 MiB limit. Use fewer pages or lower image resolution.',
    );
  const id = await invoke<string>('begin_stage', { name, kind });
  try {
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      check(signal);
      await invoke('write_chunk', {
        id,
        offset,
        data: Array.from(bytes.subarray(offset, offset + CHUNK)),
      });
    }
    check(signal);
    const staged = await nativeJob<Source>('finish_stage', { id }, signal);
    check(signal);
    return staged;
  } catch (error) {
    await invoke('discard_stage', { id }).catch(() => {});
    throw error;
  }
}
async function nativeJob<T>(
  command: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  check(signal);
  const jobId = crypto.randomUUID();
  const cancel = () => {
    void invoke('cancel_job', { jobId });
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await invoke<T>(command, { ...args, jobId });
    return result;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
export async function materialize(
  pages: Page[],
  sources: Source[],
  status: (s: string) => void,
  signal?: AbortSignal,
): Promise<Source> {
  const plan = classifyPagePlan(pages, sources);
  check(signal);
  if (plan.kind === 'unchanged') return plan.source;
  if (plan.kind === 'preserve') {
    status('Updating page geometry while preserving document structures…');
    const source = await nativeJob<Source>(
      'preserve_document',
      {
        id: plan.source.id,
        pages: pages.map(({ page, rotation, crop }) => ({
          page,
          rotation,
          crop,
        })),
      },
      signal,
    );
    check(signal);
    return source;
  }
  let blanks: Source | undefined;
  const empty = pages.filter((p) => !p.sourceId);
  if (empty.length) {
    status('Creating blank pages…');
    const bytes = await workerJob({ type: 'blank', pages: empty }, signal);
    blanks = await stageBytes(bytes, 'Blank pages.pdf', 'pdf', signal);
  }
  status('Assembling pages with qpdf…');
  let bi = 0;
  const structural = pages.map((p) => ({
    sourceId: p.sourceId ?? blanks!.id,
    page: p.sourceId ? p.page : ++bi,
    rotation: p.rotation,
  }));
  const assembled = await nativeJob<Source>(
    'assemble',
    { pages: structural },
    signal,
  );
  if (!pages.some((p) => p.crop || p.resize)) return assembled;
  status('Applying page geometry…');
  const bytes = await workerJob(
    {
      type: 'geometry',
      bytes: await readSource(assembled, signal),
      pages: pages.map((p) => ({ ...p, rotation: 0 })),
    },
    signal,
  );
  return stageBytes(bytes, 'Workbench preview.pdf', 'pdf', signal);
}

/** Called only after the app presents and receives explicit removal consent. */
export async function createEditingCopy(
  source: Source,
  status: (message: string) => void,
  signal?: AbortSignal,
): Promise<Source> {
  if (!source.canCreateEditingCopy)
    throw new Error('An editing copy is not supported for this document.');
  status('Creating an editing copy with document features removed…');
  const result = await nativeJob<Source>(
    'create_editing_copy',
    { id: source.id },
    signal,
  );
  check(signal);
  if (!result.editable)
    throw new Error(
      'The editing copy still contains unsupported structures; no new project was opened.',
    );
  const engines = await engineInfo();
  check(signal);
  return {
    ...result,
    provenance: {
      kind: 'editing-copy',
      sources: [
        {
          name: source.name,
          path: source.path,
          sha256: source.sha256,
          bytes: source.bytes,
          kind: source.kind,
        },
      ],
      settings: {
        consent: 'Explicit in-app confirmation to remove document features',
        removedFeatures:
          result.removedFeatures ??
          source.features.filter(
            (feature) => !result.features.includes(feature),
          ),
        inputFeatures: source.features,
        remainingFeatures: result.features,
        visiblePageContent: 'Preserved without rasterization',
        operation: 'create_editing_copy',
        engines,
      },
    },
  };
}
export async function imagesToPdf(
  sources: Source[],
  status: (s: string) => void,
  signal?: AbortSignal,
) {
  if (sources.reduce((n, s) => n + s.bytes, 0) > 50 * 1024 * 1024)
    throw new Error(
      'Selected images exceed 50 MiB in total. Import them in smaller groups.',
    );
  status('Embedding original image samples…');
  const images = [];
  for (const source of sources) {
    check(signal);
    images.push({ bytes: await readSource(source, signal), kind: source.kind });
  }
  const bytes = await workerJob({ type: 'images', images }, signal);
  const result = await stageBytes(bytes, 'Images.pdf', 'pdf', signal);
  return {
    ...result,
    provenance: {
      kind: 'images',
      sources: sources.map(({ name, path, sha256, bytes, kind }) => ({
        name,
        path,
        sha256,
        bytes,
        kind,
      })),
      settings: {
        pixelsPerPoint: 1,
        maxPaperPoints: 14400,
        engine: 'pdf-lib 1.17.1',
        jpegRecompression: false,
      },
    },
  };
}
export async function exportPdf(
  source: Source,
  suggestedName: string,
  optimization: OptimizationPreset | null,
  project: Project,
  status: (s: string) => void,
  signal?: AbortSignal,
) {
  status(
    optimization
      ? 'Compressing and verifying the exported PDF…'
      : 'Validating export copy…',
  );
  const engines = await engineInfo();
  return nativeJob<ExportReport | null>(
    'export_file',
    {
      id: source.id,
      suggestedName,
      optimization,
      recipe: {
        schemaVersion: 1,
        project,
        engines,
        exportOptions: {
          optimization: optimization
            ? { schemaVersion: 1, preset: optimization }
            : null,
        },
        timestamp: new Date().toISOString(),
      },
    },
    signal,
  );
}
export async function exportImages(
  source: Source,
  pages: number[],
  options: {
    format: 'png' | 'jpg';
    dpi: number;
    quality: number;
    transparent: boolean;
  },
  status: (s: string) => void,
  signal?: AbortSignal,
) {
  if (!Number.isFinite(options.dpi) || options.dpi < 36 || options.dpi > 600)
    throw new Error('Resolution must be 36–600 DPI.');
  const doc = await loadPdf(source, signal);
  const items = [];
  try {
    for (let i = 0; i < pages.length; i++) {
      check(signal);
      status(`Rendering image ${i + 1} of ${pages.length}…`);
      const page = await doc.getPage(pages[i]);
      const viewport = page.getViewport({ scale: options.dpi / 72 });
      if (viewport.width * viewport.height > 40_000_000)
        throw new Error('Image exceeds 40 megapixels. Choose a lower DPI.');
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d')!;
      const task = page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        background:
          options.format === 'png' && options.transparent
            ? 'rgba(0,0,0,0)'
            : 'rgb(255,255,255)',
      });
      const abort = () => task.cancel();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await task.promise;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
      check(signal);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Image encoding failed.'))),
          options.format === 'png' ? 'image/png' : 'image/jpeg',
          options.quality,
        ),
      );
      const name = `page-${String(pages[i]).padStart(4, '0')}.${options.format}`;
      const staged = await stageBytes(
        new Uint8Array(await blob.arrayBuffer()),
        name,
        options.format,
        signal,
      );
      items.push({ id: staged.id, name });
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
    return nativeJob<ExportReport[] | null>(
      'export_batch',
      {
        items,
        recipe: {
          schemaVersion: 1,
          sourceHash: source.sha256,
          pages,
          options,
          engines: await engineInfo(),
        },
      },
      signal,
    );
  } finally {
    await doc.loadingTask.destroy();
  }
}
export async function exportText(
  source: Source,
  pages: number[],
  status: (s: string) => void,
  signal?: AbortSignal,
) {
  const doc = await loadPdf(source, signal);
  const text = [];
  try {
    for (let i = 0; i < pages.length; i++) {
      check(signal);
      status(`Extracting text ${i + 1} of ${pages.length}…`);
      const page = await doc.getPage(pages[i]);
      const content = await extractPageText(page, signal);
      text.push(
        `--- Page ${pages[i]} ---\n` +
          content.items
            .map((item) =>
              'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '',
            )
            .join(''),
      );
    }
    const bytes = new TextEncoder().encode(text.join('\n\n'));
    const staged = await stageBytes(bytes, 'extracted-text.txt', 'txt', signal);
    return nativeJob<ExportReport | null>(
      'export_file',
      {
        id: staged.id,
        suggestedName: 'extracted-text.txt',
        optimization: null,
        recipe: {
          schemaVersion: 1,
          sourceHash: source.sha256,
          pages,
          method:
            'PDF.js selectable text; no OCR; reading order may differ from layout',
        },
      },
      signal,
    );
  } finally {
    await doc.loadingTask.destroy();
  }
}
export async function splitPdf(
  project: Project,
  groups: number[][],
  status: (s: string) => void,
  signal?: AbortSignal,
) {
  if (
    project.sources.some(
      (source) =>
        !source.editable &&
        project.pages.some((page) => page.sourceId === source.id),
    )
  )
    throw new Error(
      'Splitting this document requires an editing copy because its page-level destinations and document structure must be remapped.',
    );
  const items = [];
  for (let i = 0; i < groups.length; i++) {
    check(signal);
    status(`Preparing split ${i + 1} of ${groups.length}…`);
    const pages = groups[i].map((n) => {
      const p = project.pages[n - 1];
      if (!p) throw new Error('Split range outside document.');
      return p;
    });
    const source = await materialize(pages, project.sources, status, signal);
    items.push({
      id: source.id,
      name: `split-${String(i + 1).padStart(2, '0')}.pdf`,
    });
  }
  return nativeJob<ExportReport[] | null>(
    'export_batch',
    {
      items,
      recipe: {
        schemaVersion: 1,
        project,
        groups,
        engines: await engineInfo(),
      },
    },
    signal,
  );
}
export async function recordMetric(name: string, durationMs: number) {
  if ('__TAURI_INTERNALS__' in window)
    await invoke('record_metric', { name, durationMs }).catch(() => {});
}
