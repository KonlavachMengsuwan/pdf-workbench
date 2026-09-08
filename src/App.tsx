import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Copy,
  Crop,
  Download,
  FileImage,
  FilePlus2,
  FileStack,
  FileText,
  FolderOpen,
  Grid2X2,
  ImagePlus,
  Layers,
  Loader2,
  Maximize2,
  Minus,
  Monitor,
  Moon,
  MousePointer2,
  Move,
  PanelLeftClose,
  Plus,
  Redo2,
  RotateCw,
  Save,
  Scissors,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ExportReport, Page, Project, Source } from './model';
import {
  completeSource,
  formatBytes,
  pagesForSource,
  parseRanges,
} from './model';
import * as workbench from './adapters/workbench';
import { PdfCanvas } from './components/PdfCanvas';
import {
  editingCopyCandidates,
  prepareEditingCopies,
  useEditingCopies,
} from './editingCopies';

import { optimizationPresets } from './optimization';

type Theme = 'light' | 'dark' | 'system';
type Task = 'organize' | 'convert' | 'optimize';
type Inspector = 'pages' | 'crop' | 'resize' | 'split';
type EditingCopyRequest = {
  kind: 'current' | 'open' | 'insert';
  candidates: Source[];
  incoming: Source[];
};
const emptyProject = (): Project => ({
  schemaVersion: 1,
  name: 'Untitled project',
  sources: [],
  pages: [],
  history: [],
  future: [],
});
const uid = () => crypto.randomUUID();
const paperSizes: Record<string, [number, number]> = {
  A4: [595.276, 841.89],
  Letter: [612, 792],
  A3: [841.89, 1190.551],
  Legal: [612, 1008],
};
const shortName = (name: string) =>
  name.replace(/\.(pdf|pdfworkbench|json)$/i, '');
const readPreference = <T,>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

function Button({
  icon: Icon,
  children,
  className = '',
  ...props
}: {
  icon?: LucideIcon;
  children?: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`button ${className}`} {...props}>
      {Icon && <Icon size={16} strokeWidth={1.8} />}
      {children}
    </button>
  );
}
function IconButton({
  icon: Icon,
  label,
  ...props
}: {
  icon: LucideIcon;
  label: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className="icon-button" title={label} aria-label={label} {...props}>
      <Icon size={17} strokeWidth={1.8} />
    </button>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export default function App() {
  const [project, setProject] = useState<Project>(emptyProject);
  const [selection, setSelection] = useState<string[]>([]);
  const [active, setActive] = useState('');
  const selectionAnchor = useRef('');
  const dragPages = useRef<string[]>([]);
  const [dropTarget, setDropTarget] = useState('');
  const [task, setTask] = useState<Task>('organize');
  const [inspector, setInspector] = useState<Inspector>('pages');
  const [theme, setTheme] = useState<Theme>(() =>
    readPreference('pdfw.theme', 'system'),
  );
  const [grid, setGrid] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState<'page' | 'width'>('page');
  const [search, setSearch] = useState('');
  const [searchHits, setSearchHits] = useState<number[]>([]);
  const [searching, setSearching] = useState(false);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [previewSource, setPreviewSource] = useState<Source | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewRenderFailed, setPreviewRenderFailed] = useState('');
  const [job, setJob] = useState('');
  const [status, setStatus] = useState('Your files stay on this computer.');
  const [error, setError] = useState('');
  const [reports, setReports] = useState<ExportReport[]>([]);
  const [savedPath, setSavedPath] = useState('');
  const [editingCopyRequest, setEditingCopyRequest] =
    useState<EditingCopyRequest | null>(null);
  const [editingCopyAccepted, setEditingCopyAccepted] = useState(false);
  const editingCopyDialog = useRef<HTMLDialogElement>(null);
  const [recovery, setRecovery] = useState(() =>
    readPreference<(Project & { savedPath?: string; savedAt?: string }) | null>(
      'pdfw.recovery',
      null,
    ),
  );
  const [range, setRange] = useState('');
  const [splitRanges, setSplitRanges] = useState('1');
  const [cropMargins, setCropMargins] = useState({
    left: 18,
    bottom: 18,
    right: 18,
    top: 18,
  });
  const [paper, setPaper] = useState('A4');
  const [resize, setResize] = useState({
    width: 595.276,
    height: 841.89,
    mode: 'fit' as 'bounds' | 'fit' | 'stretch',
    anchor: 'center' as 'center' | 'bottom-left',
    margin: 0,
  });
  const [format, setFormat] = useState<'png' | 'jpg'>('png');
  const [dpi, setDpi] = useState(144);
  const [quality, setQuality] = useState(90);
  const [transparent, setTransparent] = useState(false);
  const [resourceMode, setResourceMode] = useState(() =>
    readPreference('pdfw.resourceMode', 'balanced'),
  );
  const jobController = useRef<AbortController | null>(null);
  const previewController = useRef<AbortController | null>(null);
  const previewStarted = useRef(0);
  const measuredPreview = useRef('');
  const measuredThumbnail = useRef('');
  const activeIndex = Math.max(
    0,
    project.pages.findIndex((page) => page.id === active),
  );
  const selectedPages = project.pages.filter((page) =>
    selection.includes(page.id),
  );
  const activePage = project.pages[activeIndex];
  const source = project.sources.find(
    (item) => item.id === activePage?.sourceId,
  );
  const blockedSources = project.sources.filter(
    (item) =>
      !item.editable && project.pages.some((page) => page.sourceId === item.id),
  );
  const editable = blockedSources.length === 0;
  const fullSource = completeSource(project.pages, project.sources);
  const preserveGeometry = Boolean(
    fullSource?.preserveDocument && project.pages.every((page) => !page.resize),
  );
  const operationKey = JSON.stringify(project.pages);
  const previewCurrent = Boolean(
    document && previewSource && previewKey === operationKey && !previewBusy,
  );
  const busy = Boolean(job || previewBusy);
  const canEdit = project.pages.length > 0 && editable && !busy;
  const canRotate =
    project.pages.length > 0 && (editable || preserveGeometry) && !busy;
  const canCrop = canRotate;
  const canExport = previewCurrent && !busy && !previewRenderFailed;
  const canExtract = canExport && editable;
  const optimizationPreset =
    project.optimization?.preset ?? 'lossless-thorough';
  const optimizationChoice = optimizationPresets.find(
    (item) => item.id === optimizationPreset,
  )!;
  const canOptimize =
    canExport &&
    Boolean(previewSource?.editable || previewSource?.preserveDocument);
  const editingCopyAvailable =
    blockedSources.length > 0 &&
    blockedSources.every((item) => item.canCreateEditingCopy);
  const canInsertPdf =
    project.pages.length > 0 && (editable || editingCopyAvailable) && !busy;
  const editingCopiesInUse = project.sources.filter(
    (item) =>
      item.provenance?.kind === 'editing-copy' &&
      project.pages.some((page) => page.sourceId === item.id),
  );
  const assemblyRestriction =
    'This document’s bookmarks, links, tags, or other structures need their original page membership and order. Create an editing copy to remove those features before rearranging or resizing content.';
  const selectedLabel = `${selection.length} ${selection.length === 1 ? 'page' : 'pages'} selected`;
  const selectedNumbers = project.pages.flatMap((page, index) =>
    selection.includes(page.id) ? [index + 1] : [],
  );
  const totalInput = project.sources
    .filter((item) => project.pages.some((page) => page.sourceId === item.id))
    .reduce((sum, item) => sum + item.bytes, 0);

  useEffect(() => {
    void workbench.recordMetric('frontend-ready-ms', performance.now());
  }, []);

  useEffect(() => {
    const dialog = editingCopyDialog.current;
    if (!dialog) return;
    if (editingCopyRequest && !dialog.open) dialog.showModal();
    else if (!editingCopyRequest && dialog.open) dialog.close();
  }, [editingCopyRequest]);

  useEffect(() => {
    localStorage.setItem('pdfw.theme', JSON.stringify(theme));
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      (window.document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    if (!project.pages.length) return;
    try {
      localStorage.setItem(
        'pdfw.recovery',
        JSON.stringify({
          ...project,
          savedPath,
          savedAt: new Date().toISOString(),
        }),
      );
    } catch {
      /* A full browser store must never lose a workbench session. */
    }
  }, [project, savedPath]);

  useEffect(() => {
    if (!project.pages.length) return;
    const controller = new AbortController();
    previewStarted.current = performance.now();
    previewController.current = controller;
    let valid = true;
    setPreviewBusy(true);
    setPreviewKey('');
    setPreviewRenderFailed('');
    const timeout = window.setTimeout(
      () => {
        void (async () => {
          const firstSource = project.sources.find(
            (item) => item.id === project.pages[0]?.sourceId,
          );
          const untouched =
            firstSource &&
            project.pages.length === firstSource.pages &&
            project.pages.every(
              (page, index) =>
                page.sourceId === firstSource.id &&
                page.page === index + 1 &&
                !page.rotation &&
                !page.crop &&
                !page.resize &&
                !page.blank,
            );
          const compiled = untouched
            ? firstSource
            : await workbench.materialize(
                project.pages,
                project.sources,
                (value) => valid && setStatus(value),
                controller.signal,
              );
          if (!valid || controller.signal.aborted) return;
          const nextDocument = await workbench.loadPdf(
            compiled,
            controller.signal,
          );
          if (!valid || controller.signal.aborted) {
            await nextDocument.loadingTask.destroy();
            return;
          }
          setDocument((previous) => {
            if (previous) void previous.loadingTask.destroy();
            return nextDocument;
          });
          setPreviewSource(compiled);
          setPreviewKey(operationKey);
          setError('');
          setStatus(
            `Preview ready · ${project.pages.length} ${project.pages.length === 1 ? 'page' : 'pages'} · source files unchanged`,
          );
        })()
          .catch((e) => {
            if (valid && !controller.signal.aborted) {
              setError(String(e?.message || e));
              setStatus(
                'Preview failed. Export is unavailable until the issue is resolved.',
              );
            }
          })
          .finally(() => {
            if (valid) setPreviewBusy(false);
          });
      },
      resourceMode === 'quiet' ? 500 : 250,
    );
    return () => {
      valid = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [operationKey, project.sources, resourceMode]);

  useEffect(() => {
    let cancelled = false;
    const query = search.trim().toLocaleLowerCase();
    if (!query || !document) {
      setSearchHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    setSearchHits([]);
    const timeout = window.setTimeout(() => {
      void (async () => {
        const hits: number[] = [];
        for (let number = 1; number <= document.numPages; number++) {
          if (cancelled) return;
          const page = await document.getPage(number);
          const content = await workbench.extractPageText(page);
          if (
            content.items
              .map((item) => ('str' in item ? item.str : ''))
              .join(' ')
              .toLocaleLowerCase()
              .includes(query)
          )
            hits.push(number);
        }
        if (!cancelled) {
          setSearchHits(hits);
          setSearching(false);
        }
      })().catch((e) => {
        if (!cancelled) {
          setSearching(false);
          setError(`Text search is unavailable: ${String(e?.message || e)}`);
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [search, document]);

  const run = async (
    label: string,
    action: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (job) return;
    const controller = new AbortController();
    jobController.current = controller;
    setJob(label);
    setStatus(label);
    setError('');
    setReports([]);
    try {
      await action(controller.signal);
    } catch (e) {
      const message = String((e as Error)?.message || e);
      if (controller.signal.aborted) {
        setStatus('Processing stopped. Original files are unchanged.');
        if ((e as Error)?.name !== 'AbortError') setError(message);
      } else {
        setError(message);
        setStatus('The operation could not be completed.');
      }
    } finally {
      setJob('');
      jobController.current = null;
    }
  };

  const selectPage = (
    page: Page,
    event?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  ) => {
    setActive(page.id);
    if (event?.shiftKey && selectionAnchor.current) {
      const rememberedAnchor = project.pages.findIndex(
        (item) => item.id === selectionAnchor.current,
      );
      const anchor = rememberedAnchor >= 0 ? rememberedAnchor : activeIndex;
      const end = project.pages.findIndex((item) => item.id === page.id);
      setSelection(
        project.pages
          .slice(Math.min(anchor, end), Math.max(anchor, end) + 1)
          .map((item) => item.id),
      );
    } else if (event?.metaKey || event?.ctrlKey) {
      if (selection.includes(page.id) && selection.length > 1) {
        const remaining = selection.filter((id) => id !== page.id);
        setSelection(remaining);
        setActive(remaining[remaining.length - 1]);
      } else
        setSelection((previous) =>
          previous.includes(page.id) ? previous : [...previous, page.id],
        );
      selectionAnchor.current = page.id;
    } else {
      setSelection([page.id]);
      selectionAnchor.current = page.id;
    }
  };

  const commit = (
    label: string,
    nextPages: Page[],
    nextSources = project.sources,
  ) => {
    if (!nextPages.length) {
      setError(
        'A PDF needs at least one page. Insert a blank page before deleting the last page.',
      );
      return;
    }
    if (nextPages.length > 1000) {
      setError(
        'This release supports at most 1,000 pages per project. Extract or split a smaller set before adding pages.',
      );
      return;
    }
    setProject((previous) => ({
      ...previous,
      sources: nextSources,
      pages: nextPages,
      history: previous.pages.length
        ? [...previous.history, { label, pages: previous.pages }].slice(-100)
        : [],
      future: [],
    }));
    setSelection((previous) => {
      const remaining = previous.filter((id) =>
        nextPages.some((page) => page.id === id),
      );
      return remaining.length
        ? remaining
        : [nextPages[Math.min(activeIndex, nextPages.length - 1)].id];
    });
    if (!nextPages.some((page) => page.id === active))
      setActive(nextPages[Math.min(activeIndex, nextPages.length - 1)].id);
    setStatus(label);
    setReports([]);
    setError('');
  };

  const openSources = (sources: Source[]) => {
    const pages = sources.flatMap(pagesForSource);
    setProject({
      ...emptyProject(),
      name: shortName(sources[0].name),
      sources,
      pages,
    });
    setSelection([pages[0].id]);
    setActive(pages[0].id);
    selectionAnchor.current = pages[0].id;
    setSavedPath('');
    setRecovery(null);
    setRange('');
    setSearch('');
    setGrid(false);
    setSplitRanges(pages.length > 1 ? `1; 2-${pages.length}` : '1');
  };

  const requestEditingCopies = (
    kind: EditingCopyRequest['kind'],
    incoming: Source[] = [],
  ) => {
    const candidates = editingCopyCandidates([
      ...(kind === 'open' ? [] : blockedSources),
      ...incoming,
    ]);
    setEditingCopyAccepted(false);
    setEditingCopyRequest({ kind, candidates, incoming });
    setStatus(
      'Review the document features before creating separate editing copies.',
    );
  };

  const openPdf = () =>
    run('Opening PDF…', async (signal) => {
      const sources = await workbench.pickSources('pdf', signal);
      if (!sources.length || signal.aborted) {
        setStatus('Open cancelled. The current project is unchanged.');
        return;
      }
      if (sources.reduce((count, item) => count + item.pages, 0) > 1000)
        throw new Error(
          'The selected PDFs total more than 1,000 pages. Open a smaller set of files.',
        );
      if (sources.length > 1 && sources.some((item) => !item.editable)) {
        requestEditingCopies('open', sources);
        return;
      }
      openSources(sources);
    });

  const openSaved = () =>
    run('Opening project…', async (signal) => {
      const result = await workbench.openProject(signal);
      if (!result || signal.aborted) {
        setStatus('Open project cancelled.');
        return;
      }
      setProject({ ...result.project, sources: result.sources });
      setSavedPath(result.path);
      setSearch('');
      setSelection([result.project.pages[0].id]);
      setActive(result.project.pages[0].id);
      setRecovery(null);
      setStatus('Project and source hashes verified.');
    });

  const restore = () =>
    run('Restoring previous session…', async (signal) => {
      if (!recovery) return;
      const restored = await workbench.restoreProject(recovery, signal);
      if (signal.aborted) {
        setStatus(
          'Session restore cancelled. The current project is unchanged.',
        );
        return;
      }
      setProject(restored);
      setSavedPath(recovery.savedPath || '');
      setSearch('');
      setSelection([restored.pages[0].id]);
      setActive(restored.pages[0].id);
      setRecovery(null);
      setStatus('Previous session restored. Source hashes verified.');
    });

  const save = () =>
    run('Saving project…', async (signal) => {
      const path = await workbench.saveProject(project, signal);
      if (path) {
        setSavedPath(path);
        setStatus(`Project saved · ${path}`);
      } else setStatus('Save project cancelled.');
    });

  const confirmEditingCopy = () => {
    if (!editingCopyRequest || !editingCopyAccepted || busy) return;
    const request = editingCopyRequest;
    setEditingCopyRequest(null);
    void run('Preparing PDFs for page editing…', async (signal) => {
      const replacements = await prepareEditingCopies(
        request.candidates,
        (original, cancellation) =>
          workbench.createEditingCopy(
            original,
            (message) => setStatus(`${original.name}: ${message}`),
            cancellation,
          ),
        signal,
      );
      if (signal.aborted) return;
      const incoming = request.incoming.map(
        (item) => replacements.get(item.id) ?? item,
      );
      if (request.kind === 'open') {
        openSources(incoming);
      } else if (request.kind === 'insert') {
        insertSources(incoming, replacements);
      } else {
        commit(
          'Enable page editing',
          useEditingCopies(project.pages, replacements),
          [...project.sources, ...replacements.values()],
        );
      }
      setStatus(
        `${replacements.size} editing ${replacements.size === 1 ? 'copy' : 'copies'} verified. Page editing is available; originals are unchanged. Review the removal receipts in Page settings.`,
      );
    });
  };

  const insertSources = (
    sources: Source[],
    replacements = new Map<string, Source>(),
  ) => {
    const currentPages = useEditingCopies(project.pages, replacements);
    const pages = sources.flatMap(pagesForSource);
    const at = activeIndex + 1;
    const nextSources = [
      ...new Map(
        [...project.sources, ...replacements.values(), ...sources].map(
          (item) => [item.id, item],
        ),
      ).values(),
    ];
    commit(
      replacements.size
        ? 'Prepare editing copies and insert PDF pages'
        : 'Insert PDF pages',
      [...currentPages.slice(0, at), ...pages, ...currentPages.slice(at)],
      nextSources,
    );
    setSelection(pages.map((page) => page.id));
    setActive(pages[0].id);
  };

  const insertPdf = () =>
    run('Adding PDF pages…', async (signal) => {
      const sources = await workbench.pickSources('pdf', signal);
      if (!sources.length || signal.aborted) {
        setStatus('Insert PDF cancelled.');
        return;
      }
      if (
        project.pages.length +
          sources.reduce((count, item) => count + item.pages, 0) >
        1000
      )
        throw new Error(
          'Inserting these PDFs would exceed the 1,000-page project limit.',
        );
      if (blockedSources.length || sources.some((item) => !item.editable)) {
        requestEditingCopies('insert', sources);
        return;
      }
      insertSources(sources);
    });

  const addImages = () =>
    run('Creating PDF from images…', async (signal) => {
      const images = await workbench.pickSources('images', signal);
      if (!images.length || signal.aborted) {
        setStatus('Image import cancelled.');
        return;
      }
      if (project.pages.length + images.length > 1000)
        throw new Error(
          'Inserting these images would exceed the 1,000-page project limit.',
        );
      const imported = await workbench.imagesToPdf(images, setStatus, signal);
      const pages = pagesForSource(imported);
      if (!project.pages.length)
        setProject({
          ...emptyProject(),
          name: shortName(images[0].name),
          sources: [imported],
          pages,
        });
      else
        commit(
          'Insert image pages',
          [
            ...project.pages.slice(0, activeIndex + 1),
            ...pages,
            ...project.pages.slice(activeIndex + 1),
          ],
          [...project.sources, imported],
        );
      setSelection(pages.map((page) => page.id));
      setActive(pages[0].id);
    });

  const undo = useCallback(() => {
    if (busy || !project.history.length) return;
    const previous = project.history[project.history.length - 1];
    setProject({
      ...project,
      pages: previous.pages,
      history: project.history.slice(0, -1),
      future: [
        ...project.future,
        { label: previous.label, pages: project.pages },
      ],
    });
    setSelection([previous.pages[0].id]);
    setActive(previous.pages[0].id);
    setStatus(`Undid ${previous.label.toLocaleLowerCase()}`);
    setError('');
  }, [project, busy]);
  const redo = useCallback(() => {
    if (busy || !project.future.length) return;
    const next = project.future[project.future.length - 1];
    setProject({
      ...project,
      pages: next.pages,
      history: [
        ...project.history,
        { label: next.label, pages: project.pages },
      ],
      future: project.future.slice(0, -1),
    });
    setSelection([next.pages[0].id]);
    setActive(next.pages[0].id);
    setStatus(`Redid ${next.label.toLocaleLowerCase()}`);
    setError('');
  }, [project, busy]);

  const move = (direction: -1 | 1) => {
    const pages = [...project.pages];
    if (direction === -1) {
      for (let i = 1; i < pages.length; i++)
        if (
          selection.includes(pages[i].id) &&
          !selection.includes(pages[i - 1].id)
        )
          [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
    } else {
      for (let i = pages.length - 2; i >= 0; i--)
        if (
          selection.includes(pages[i].id) &&
          !selection.includes(pages[i + 1].id)
        )
          [pages[i], pages[i + 1]] = [pages[i + 1], pages[i]];
    }
    if (pages.some((page, index) => page.id !== project.pages[index].id))
      commit('Reorder pages', pages);
  };
  const rotate = () =>
    commit(
      'Rotate pages clockwise',
      project.pages.map((page) =>
        selection.includes(page.id)
          ? { ...page, rotation: (page.rotation + 90) % 360 }
          : page,
      ),
    );
  const duplicate = () => {
    if (project.pages.length + selectedPages.length > 1000) {
      setError(
        'Duplicating this selection would exceed the 1,000-page project limit.',
      );
      return;
    }
    const copies: string[] = [];
    const pages = project.pages.flatMap((page) => {
      if (!selection.includes(page.id)) return [page];
      const copy = { ...page, id: uid() };
      copies.push(copy.id);
      return [page, copy];
    });
    commit('Duplicate pages', pages);
    setSelection(copies);
    setActive(copies[0]);
  };
  const remove = () =>
    commit(
      'Delete pages',
      project.pages.filter((page) => !selection.includes(page.id)),
    );
  const blank = () => {
    if (project.pages.length >= 1000) {
      setError('This project already has the maximum 1,000 pages.');
      return;
    }
    const page: Page = {
      id: uid(),
      sourceId: null,
      page: 1,
      rotation: 0,
      blank: { width: resize.width, height: resize.height },
    };
    const at = project.pages.length ? activeIndex + 1 : 0;
    commit('Insert blank page', [
      ...project.pages.slice(0, at),
      page,
      ...project.pages.slice(at),
    ]);
    setActive(page.id);
    setSelection([page.id]);
  };

  const exportDocument = (optimize = false, extract = false) =>
    run(
      optimize ? 'Compressing and verifying PDF…' : 'Exporting PDF copy…',
      async (signal) => {
        if (!previewSource || !previewCurrent)
          throw new Error('Wait for the current preview before exporting.');
        if (extract && !editable) throw new Error(assemblyRestriction);
        if (optimize && !canOptimize)
          throw new Error(
            'Optimization is unavailable for this document’s protected structures. Export an unchanged copy instead.',
          );
        const exportSource = extract
          ? await workbench.materialize(
              selectedPages,
              project.sources,
              setStatus,
              signal,
            )
          : previewSource;
        const report = await workbench.exportPdf(
          exportSource,
          `${project.name}${extract ? '-extracted' : optimize ? `-${optimizationPreset}` : '-export'}.pdf`,
          optimize ? optimizationPreset : null,
          extract ? { ...project, pages: selectedPages } : project,
          setStatus,
          signal,
        );
        if (report) {
          setReports([report]);
          setStatus(
            `Export verified · ${formatBytes(report.bytes)} · ${report.path}`,
          );
        } else setStatus('Export cancelled. No output was saved.');
      },
    );
  const conversionPages = () =>
    range.trim() ? parseRanges(range, project.pages.length) : selectedNumbers;
  const exportImages = () =>
    run('Rendering page images…', async (signal) => {
      if (!previewSource) return;
      const results = await workbench.exportImages(
        previewSource,
        conversionPages(),
        {
          format,
          dpi,
          quality: quality / 100,
          transparent: format === 'png' && transparent,
        },
        setStatus,
        signal,
      );
      if (results) {
        setReports(results);
        setStatus(
          `${results.length} ${format.toUpperCase()} ${results.length === 1 ? 'image' : 'images'} exported.`,
        );
      } else setStatus('Image export cancelled. No output was saved.');
    });
  const exportText = () =>
    run('Extracting selectable text…', async (signal) => {
      if (!previewSource) return;
      const report = await workbench.exportText(
        previewSource,
        conversionPages(),
        setStatus,
        signal,
      );
      if (report) {
        setReports([report]);
        setStatus(`Text exported · ${report.path}`);
      } else setStatus('Text export cancelled. No output was saved.');
    });
  const split = () =>
    run('Splitting PDF into copies…', async (signal) => {
      if (!editable) throw new Error(assemblyRestriction);
      const groups = splitRanges
        .split(';')
        .map((group) => parseRanges(group.trim(), project.pages.length));
      if (groups.some((group) => !group.length))
        throw new Error(
          'Enter at least one page in each group, separated by semicolons.',
        );
      const results = await workbench.splitPdf(
        project,
        groups,
        setStatus,
        signal,
      );
      if (results) {
        setReports(results);
        setStatus(`${results.length} split PDFs exported and verified.`);
      } else setStatus('Split cancelled. No output was saved.');
    });

  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (editingCopyRequest) return;
      const typing = (event.target as HTMLElement)?.matches(
        'input, textarea, select, [contenteditable="true"]',
      );
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        if (!busy) void openPdf();
      } else if (command && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!busy && project.pages.length) void save();
      } else if (command && event.key.toLowerCase() === 'z' && !typing) {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (
        !typing &&
        canEdit &&
        event.altKey &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      ) {
        event.preventDefault();
        move(event.key === 'ArrowUp' ? -1 : 1);
      } else if (
        !typing &&
        canEdit &&
        (event.key === 'Delete' || event.key === 'Backspace') &&
        selection.length < project.pages.length
      ) {
        event.preventDefault();
        remove();
      } else if (
        !typing &&
        command &&
        event.key.toLowerCase() === 'a' &&
        project.pages.length
      ) {
        event.preventDefault();
        setSelection(project.pages.map((page) => page.id));
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  const pageTile = (page: Page, index: number, isGrid = false) => {
    const selected = selection.includes(page.id);
    const pageSource = project.sources.find(
      (item) => item.id === page.sourceId,
    );
    return (
      <button
        key={page.id}
        className={`page-tile ${selected ? 'selected' : ''} ${page.id === active ? 'active' : ''} ${dropTarget === page.id ? 'drop-target' : ''} ${isGrid ? 'grid-tile' : ''}`}
        aria-label={`Page ${index + 1}${pageSource ? ` from ${pageSource.name}` : ', blank'}${selected ? ', selected' : ''}`}
        aria-pressed={selected}
        onClick={(event) => selectPage(page, event)}
        onDoubleClick={() => {
          selectPage(page);
          setGrid(false);
        }}
        draggable={canEdit}
        onDragStart={(event) => {
          dragPages.current = selected ? selection : [page.id];
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', page.id);
        }}
        onDragOver={(event) => {
          if (canEdit) {
            event.preventDefault();
            setDropTarget(page.id);
          }
        }}
        onDragLeave={() => setDropTarget('')}
        onDrop={(event) => {
          event.preventDefault();
          setDropTarget('');
          const ids = dragPages.current;
          if (ids.includes(page.id) || !canEdit) return;
          const moving = project.pages.filter((item) => ids.includes(item.id));
          const remaining = project.pages.filter(
            (item) => !ids.includes(item.id),
          );
          const at = remaining.findIndex((item) => item.id === page.id);
          commit('Reorder pages', [
            ...remaining.slice(0, at),
            ...moving,
            ...remaining.slice(at),
          ]);
        }}
        onDragEnd={() => setDropTarget('')}
      >
        <div className="thumbnail-frame">
          {document && index < document.numPages ? (
            <PdfCanvas
              document={document}
              page={index + 1}
              thumbnail
              onRendered={() => {
                if (previewKey && measuredThumbnail.current !== previewKey) {
                  measuredThumbnail.current = previewKey;
                  void workbench.recordMetric(
                    'thumbnail-ms',
                    performance.now() - previewStarted.current,
                  );
                }
              }}
            />
          ) : (
            <FileText size={28} className="muted" />
          )}
          <span className="selection-check">
            {selected ? <Check size={11} /> : ''}
          </span>
          {(Boolean(page.rotation) || page.crop || page.resize) && (
            <span className="page-modified" title="Page has changes">
              <SlidersHorizontal size={10} />
            </span>
          )}
        </div>
        <div className="page-caption">
          <span>{String(index + 1).padStart(2, '0')}</span>
          <small>
            {pageSource
              ? `${shortName(pageSource.name)} · ${page.page}`
              : 'Blank page'}
          </small>
        </div>
      </button>
    );
  };

  const selectedSummary =
    selectedPages.length > 1
      ? `${selectedPages.length} pages`
      : `Page ${activeIndex + 1}`;
  const confirmCrop = () => {
    if (
      Object.values(cropMargins).some(
        (value) => !Number.isFinite(value) || value < 0,
      )
    ) {
      setError('Crop margins must be non-negative numbers in points.');
      return;
    }
    commit(
      'Crop page boundaries',
      project.pages.map((page) =>
        selection.includes(page.id)
          ? { ...page, crop: { ...cropMargins } }
          : page,
      ),
    );
  };
  const confirmResize = () => {
    if (
      ![resize.width, resize.height].every(
        (value) => Number.isFinite(value) && value >= 36 && value <= 14400,
      ) ||
      !Number.isFinite(resize.margin) ||
      resize.margin < 0 ||
      resize.margin * 2 >= Math.min(resize.width, resize.height)
    ) {
      setError(
        'Choose page dimensions between 36 and 14,400 points and a margin smaller than half the page.',
      );
      return;
    }
    commit(
      'Resize pages',
      project.pages.map((page) =>
        selection.includes(page.id) ? { ...page, resize: { ...resize } } : page,
      ),
    );
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <Layers size={22} strokeWidth={1.7} />
          </div>
          <div>
            <strong>PDF Workbench</strong>
            <span>LOCAL DOCUMENT STUDIO</span>
          </div>
        </div>
        <div className="header-divider" />
        <Button
          icon={FolderOpen}
          onClick={() => void openPdf()}
          disabled={busy}
          className="open-button"
        >
          Open PDF
        </Button>
        <IconButton
          icon={BookOpen}
          label="Open saved workbench project"
          onClick={() => void openSaved()}
          disabled={busy}
        />
        <div className="history-buttons">
          <IconButton
            icon={Undo2}
            label="Undo (⌘Z / Ctrl+Z)"
            onClick={undo}
            disabled={busy || !project.history.length}
          />
          <IconButton
            icon={Redo2}
            label="Redo (⌘⇧Z / Ctrl+Shift+Z)"
            onClick={redo}
            disabled={busy || !project.future.length}
          />
        </div>
        <div className="header-spacer" />
        <Button
          icon={Save}
          className="save-button"
          onClick={() => void save()}
          disabled={busy || !project.pages.length}
        >
          Save project
        </Button>
        <Button
          icon={Download}
          className="primary export-button"
          onClick={() => void exportDocument()}
          disabled={!canExport}
        >
          Export PDF
          <ArrowUpRight size={14} />
        </Button>
      </header>

      <nav className="workspace-nav" aria-label="Workspace tools">
        <div className="task-tabs">
          {(
            [
              { id: 'organize', name: 'Organize', icon: Layers },
              { id: 'convert', name: 'Convert', icon: FileImage },
              { id: 'optimize', name: 'Optimize', icon: Sparkles },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={task === item.id ? 'task-tab current' : 'task-tab'}
              onClick={() => setTask(item.id)}
            >
              <item.icon size={16} />
              {item.name}
            </button>
          ))}
        </div>
        <div className="workspace-name">
          {project.pages.length ? (
            <>
              <span className="tiny-dot" />
              {project.name}
              <span className="revision-tag">
                {project.history.length
                  ? `${project.history.length} ${project.history.length === 1 ? 'edit' : 'edits'}`
                  : fullSource?.provenance?.kind === 'editing-copy'
                    ? 'Editing copy'
                    : 'Original'}
              </span>
            </>
          ) : (
            <span>Make room for your next idea.</span>
          )}
        </div>
        <div className="theme-switch" role="group" aria-label="Color theme">
          {(
            [
              { value: 'light', icon: Sun, label: 'Light theme' },
              { value: 'dark', icon: Moon, label: 'Dark theme' },
              { value: 'system', icon: Monitor, label: 'System theme' },
            ] as const
          ).map((item) => (
            <button
              key={item.value}
              aria-label={item.label}
              title={item.label}
              aria-pressed={theme === item.value}
              className={theme === item.value ? 'chosen' : ''}
              onClick={() => setTheme(item.value)}
            >
              <item.icon size={14} />
            </button>
          ))}
        </div>
      </nav>

      {(error || previewRenderFailed) && (
        <div className="error-banner" role="alert">
          <CircleAlert size={17} />
          <span>
            {error ||
              `${previewRenderFailed} PDF export is unavailable until the page renders successfully.`}
          </span>
          {error && (
            <IconButton
              icon={X}
              label="Dismiss error"
              onClick={() => setError('')}
            />
          )}
        </div>
      )}

      {!project.pages.length ? (
        <main className="welcome">
          <div className="welcome-copy">
            <div className="eyebrow">
              <span /> PRIVATE BY DESIGN
            </div>
            <h1>
              A little order.
              <br />
              <span>A clearer document.</span>
            </h1>
            <p>
              Arrange pages, refine the paper, and make the export you need. All
              on your computer, with your originals intact.
            </p>
            <div className="welcome-actions">
              <Button
                icon={FolderOpen}
                className="primary large"
                onClick={() => void openPdf()}
                disabled={busy}
              >
                Open a PDF
                <ArrowUpRight size={17} />
              </Button>
              <Button
                icon={BookOpen}
                className="large"
                onClick={() => void openSaved()}
                disabled={busy}
              >
                Open project
              </Button>
            </div>
            <div className="welcome-secondary">
              <button onClick={() => void addImages()} disabled={busy}>
                <ImagePlus size={15} /> Start from PNG or JPEG
              </button>
              <span>or</span>
              <button onClick={blank} disabled={busy}>
                <FilePlus2 size={15} /> Start with a blank page
              </button>
            </div>
            {recovery && (
              <div className="recovery-note">
                <BookOpen size={17} />
                <div>
                  <strong>Previous session: {recovery.name}</strong>
                  <p>
                    Restore the page arrangement and undo history from this
                    computer.
                  </p>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void restore()}
                  >
                    Restore session <ArrowUpRight size={12} />
                  </button>
                </div>
                <button
                  aria-label="Dismiss session notice"
                  onClick={() => setRecovery(null)}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="welcome-trust">
              <ShieldCheck size={15} /> No account. No upload. Your original
              stays yours.
            </div>
          </div>
          <div className="welcome-art" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="art-page back" />
            <div className="art-page middle" />
            <div className="art-page front">
              <div className="art-kicker">A FRESH PERSPECTIVE</div>
              <div className="art-heading">
                Everything,
                <br />
                in its place.
              </div>
              <div className="art-rule" />
              <div className="art-columns">
                <span />
                <span />
                <span />
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <div className="art-chart">
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
              <div className="art-footer">
                <span>WORKBENCH / 001</span>
                <Layers size={20} />
              </div>
            </div>
            <span className="floating-tag">
              <Check size={13} /> Original preserved
            </span>
          </div>
          <div className="welcome-capabilities">
            <div>
              <Layers size={19} />
              <strong>Find your flow</strong>
              <span>Merge, split, and rearrange pages.</span>
            </div>
            <div>
              <Crop size={19} />
              <strong>Shape the page</strong>
              <span>Crop, rotate, and resize with intent.</span>
            </div>
            <div>
              <Download size={19} />
              <strong>Make it useful</strong>
              <span>Export PDF, images, or selectable text.</span>
            </div>
          </div>
        </main>
      ) : (
        <main className="workspace">
          <aside className="page-rail" aria-label="Document pages">
            <div className="rail-heading">
              <div>
                <strong>Pages</strong>
                <span className="count-badge">{project.pages.length}</span>
              </div>
              <button
                className="text-button"
                onClick={() =>
                  setSelection(project.pages.map((page) => page.id))
                }
              >
                Select all
              </button>
            </div>
            <div className="rail-subtitle">
              <MousePointer2 size={12} /> Shift for range · ⌘ / Ctrl for
              multiple
            </div>
            <div className="thumbnails" aria-label="Page thumbnails">
              {project.pages.map((page, index) => pageTile(page, index))}
            </div>
            <div className="rail-bottom">
              <Button
                icon={FilePlus2}
                onClick={() => void insertPdf()}
                disabled={!canEdit}
              >
                Insert PDF
              </Button>
              <div className="reorder-buttons">
                <IconButton
                  icon={ArrowUp}
                  label="Move selected pages up (Alt+Up)"
                  onClick={() => move(-1)}
                  disabled={
                    !canEdit ||
                    (selectedNumbers[0] === 1 &&
                      selectedNumbers.every(
                        (value, index) => value === index + 1,
                      ))
                  }
                />
                <IconButton
                  icon={ArrowDown}
                  label="Move selected pages down (Alt+Down)"
                  onClick={() => move(1)}
                  disabled={
                    !canEdit ||
                    (selectedNumbers[selectedNumbers.length - 1] ===
                      project.pages.length &&
                      selectedNumbers.every(
                        (value, index) =>
                          value ===
                          project.pages.length -
                            selectedNumbers.length +
                            index +
                            1,
                      ))
                  }
                />
              </div>
            </div>
          </aside>

          <section className="document-stage" aria-label="Document preview">
            <div className="document-toolbar">
              <div className="view-switch">
                <button
                  className={!grid ? 'chosen' : ''}
                  title="Single page preview"
                  aria-label="Single page preview"
                  onClick={() => setGrid(false)}
                >
                  <FileText size={15} />
                </button>
                <button
                  className={grid ? 'chosen' : ''}
                  title="Page grid"
                  aria-label="Page grid"
                  onClick={() => setGrid(true)}
                >
                  <Grid2X2 size={15} />
                </button>
              </div>
              <span className="toolbar-label">
                {grid ? 'Page overview' : 'Document preview'}
              </span>
              <div className="stage-spacer" />
              <div className="search-box">
                <Search size={14} />
                <input
                  aria-label="Search selectable text"
                  placeholder="Find in document"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && (
                  <button
                    aria-label="Clear search"
                    onClick={() => setSearch('')}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>
            {blockedSources.length > 0 && (
              <div className="preservation-banner">
                <ShieldCheck size={16} />
                <div>
                  <strong>
                    {preserveGeometry
                      ? 'Document features preserved'
                      : 'Some page operations are restricted'}
                  </strong>
                  <span>
                    {preserveGeometry
                      ? task === 'optimize'
                        ? 'Optimization keeps page order and supported document features. Image presets may reduce image quality.'
                        : 'Rotate, crop, optimize, and export a copy while keeping the original pages and document structure. Rearranging pages or resizing content requires an editing copy.'
                      : 'Viewing, text/image conversion, and an unchanged PDF copy remain available. Unsupported changes stay disabled to protect document structures.'}
                  </span>
                  <details className="feature-details">
                    <summary>Detected document features</summary>
                    <p>
                      {blockedSources
                        .map(
                          (item) =>
                            `${item.name}: ${item.features.join(', ') || 'unsupported structure'}`,
                        )
                        .join(' · ')}
                    </p>
                  </details>
                  {editingCopyAvailable && task !== 'optimize' && (
                    <Button
                      icon={Copy}
                      className="primary enable-editing-button"
                      disabled={busy}
                      onClick={() => requestEditingCopies('current')}
                    >
                      Enable page editing…
                    </Button>
                  )}
                </div>
              </div>
            )}
            {search && (
              <div className="search-results">
                <span>
                  {searching
                    ? 'Searching pages…'
                    : `${searchHits.length} ${searchHits.length === 1 ? 'page' : 'pages'} with matches`}
                </span>
                {searchHits
                  .filter((page) => page <= project.pages.length)
                  .slice(0, 20)
                  .map((page) => (
                    <button
                      key={page}
                      disabled={!previewCurrent}
                      className={activeIndex === page - 1 ? 'chosen' : ''}
                      onClick={() => {
                        selectPage(project.pages[page - 1]);
                        setGrid(false);
                      }}
                    >
                      {page}
                    </button>
                  ))}
                {searchHits.length > 20 && (
                  <span>+{searchHits.length - 20}</span>
                )}
              </div>
            )}
            <div className={`preview-area ${grid ? 'grid-area' : ''}`}>
              {grid ? (
                <div className="page-grid">
                  {project.pages.map((page, index) =>
                    pageTile(page, index, true),
                  )}
                </div>
              ) : document && activeIndex < document.numPages ? (
                <PdfCanvas
                  document={document}
                  page={activeIndex + 1}
                  zoom={zoom}
                  fit={fit}
                  search={search}
                  onRenderError={setPreviewRenderFailed}
                  onRendered={() => {
                    if (previewKey && measuredPreview.current !== previewKey) {
                      measuredPreview.current = previewKey;
                      void workbench.recordMetric(
                        'first-page-ms',
                        performance.now() - previewStarted.current,
                      );
                    }
                  }}
                />
              ) : (
                <div className="loading-preview">
                  <Loader2 className="spin" size={24} />
                  <span>Preparing the first page…</span>
                </div>
              )}
              {previewBusy && (
                <div className="preview-loading">
                  <Loader2 className="spin" size={14} />
                  Updating preview
                </div>
              )}
              {!previewBusy && !previewCurrent && (
                <div className="stale-preview">
                  Preview is out of date. Undo the last change or resolve the
                  error to continue.
                </div>
              )}
              {!grid && activePage && (
                <div className="page-context">
                  <span>
                    {source ? `SOURCE ${activePage.page}` : 'BLANK PAGE'}
                  </span>
                  {activePage.rotation !== 0 && (
                    <span>
                      <RotateCw size={11} /> {activePage.rotation}°
                    </span>
                  )}
                  {activePage.crop && (
                    <span>
                      <Crop size={11} /> Cropped
                    </span>
                  )}
                  {activePage.resize && (
                    <span>
                      <Maximize2 size={11} />{' '}
                      {Math.round(activePage.resize.width)} ×{' '}
                      {Math.round(activePage.resize.height)} pt
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="view-controls">
              <div className="page-navigation">
                <IconButton
                  icon={ChevronLeft}
                  label="Previous page"
                  disabled={activeIndex === 0}
                  onClick={() => selectPage(project.pages[activeIndex - 1])}
                />
                <span>
                  <strong>{activeIndex + 1}</strong>
                  <span> / {project.pages.length}</span>
                </span>
                <IconButton
                  icon={ChevronRight}
                  label="Next page"
                  disabled={activeIndex >= project.pages.length - 1}
                  onClick={() => selectPage(project.pages[activeIndex + 1])}
                />
              </div>
              <span className="preview-note">
                {grid
                  ? 'Double-click a page to inspect'
                  : 'Live PDF preview · selectable text'}
              </span>
              <div className="zoom-controls">
                <IconButton
                  icon={ZoomOut}
                  label="Zoom out"
                  onClick={() =>
                    setZoom((value) => Math.max(0.25, value - 0.25))
                  }
                  disabled={grid || zoom <= 0.25}
                />
                <span>{Math.round(zoom * 100)}%</span>
                <IconButton
                  icon={ZoomIn}
                  label="Zoom in"
                  onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
                  disabled={grid || zoom >= 4}
                />
                <select
                  aria-label="Fit view"
                  value={fit}
                  onChange={(event) => {
                    setFit(event.target.value as 'page' | 'width');
                    setZoom(1);
                  }}
                  disabled={grid}
                >
                  <option value="page">Fit page</option>
                  <option value="width">Fit width</option>
                </select>
              </div>
            </div>
          </section>

          <aside className="inspector" aria-label="Page settings">
            <div className="inspector-title">
              <div className="eyebrow">
                {task === 'organize'
                  ? 'MAKE IT YOURS'
                  : task === 'convert'
                    ? 'A USEFUL FORMAT'
                    : 'COMPRESSION CHOICES'}
              </div>
              <h2>
                {task === 'organize'
                  ? 'Page settings'
                  : task === 'convert'
                    ? 'Convert & export'
                    : 'Optimize PDF'}
              </h2>
              <p>
                {task === 'organize'
                  ? selectedLabel
                  : task === 'convert'
                    ? 'Choose the right output for your next step.'
                    : 'Five presets. Measured results.'}
              </p>
            </div>
            <div className="inspector-scroll">
              {!editable && task !== 'optimize' && (
                <div className="capability-note">
                  <strong>Keep the document structure</strong>
                  <p>
                    {preserveGeometry
                      ? 'Rotation and crop are available. Merge, split, extract, delete, duplicate, reorder, insert, and resize need a separate editing copy.'
                      : 'This file can be viewed and exported unchanged. Its protected structures prevent the current editing operations.'}
                  </p>
                  {editingCopyAvailable && (
                    <Button
                      icon={Copy}
                      className="full"
                      disabled={busy}
                      onClick={() => requestEditingCopies('current')}
                    >
                      Create editing copy…
                    </Button>
                  )}
                  {!editingCopyAvailable &&
                    fullSource?.canCreateEditingCopy === false && (
                      <small>
                        An editing copy is unavailable because this file
                        contains structures or visible annotations that cannot
                        be removed safely.
                      </small>
                    )}
                </div>
              )}
              {editingCopiesInUse.length > 0 && (
                <details className="capability-note editing-copy-receipts">
                  <summary>Editing copies · removed features</summary>
                  <p>
                    Page content and selectable text were retained without
                    rasterization. Originals are unchanged. Each list below
                    comes from the verified conversion.
                  </p>
                  {editingCopiesInUse.map((item) => (
                    <div key={item.id} className="editing-copy-file">
                      <strong>{item.name}</strong>
                      <ul>
                        {(item.removedFeatures?.length
                          ? item.removedFeatures
                          : Array.isArray(
                                item.provenance?.settings.removedFeatures,
                              )
                            ? item.provenance.settings.removedFeatures.filter(
                                (feature): feature is string =>
                                  typeof feature === 'string',
                              )
                            : []
                        ).map((feature) => (
                          <li key={feature}>{feature}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </details>
              )}
              {task === 'organize' && (
                <>
                  <div
                    className="inspector-tabs"
                    role="group"
                    aria-label="Organize settings"
                  >
                    {(
                      [
                        { value: 'pages', label: 'Pages', icon: Layers },
                        { value: 'crop', label: 'Crop', icon: Crop },
                        { value: 'resize', label: 'Resize', icon: Maximize2 },
                        { value: 'split', label: 'Split', icon: Scissors },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.value}
                        className={inspector === item.value ? 'chosen' : ''}
                        onClick={() => setInspector(item.value)}
                      >
                        <item.icon size={15} />
                        {item.label}
                      </button>
                    ))}
                  </div>
                  {inspector === 'pages' && (
                    <>
                      <div className="section-label">
                        ARRANGE SELECTED PAGES
                      </div>
                      <div className="action-grid">
                        <Button
                          icon={RotateCw}
                          onClick={rotate}
                          disabled={!canRotate}
                        >
                          Rotate 90°
                        </Button>
                        <Button
                          icon={Copy}
                          onClick={duplicate}
                          disabled={!canEdit}
                        >
                          Duplicate
                        </Button>
                        <Button
                          icon={Scissors}
                          onClick={() => void exportDocument(false, true)}
                          disabled={!canExtract}
                          title={
                            !editable
                              ? assemblyRestriction
                              : 'Export selected pages as a new PDF'
                          }
                        >
                          Extract
                        </Button>
                        <Button
                          icon={Trash2}
                          className="danger-subtle"
                          onClick={remove}
                          disabled={
                            !canEdit || selection.length >= project.pages.length
                          }
                        >
                          Delete
                        </Button>
                      </div>
                      <div className="selection-info">
                        <Move size={15} />
                        <p>
                          Drag thumbnails to reorder. Use <kbd>Alt</kbd> +{' '}
                          <kbd>↑</kbd> / <kbd>↓</kbd> to move selected pages.
                        </p>
                      </div>
                      <div className="section-divider" />
                      <div className="section-label">
                        ADD AFTER PAGE {activeIndex + 1}
                      </div>
                      <Button
                        icon={FileStack}
                        className="full"
                        onClick={() => void insertPdf()}
                        disabled={!canInsertPdf}
                      >
                        Insert or merge PDF
                        <Plus size={14} />
                      </Button>
                      <Button
                        icon={ImagePlus}
                        className="full"
                        onClick={() => void addImages()}
                        disabled={!canEdit}
                      >
                        Insert PNG or JPEG
                        <Plus size={14} />
                      </Button>
                      <Button
                        icon={FilePlus2}
                        className="full"
                        onClick={blank}
                        disabled={!canEdit}
                      >
                        Insert blank page
                        <Plus size={14} />
                      </Button>
                      <p className="help-text">
                        Blank pages use the current resize paper dimensions:{' '}
                        {Math.round(resize.width)} × {Math.round(resize.height)}{' '}
                        pt.
                      </p>
                    </>
                  )}
                  {inspector === 'crop' && (
                    <>
                      <div className="section-label">
                        VISIBLE PAGE BOUNDARIES
                      </div>
                      <p className="help-text">
                        Trim each edge of {selectedSummary.toLowerCase()}.
                        Margins use the original, unrotated page coordinates.
                      </p>
                      <div className="crop-diagram" aria-hidden="true">
                        <span className="crop-top">TOP</span>
                        <span className="crop-left">LEFT</span>
                        <div className="crop-interior">
                          <Crop size={23} />
                          <span>Visible area</span>
                        </div>
                        <span className="crop-right">RIGHT</span>
                        <span className="crop-bottom">BOTTOM</span>
                      </div>
                      <div className="field-grid">
                        {(['top', 'bottom', 'left', 'right'] as const).map(
                          (edge) => (
                            <Field
                              key={edge}
                              label={`${edge[0].toUpperCase()}${edge.slice(1)} · pt`}
                            >
                              <input
                                type="number"
                                min="0"
                                max="14400"
                                step="1"
                                value={cropMargins[edge]}
                                disabled={!canCrop}
                                onChange={(event) =>
                                  setCropMargins({
                                    ...cropMargins,
                                    [edge]: Number(event.target.value),
                                  })
                                }
                              />
                            </Field>
                          ),
                        )}
                      </div>
                      <Button
                        icon={Crop}
                        className="primary full"
                        onClick={confirmCrop}
                        disabled={!canCrop}
                      >
                        Apply crop to selection
                      </Button>
                      <Button
                        className="full"
                        onClick={() =>
                          commit(
                            'Reset crop',
                            project.pages.map((page) =>
                              selection.includes(page.id)
                                ? { ...page, crop: undefined }
                                : page,
                            ),
                          )
                        }
                        disabled={
                          !canCrop || !selectedPages.some((page) => page.crop)
                        }
                      >
                        Reset crop
                      </Button>
                      <div className="notice amber">
                        <CircleAlert size={16} />
                        <p>
                          <strong>Cropping is not redaction.</strong> Hidden
                          content remains in the PDF and may be recovered.
                        </p>
                      </div>
                    </>
                  )}
                  {inspector === 'resize' && (
                    <>
                      <Field label="Paper size">
                        <select
                          value={paper}
                          disabled={!canEdit}
                          onChange={(event) => {
                            setPaper(event.target.value);
                            const size = paperSizes[event.target.value];
                            if (size)
                              setResize({
                                ...resize,
                                width: size[0],
                                height: size[1],
                              });
                          }}
                        >
                          {Object.keys(paperSizes).map((name) => (
                            <option key={name}>{name}</option>
                          ))}
                          <option value="Custom">Custom</option>
                        </select>
                      </Field>
                      <div className="field-grid">
                        <Field label="Width · pt">
                          <input
                            type="number"
                            min="36"
                            max="14400"
                            value={resize.width}
                            disabled={!canEdit}
                            onChange={(event) => {
                              setPaper('Custom');
                              setResize({
                                ...resize,
                                width: Number(event.target.value),
                              });
                            }}
                          />
                        </Field>
                        <Field label="Height · pt">
                          <input
                            type="number"
                            min="36"
                            max="14400"
                            value={resize.height}
                            disabled={!canEdit}
                            onChange={(event) => {
                              setPaper('Custom');
                              setResize({
                                ...resize,
                                height: Number(event.target.value),
                              });
                            }}
                          />
                        </Field>
                      </div>
                      <Field label="What changes">
                        <select
                          value={resize.mode}
                          disabled={!canEdit}
                          onChange={(event) =>
                            setResize({
                              ...resize,
                              mode: event.target.value as typeof resize.mode,
                            })
                          }
                        >
                          <option value="fit">
                            Fit content · preserve proportions
                          </option>
                          <option value="bounds">
                            Page bounds only · keep content size
                          </option>
                          <option value="stretch">
                            Stretch content · change proportions
                          </option>
                        </select>
                      </Field>
                      <p className="mode-explanation">
                        {resize.mode === 'fit'
                          ? 'Scale text, vectors, and images together to fit inside the paper. Content keeps its proportions.'
                          : resize.mode === 'bounds'
                            ? 'Change paper boundaries while keeping the original content origin fixed. Paper may hide or reveal existing content.'
                            : 'Scale width and height independently to fill the paper. Text and images may appear distorted.'}
                      </p>
                      <div
                        className={`resize-diagram ${resize.mode}`}
                        style={
                          {
                            '--paper-ratio': `${resize.width} / ${resize.height}`,
                          } as CSSProperties
                        }
                        aria-hidden="true"
                      >
                        <div>
                          <span />
                          <span />
                          <span />
                          <i />
                        </div>
                      </div>
                      <Field label="Anchor">
                        <select
                          value={resize.anchor}
                          disabled={!canEdit || resize.mode === 'bounds'}
                          onChange={(event) =>
                            setResize({
                              ...resize,
                              anchor: event.target
                                .value as typeof resize.anchor,
                            })
                          }
                        >
                          <option value="center">Center</option>
                          <option value="bottom-left">Bottom left</option>
                        </select>
                      </Field>
                      <Field
                        label="Margin · pt"
                        hint={
                          resize.mode === 'bounds'
                            ? 'Anchor and margin do not apply to page-bounds-only changes.'
                            : '72 points = 1 inch. Applied inside the target paper.'
                        }
                      >
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={resize.margin}
                          disabled={!canEdit || resize.mode === 'bounds'}
                          onChange={(event) =>
                            setResize({
                              ...resize,
                              margin: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      <Button
                        icon={Maximize2}
                        className="primary full"
                        onClick={confirmResize}
                        disabled={!canEdit}
                      >
                        Apply resize to selection
                      </Button>
                      <Button
                        className="full"
                        onClick={() =>
                          commit(
                            'Reset resize',
                            project.pages.map((page) =>
                              selection.includes(page.id)
                                ? { ...page, resize: undefined }
                                : page,
                            ),
                          )
                        }
                        disabled={
                          !canEdit || !selectedPages.some((page) => page.resize)
                        }
                      >
                        Reset resize
                      </Button>
                    </>
                  )}
                  {inspector === 'split' && (
                    <>
                      <div className="section-label">ONE COPY PER GROUP</div>
                      <p className="help-text">
                        Enter page groups separated by semicolons. Each group
                        becomes a separate PDF, in the order you specify.
                      </p>
                      <Field
                        label="Page groups"
                        hint="Example: 1-2; 3,5; 4 creates three files."
                      >
                        <textarea
                          rows={3}
                          value={splitRanges}
                          onChange={(event) =>
                            setSplitRanges(event.target.value)
                          }
                          disabled={!canEdit}
                        />
                      </Field>
                      <div className="notice">
                        <Scissors size={16} />
                        <p>
                          Page numbers refer to the current arrangement.
                          Overlapping groups are allowed; originals remain
                          unchanged.
                        </p>
                      </div>
                      <Button
                        icon={Scissors}
                        className="primary full"
                        onClick={() => void split()}
                        disabled={!canExtract}
                        title={!editable ? assemblyRestriction : undefined}
                      >
                        Choose folder & split
                      </Button>
                    </>
                  )}
                </>
              )}
              {task === 'convert' && (
                <>
                  <div className="section-label">EXPORT CURRENT PAGES</div>
                  <Field
                    label="Page range"
                    hint={`Leave empty to use the selection (${selectedNumbers.join(', ')}).`}
                  >
                    <input
                      placeholder="e.g. 1-3, 5"
                      value={range}
                      onChange={(event) => setRange(event.target.value)}
                      disabled={busy}
                    />
                  </Field>
                  <div className="format-tabs">
                    <button
                      className={format === 'png' ? 'chosen' : ''}
                      onClick={() => setFormat('png')}
                      disabled={busy}
                    >
                      PNG<span>Lossless image</span>
                    </button>
                    <button
                      className={format === 'jpg' ? 'chosen' : ''}
                      onClick={() => setFormat('jpg')}
                      disabled={busy}
                    >
                      JPEG<span>Smaller image</span>
                    </button>
                  </div>
                  <Field label="Resolution">
                    <select
                      value={dpi}
                      onChange={(event) => setDpi(Number(event.target.value))}
                      disabled={busy}
                    >
                      <option value={72}>72 DPI · screen</option>
                      <option value={144}>144 DPI · detailed screen</option>
                      <option value={150}>150 DPI · draft print</option>
                      <option value={300}>300 DPI · print</option>
                      <option value={600}>600 DPI · high detail</option>
                    </select>
                  </Field>
                  {format === 'jpg' ? (
                    <Field label={`JPEG quality · ${quality}%`}>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        step="5"
                        value={quality}
                        onChange={(event) =>
                          setQuality(Number(event.target.value))
                        }
                        disabled={busy}
                      />
                    </Field>
                  ) : (
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={transparent}
                        onChange={(event) =>
                          setTransparent(event.target.checked)
                        }
                        disabled={busy}
                      />
                      <span>Transparent page background</span>
                    </label>
                  )}
                  <p className="help-text">
                    {format === 'jpg'
                      ? 'JPEG uses a white background. This export creates images; your PDF project remains editable.'
                      : 'PNG preserves rendered pixels. Transparency affects unpainted areas only.'}
                  </p>
                  <Button
                    icon={FileImage}
                    className="primary full"
                    onClick={() => void exportImages()}
                    disabled={!previewCurrent || busy}
                  >
                    Export {format === 'png' ? 'PNG' : 'JPEG'} images
                  </Button>
                  <div className="section-divider" />
                  <div className="section-label">SELECTABLE TEXT</div>
                  <p className="help-text">
                    Extract the existing text layer into a TXT file. Scanned
                    pages may contain no text. Reading order can differ from the
                    visual layout.
                  </p>
                  <Button
                    icon={FileText}
                    className="full"
                    onClick={() => void exportText()}
                    disabled={!previewCurrent || busy}
                  >
                    Export text to TXT
                  </Button>
                  <div className="section-divider" />
                  <div className="section-label">BUILD FROM IMAGES</div>
                  <Button
                    icon={ImagePlus}
                    className="full"
                    onClick={() => void addImages()}
                    disabled={!canEdit}
                  >
                    Insert PNG / JPEG as PDF
                  </Button>
                </>
              )}
              {task === 'optimize' && (
                <>
                  <div className="optimization-visual">
                    <div>
                      <Layers size={28} strokeWidth={1.2} />
                    </div>
                    <span>
                      Your file.
                      <br />
                      <strong>Your choice of detail.</strong>
                    </span>
                  </div>
                  <fieldset className="optimization-presets" disabled={busy}>
                    <legend>Compression preset</legend>
                    {optimizationPresets.map((preset) => (
                      <label
                        key={preset.id}
                        className={
                          optimizationPreset === preset.id ? 'selected' : ''
                        }
                      >
                        <input
                          type="radio"
                          name="optimization-preset"
                          value={preset.id}
                          checked={optimizationPreset === preset.id}
                          onChange={() =>
                            setProject((current) => ({
                              ...current,
                              optimization: {
                                schemaVersion: 1,
                                preset: preset.id,
                              },
                            }))
                          }
                        />
                        <span>
                          <strong>{preset.name}</strong>
                          <small>{preset.detail}</small>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <div
                    className={
                      optimizationChoice.quality === null
                        ? 'notice'
                        : 'notice amber'
                    }
                  >
                    <ShieldCheck size={17} />
                    <p>
                      {optimizationChoice.quality === null
                        ? 'Lossless: image pixels, text and vectors stay unchanged. No pages are rasterized.'
                        : 'Lossy: eligible RGB/gray images, including JPEGs, may lose detail. Pixel dimensions, text and vectors stay unchanged. Transparency or special image formats may require a lossless preset.'}
                    </p>
                  </div>
                  <div className="size-summary">
                    <span>
                      Original source size
                      <strong>{formatBytes(totalInput)}</strong>
                    </span>
                    <span>
                      Current PDF size
                      <strong>
                        {previewSource ? formatBytes(previewSource.bytes) : '—'}
                      </strong>
                    </span>
                  </div>
                  <p className="help-text">
                    Savings depend on the PDF; any preset can produce a larger
                    file. Image presets only replace images when their encoded
                    data becomes smaller. Small and inline images are retained.
                    The preview shows the current PDF; reopen your export to
                    inspect the result.
                  </p>
                  <Button
                    icon={Sparkles}
                    className="primary full"
                    onClick={() => void exportDocument(true)}
                    disabled={!canOptimize}
                  >
                    Optimize & export a copy
                  </Button>
                  <div className="section-divider" />
                  <Field
                    label="Processing preference"
                    hint="One processing job at a time in both modes. Quiet mode delays preview updates to reduce repeated work."
                  >
                    <select
                      value={resourceMode}
                      onChange={(event) => {
                        setResourceMode(event.target.value);
                        localStorage.setItem(
                          'pdfw.resourceMode',
                          JSON.stringify(event.target.value),
                        );
                      }}
                      disabled={busy}
                    >
                      <option value="balanced">
                        Balanced · responsive previews
                      </option>
                      <option value="quiet">
                        Quiet · fewer preview updates
                      </option>
                    </select>
                  </Field>
                </>
              )}
              {reports.length > 0 && (
                <div className="export-result" role="status">
                  <div>
                    <Check size={16} />
                    <strong>Export complete</strong>
                  </div>
                  {reports.slice(0, 3).map((report, index) => (
                    <div
                      key={`${report.path}-${index}`}
                      className="report-item"
                    >
                      <span title={report.path}>
                        {report.path.split(/[\\/]/).pop()}
                      </span>
                      <strong>{formatBytes(report.bytes)}</strong>
                      {report.optimization && (
                        <p>
                          {report.bytes < report.inputBytes
                            ? `${formatBytes(report.inputBytes - report.bytes)} smaller (${((1 - report.bytes / report.inputBytes) * 100).toFixed(1)}%)`
                            : report.bytes === report.inputBytes
                              ? 'No size change'
                              : `${formatBytes(report.bytes - report.inputBytes)} larger`}
                        </p>
                      )}
                      {report.optimization && (
                        <small>
                          {
                            optimizationPresets.find(
                              (item) => item.id === report.optimization?.preset,
                            )?.name
                          }{' '}
                          · {report.optimization.changedImageObjects} image
                          objects recompressed
                        </small>
                      )}
                      <small>{report.validation.join(' · ')}</small>
                    </div>
                  ))}
                  {reports.length > 3 && (
                    <small>and {reports.length - 3} more files</small>
                  )}
                  {reports.length === 1 &&
                    reports[0].source?.kind === 'pdf' && (
                      <Button
                        icon={BookOpen}
                        className="full"
                        disabled={busy}
                        onClick={() => {
                          const exported = reports[0].source;
                          const pages = pagesForSource(exported);
                          setProject({
                            ...emptyProject(),
                            name: shortName(exported.name),
                            sources: [exported],
                            pages,
                          });
                          setSelection([pages[0].id]);
                          setActive(pages[0].id);
                          setReports([]);
                          setSavedPath('');
                        }}
                      >
                        Reopen exported PDF
                      </Button>
                    )}
                </div>
              )}
            </div>
            <div className="inspector-footer">
              <ShieldCheck size={14} />
              <span>
                {editable
                  ? 'Edits are reversible. Export saves a copy.'
                  : preserveGeometry
                    ? 'Rotation and crop preserve document structures.'
                    : 'An unchanged PDF copy remains available.'}
              </span>
            </div>
          </aside>
        </main>
      )}

      <dialog
        ref={editingCopyDialog}
        className="editing-copy-dialog"
        onCancel={() => {
          setEditingCopyRequest(null);
          setStatus(
            'Editing-copy preparation cancelled. The current project is unchanged.',
          );
        }}
        aria-labelledby="editing-copy-title"
      >
        <div className="dialog-heading">
          <Copy size={21} />
          <h2 id="editing-copy-title">Enable page editing?</h2>
        </div>
        <p>
          Create{' '}
          {editingCopyRequest?.candidates.length === 1
            ? 'a separate working copy'
            : 'separate working copies'}{' '}
          to enable merge, split, extract, delete, reorder, duplicate, insert,
          and resize. Originals stay unchanged. Current page geometry is
          retained.
          {editingCopyRequest?.kind !== 'current' &&
            ' The selected PDFs are merged only after every required copy succeeds.'}
        </p>
        <div className="notice amber">
          <CircleAlert size={18} />
          <div>
            <strong>
              The editing copy removes these features when present
            </strong>
            <ul>
              <li>Accessibility tags and structured reading information.</li>
              <li>
                Bookmarks, clickable links, named destinations, and page labels.
              </li>
              <li>
                XMP and document information metadata (such as title/author),
                name trees, document language, viewing preferences, and
                opening-view navigation.
              </li>
            </ul>
          </div>
        </div>
        <p>
          Visible page content, selectable text, embedded fonts, and images are
          preserved without rasterizing pages. The copy loses accessible
          document structure and clickable navigation. Other annotations or
          unsupported structures prevent this conversion.
        </p>
        <div
          className="editing-copy-files"
          aria-label="PDFs requiring editing copies"
        >
          {editingCopyRequest?.candidates.map((item) => (
            <div key={item.id} className="editing-copy-file">
              <strong>{item.name}</strong>
              <p>
                Detected features to remove:{' '}
                {item.features.join(', ') || 'document structure'}.
              </p>
            </div>
          ))}
        </div>
        <p>
          The exact removed features are recorded separately for each copy after
          conversion and remain in saved projects and export receipts. Cancel or
          any failed conversion leaves the current project unchanged.
        </p>
        <label className="checkbox-field editing-copy-consent">
          <input
            type="checkbox"
            checked={editingCopyAccepted}
            onChange={(event) => setEditingCopyAccepted(event.target.checked)}
          />
          <span>
            I understand these document features will be removed from the
            editing copies listed above.
          </span>
        </label>
        <div className="dialog-actions">
          <Button
            onClick={() => {
              setEditingCopyRequest(null);
              setStatus(
                'Editing-copy preparation cancelled. The current project is unchanged.',
              );
            }}
          >
            Cancel
          </Button>
          <Button
            icon={Copy}
            className="primary"
            onClick={confirmEditingCopy}
            disabled={!editingCopyAccepted || busy}
          >
            {editingCopyRequest?.kind === 'current'
              ? 'Create editing copy'
              : 'Create copies & merge'}
          </Button>
        </div>
      </dialog>

      <footer className="status-bar">
        <div className="status-main">
          {busy ? (
            <Loader2 className="spin" size={13} />
          ) : error ? (
            <CircleAlert size={13} />
          ) : (
            <span className="status-dot" />
          )}
          <span title={status}>{status}</span>
          {busy && (
            <button
              className="cancel-job"
              onClick={() => {
                jobController.current?.abort();
                previewController.current?.abort();
                if (!job) {
                  setPreviewBusy(false);
                  setStatus(
                    'Preview cancelled. Undo or make another edit to regenerate it.',
                  );
                }
              }}
            >
              Cancel
            </button>
          )}
        </div>
        <div className="status-meta">
          {project.pages.length > 0 && (
            <>
              <span>{selectedLabel}</span>
              <span className="status-separator" />
              <span>{formatBytes(totalInput)} source</span>
              <span className="status-separator" />
            </>
          )}
          <span className="local-badge">
            <ShieldCheck size={12} /> Local only
          </span>
          <span className="version">0.1.5</span>
        </div>
      </footer>
    </div>
  );
}
