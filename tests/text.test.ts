import { it, expect } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { extractPageText } from '../src/adapters/text';
it('extracts text when streams have no async iterator, as in WKWebView', async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue({
        items: [{ str: 'Größe' }],
        styles: { f1: { fontFamily: 'Sans' } },
        lang: null,
      });
      c.enqueue({
        items: [{ str: 'ภาษาไทย' }],
        styles: { f2: { fontFamily: 'Thai' } },
        lang: 'th',
      });
      c.close();
    },
  });
  const page = {
    streamTextContent: () => ({ getReader: () => stream.getReader() }),
  } as unknown as PDFPageProxy;
  const result = await extractPageText(page);
  expect(result.items.map((i) => ('str' in i ? i.str : ''))).toEqual([
    'Größe',
    'ภาษาไทย',
  ]);
  expect(result.lang).toBe('th');
  expect(Object.keys(result.styles)).toEqual(['f1', 'f2']);
});
it('cancels pending text reads without using an async iterator', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const page = { streamTextContent: () => stream } as unknown as PDFPageProxy;
  const controller = new AbortController();
  const result = extractPageText(page, controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow('cancelled');
  expect(cancelled).toBe(true);
});
