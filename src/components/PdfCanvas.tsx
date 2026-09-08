import { useEffect, useRef, useState } from 'react';
import { extractPageText } from '../adapters/text';
import { TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

type Props = {
  document: PDFDocumentProxy;
  page: number;
  thumbnail?: boolean;
  zoom?: number;
  fit?: 'page' | 'width';
  search?: string;
  onRendered?: () => void;
  onRenderError?: (message: string) => void;
};

/** One cancellable PDF.js render, mounted only near the viewport for thumbnails. */
export function PdfCanvas({
  document,
  page,
  thumbnail = false,
  zoom = 1,
  fit = 'page',
  search = '',
  onRendered,
  onRenderError,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!thumbnail);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [canvasError, setCanvasError] = useState('');
  const [textError, setTextError] = useState('');

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setBox({ width: rect.width, height: rect.height });
    });
    resize.observe(element);
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: '240px' },
    );
    if (thumbnail) observer.observe(element);
    return () => {
      resize.disconnect();
      observer.disconnect();
    };
  }, [thumbnail]);

  useEffect(() => {
    if (!visible || !canvas.current || !box.width) {
      if (canvas.current && thumbnail) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
      return;
    }
    let disposed = false;
    let rendering: RenderTask | undefined;
    let layer: TextLayer | undefined;
    setCanvasError('');
    setTextError('');
    text.current?.replaceChildren();
    void (async () => {
      const pdfPage = await document.getPage(page);
      if (disposed || !canvas.current) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const availableWidth = Math.max(40, box.width - (thumbnail ? 0 : 72));
      const availableHeight = Math.max(40, box.height - (thumbnail ? 0 : 64));
      const scale =
        (thumbnail
          ? Math.min(
              availableWidth / natural.width,
              availableHeight / natural.height,
            )
          : fit === 'width'
            ? availableWidth / natural.width
            : Math.min(
                availableWidth / natural.width,
                availableHeight / natural.height,
              )) * zoom;
      const viewport = pdfPage.getViewport({ scale });
      const ratio = thumbnail
        ? Math.min(window.devicePixelRatio || 1, 1.5)
        : Math.min(window.devicePixelRatio || 1, 2);
      const element = canvas.current;
      element.width = Math.ceil(viewport.width * ratio);
      element.height = Math.ceil(viewport.height * ratio);
      element.style.width = `${viewport.width}px`;
      element.style.height = `${viewport.height}px`;
      setSize({ width: viewport.width, height: viewport.height });
      rendering = pdfPage.render({
        canvas: element,
        canvasContext: element.getContext('2d')!,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await rendering.promise;
      if (disposed) return;
      onRenderError?.('');
      onRendered?.();
      if (!thumbnail && text.current) {
        try {
          text.current.style.setProperty('--scale-factor', `${scale}`);
          text.current.style.setProperty('--total-scale-factor', `${scale}`);
          const content = await extractPageText(pdfPage);
          if (disposed || !text.current) return;
          layer = new TextLayer({
            textContentSource: content,
            container: text.current,
            viewport,
          });
          await layer.render();
          if (disposed || !text.current) return;
          if (search.trim()) {
            const query = search.toLocaleLowerCase();
            text.current.querySelectorAll('span').forEach((span) => {
              if (span.textContent?.toLocaleLowerCase().includes(query))
                span.classList.add('search-match');
            });
          }
        } catch (e) {
          if (disposed) return;
          layer?.cancel();
          text.current?.replaceChildren();
          const message = String((e as Error)?.message || e);
          console.error(
            `PDF text layer failed on page ${page}:`,
            (e as Error)?.stack || e,
          );
          setTextError(
            `Text selection and on-page search highlighting are unavailable on this page. ${message}`,
          );
        }
      }
    })().catch((e) => {
      if (
        !disposed &&
        e?.name !== 'RenderingCancelledException' &&
        e?.name !== 'AbortException'
      ) {
        const message = `Page ${page} could not be rendered: ${String(e?.message || e)}`;
        console.error(`PDF canvas failed on page ${page}:`, e?.stack || e);
        setCanvasError(message);
        onRenderError?.(message);
      }
    });
    return () => {
      disposed = true;
      rendering?.cancel();
      layer?.cancel();
    };
  }, [
    document,
    page,
    thumbnail,
    visible,
    box.width,
    box.height,
    zoom,
    fit,
    search,
  ]);

  return (
    <div
      ref={host}
      className={
        thumbnail
          ? 'pdf-canvas-host thumbnail-canvas'
          : 'pdf-canvas-host preview-canvas'
      }
    >
      <div
        className="pdf-sheet"
        style={{
          ...(size.width ? { width: size.width, height: size.height } : {}),
          visibility: canvasError ? 'hidden' : 'visible',
        }}
      >
        <canvas ref={canvas} aria-label={`PDF page ${page}`} />
        {!thumbnail && <div ref={text} className="textLayer" />}
      </div>
      {canvasError && (
        <p className="canvas-error" role="alert">
          {canvasError}
        </p>
      )}
      {!canvasError && textError && (
        <p className="text-layer-notice" role="status">
          {textError}
        </p>
      )}
    </div>
  );
}
