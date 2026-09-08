import type { PDFPageProxy } from 'pdfjs-dist';
type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
/** Public PDF.js reader API avoids Safari/WKWebView ReadableStream async-iterator gaps.
 * Upstream: https://github.com/mozilla/pdf.js/issues/21557 and /issues/20973.
 */
export async function extractPageText(
  page: PDFPageProxy,
  signal?: AbortSignal,
): Promise<Content> {
  if (signal?.aborted)
    throw new DOMException('Operation cancelled.', 'AbortError');
  const reader = page.streamTextContent().getReader();
  const result: Content = {
    items: [],
    styles: Object.create(null),
    lang: null,
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted)
        throw new DOMException('Operation cancelled.', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      result.lang ??= value.lang;
      Object.assign(result.styles, value.styles);
      result.items.push(...value.items);
    }
    if (signal?.aborted)
      throw new DOMException('Operation cancelled.', 'AbortError');
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
