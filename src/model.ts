import { validateOptimization } from './optimization';
import type { OptimizationSettings } from './optimization';
export interface Source {
  id: string;
  path: string;
  name: string;
  bytes: number;
  sha256: string;
  kind: string;
  features: string[];
  editable: boolean;
  /** Native preflight capabilities; old projects are refreshed when reopened. */
  preserveDocument?: boolean;
  canCreateEditingCopy?: boolean;
  removedFeatures?: string[];
  pages: number;
  provenance?: {
    kind: string;
    sources: {
      name: string;
      path: string;
      sha256: string;
      bytes: number;
      kind: string;
    }[];
    settings: Record<string, unknown>;
  };
}
export interface Crop {
  left: number;
  bottom: number;
  right: number;
  top: number;
}
export interface Resize {
  width: number;
  height: number;
  mode: 'bounds' | 'fit' | 'stretch';
  anchor: 'center' | 'bottom-left';
  margin: number;
}
export interface Page {
  id: string;
  sourceId: string | null;
  page: number;
  rotation: number;
  crop?: Crop;
  resize?: Resize;
  blank?: { width: number; height: number };
}
export interface Snapshot {
  label: string;
  pages: Page[];
}
export interface Project {
  schemaVersion: 1;
  name: string;
  sources: Source[];
  pages: Page[];
  history: Snapshot[];
  future: Snapshot[];
  optimization?: OptimizationSettings;
}
export interface ExportReport {
  path: string;
  bytes: number;
  inputBytes: number;
  sha256: string;
  elapsedMs: number;
  optimization?:
    | (OptimizationSettings & {
        changedImageObjects: number;
        jpegQuality: number | null;
      })
    | null;
  validation: string[];
  source: Source;
}
export function pagesForSource(source: Source): Page[] {
  return Array.from({ length: source.pages }, (_, i) => ({
    id: crypto.randomUUID(),
    sourceId: source.id,
    page: i + 1,
    rotation: 0,
  }));
}
export function formatBytes(n: number): string {
  return n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(2)} MB`;
}
export function parseRanges(text: string, max: number): number[] {
  const out: number[] = [];
  for (const part of text.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error('Use page numbers or ranges, such as 1, 3-5.');
    const a = Number(m[1]),
      b = Number(m[2] ?? m[1]);
    if (a < 1 || b < a || b > max)
      throw new Error(
        `Pages must be between 1 and ${max}, in ascending ranges.`,
      );
    for (let i = a; i <= b; i++) if (!out.includes(i)) out.push(i);
  }
  if (!out.length) throw new Error('Choose at least one page.');
  return out;
}
export function validatePageReferences(pages: Page[], sources: Source[]) {
  if (!pages.length || pages.length > 1000)
    throw new Error('A project must contain 1 to 1,000 pages.');
  for (const p of pages) {
    if (p.sourceId) {
      const s = sources.find((s) => s.id === p.sourceId);
      if (!s) throw new Error('A source file is missing. Reopen the project.');
      if (!Number.isInteger(p.page) || p.page < 1 || p.page > s.pages)
        throw new Error('Invalid source-page reference.');
    } else if (!p.blank)
      throw new Error('Page has no source or blank paper size.');
    if (!Number.isFinite(p.rotation) || p.rotation % 90)
      throw new Error('Rotation must be a multiple of 90 degrees.');
    if (
      p.crop &&
      Object.values(p.crop).some((n) => !Number.isFinite(n) || n < 0)
    )
      throw new Error('Crop margins must be finite, nonnegative numbers.');
    if (p.resize) {
      const r = p.resize;
      if (
        ![r.width, r.height, r.margin].every(Number.isFinite) ||
        r.width < 12 ||
        r.height < 12 ||
        r.width > 14400 ||
        r.height > 14400 ||
        r.margin < 0 ||
        r.margin * 2 >= Math.min(r.width, r.height)
      )
        throw new Error(
          'Paper must be 12–14,400 points, with margins smaller than half its size.',
        );
      if (
        !['bounds', 'fit', 'stretch'].includes(r.mode) ||
        !['center', 'bottom-left'].includes(r.anchor)
      )
        throw new Error('Unknown resize setting.');
    }
  }
}

/** All original pages exactly once, in original order; geometry may differ. */
export function completeSource(
  pages: Page[],
  sources: Source[],
): Source | undefined {
  const source = sources.find((item) => item.id === pages[0]?.sourceId);
  return source &&
    source.pages === pages.length &&
    pages.every(
      (page, index) =>
        page.sourceId === source.id && page.page === index + 1 && !page.blank,
    )
    ? source
    : undefined;
}

export type PagePlan =
  | { kind: 'unchanged' | 'preserve'; source: Source }
  | { kind: 'assemble' };

/** Capability checks apply to the operation, never just to feature presence. */
export function classifyPagePlan(pages: Page[], sources: Source[]): PagePlan {
  validatePageReferences(pages, sources);
  const source = completeSource(pages, sources);
  if (
    source &&
    pages.every((page) => !page.rotation && !page.crop && !page.resize)
  )
    return { kind: 'unchanged', source };
  const restricted = sources.filter(
    (item) => !item.editable && pages.some((page) => page.sourceId === item.id),
  );
  if (!restricted.length) return { kind: 'assemble' };
  if (source?.preserveDocument && pages.every((page) => !page.resize))
    return { kind: 'preserve', source };
  const features = restricted
    .map((item) => `${item.name}: ${item.features.join(', ')}`)
    .join('; ');
  throw new Error(
    `This operation cannot preserve the document structures (${features}). Keep all original pages in order for supported rotation/crop, or create an editing copy when available before changing page membership, order, or content size.`,
  );
}

export function validatePages(pages: Page[], sources: Source[]) {
  classifyPagePlan(pages, sources);
}
export function validateProjectSchema(value: unknown): Project {
  const p = value as Project;
  if (
    !p ||
    p.schemaVersion !== 1 ||
    typeof p.name !== 'string' ||
    p.name.length > 200 ||
    !Array.isArray(p.sources) ||
    !Array.isArray(p.pages) ||
    !Array.isArray(p.history) ||
    !Array.isArray(p.future)
  )
    throw new Error('This is not a valid version 1 PDF Workbench project.');
  if (
    p.sources.length > 2000 ||
    p.history.length > 100 ||
    p.future.length > 100
  )
    throw new Error('Project exceeds history/source limits.');
  if (p.optimization !== undefined) validateOptimization(p.optimization);
  const sourceIds = new Set<string>();
  for (const s of p.sources) {
    if (
      !s ||
      typeof s.id !== 'string' ||
      sourceIds.has(s.id) ||
      typeof s.path !== 'string' ||
      typeof s.name !== 'string' ||
      typeof s.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(s.sha256) ||
      !Number.isInteger(s.pages) ||
      s.pages < 1 ||
      s.pages > 1000 ||
      !Number.isFinite(s.bytes) ||
      s.bytes < 1 ||
      s.bytes > 50 * 1024 * 1024 ||
      !Array.isArray(s.features) ||
      s.features.some((f) => typeof f !== 'string')
    )
      throw new Error('Project contains invalid source metadata.');
    sourceIds.add(s.id);
  }
  const validate = (pages: Page[]) => {
    if (!Array.isArray(pages)) throw new Error('Invalid project page history.');
    const ids = new Set();
    for (const page of pages) {
      if (!page || typeof page.id !== 'string' || ids.has(page.id))
        throw new Error('Project pages must have unique stable IDs.');
      ids.add(page.id);
    }
    validatePageReferences(pages, p.sources);
  };
  validate(p.pages);
  for (const entry of [...p.history, ...p.future]) {
    if (!entry || typeof entry.label !== 'string')
      throw new Error('Invalid project operation history.');
    validate(entry.pages);
  }
  return p;
}
