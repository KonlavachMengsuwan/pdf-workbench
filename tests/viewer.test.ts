import { expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageText } from '../src/adapters/text';

it('renders the owned fixture and reads its selectable Unicode with the locked viewer version', async () => {
  const workspace = resolve('..');
  const task = getDocument({
    data: new Uint8Array(
      readFileSync(resolve(workspace, 'test-data/studio-sample.pdf')),
    ),
    enableXfa: false,
    standardFontDataUrl: `${resolve('node_modules/pdfjs-dist/standard_fonts')}/`,
    cMapUrl: `${resolve('node_modules/pdfjs-dist/cmaps')}/`,
    cMapPacked: true,
    wasmUrl: `${resolve('node_modules/pdfjs-dist/wasm')}/`,
  });
  try {
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(4);
    const page = await pdf.getPage(1);
    const text = (await extractPageText(page)).items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    expect(text).toContain('A quieter way');
    expect(text).toContain('Origin marker BOTTOM LEFT');
    // The fixture generator uses a Unicode font when available on macOS.
    if (process.platform === 'darwin') {
      expect(text).toContain('Größe');
      expect(text).toContain('ภาษาไทย');
    }
    const viewport = page.getViewport({ scale: 0.5 });
    const factory = pdf.canvasFactory as {
      create(
        width: number,
        height: number,
      ): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
    };
    const { canvas, context } = factory.create(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    expect(Array.from(context.getImageData(30, 3, 1, 1).data)).toEqual([
      23, 107, 91, 255,
    ]);
    const resultDir = resolve(workspace, 'tmp/test-results');
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(
      resolve(resultDir, 'pdfjs-programmatic-render.png'),
      Buffer.from(canvas.toDataURL('image/png').split(',')[1], 'base64'),
    );
  } finally {
    await task.destroy();
  }
});
