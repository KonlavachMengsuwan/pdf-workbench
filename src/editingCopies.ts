import type { Page, Source } from './model';

/** Reject an entire request before converting any file if a source is unsafe. */
export function editingCopyCandidates(sources: Source[]): Source[] {
  const candidates = [
    ...new Map(sources.map((source) => [source.id, source])).values(),
  ].filter((source) => !source.editable);
  const unsupported = candidates.filter(
    (source) => !source.canCreateEditingCopy,
  );
  if (unsupported.length) {
    throw new Error(
      `These PDFs cannot be prepared for page editing: ${unsupported
        .map(
          (source) =>
            `${source.name} (${source.features.join(', ') || 'unsupported structure'})`,
        )
        .join(
          '; ',
        )}. Their annotations or protected structures cannot be removed safely. Open each file separately to view its available operations. The current project is unchanged.`,
    );
  }
  return candidates;
}

export type EditingCopyConverter = (
  source: Source,
  signal?: AbortSignal,
) => Promise<Source>;

/** No project mutation occurs here: callers commit only after the whole batch succeeds. */
export async function prepareEditingCopies(
  sources: Source[],
  convert: EditingCopyConverter,
  signal?: AbortSignal,
): Promise<Map<string, Source>> {
  const check = () => {
    if (signal?.aborted)
      throw new DOMException('Operation cancelled.', 'AbortError');
  };
  check();
  const candidates = editingCopyCandidates(sources);
  const replacements = new Map<string, Source>();
  for (const source of candidates) {
    check();
    const copy = await convert(source, signal);
    check();
    if (
      !copy.editable ||
      copy.pages !== source.pages ||
      copy.id === source.id
    ) {
      throw new Error(
        `${source.name}: the editing copy failed verification. The current project is unchanged.`,
      );
    }
    replacements.set(source.id, copy);
  }
  check();
  return replacements;
}

/** Keep page IDs and geometry so selection and undo snapshots remain meaningful. */
export function useEditingCopies(
  pages: Page[],
  replacements: Map<string, Source>,
): Page[] {
  return pages.map((page) => {
    const copy = page.sourceId && replacements.get(page.sourceId);
    return copy ? { ...page, sourceId: copy.id } : page;
  });
}
