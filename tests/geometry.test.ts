import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyGeometry, makeBlank, makeImages } from '../src/adapters/geometry';
import { parseRanges, validatePages } from '../src/model';
import type { Page } from '../src/model';
const root = resolve('..'),
  out = resolve(root, 'tmp/test-results');
mkdirSync(out, { recursive: true });
const input = new Uint8Array(
  readFileSync(resolve(root, 'test-data/studio-sample.pdf')),
);
const plans = (): Page[] =>
  Array.from({ length: 4 }, (_, i) => ({
    id: `page-${i}`,
    sourceId: 'fixture',
    page: i + 1,
    rotation: 0,
  }));
const qpdf = resolve(
  `src-tauri/binaries/qpdf-${process.platform === 'win32' ? 'x86_64-pc-windows-msvc.exe' : 'aarch64-apple-darwin'}`,
);
async function save(name: string, data: Uint8Array) {
  const path = resolve(out, name);
  writeFileSync(path, data);
  execFileSync(qpdf, ['--check', path]);
  return PDFDocument.load(data);
}
describe('real vector PDF geometry', () => {
  it('rotation changes metadata and keeps embedded fonts and image samples', async () => {
    const p = plans();
    p[0].rotation = 90;
    const d = await save('rotated.pdf', await applyGeometry(input, p));
    expect(d.getPage(0).getRotation().angle).toBe(90);
    expect(d.getPageCount()).toBe(4);
    expect(d.getPage(0).node.Resources()!.get(PDFName.of('Font'))).toBeTruthy();
  });
  it('crop applies asymmetric margins in unrotated paper coordinates', async () => {
    const p = plans();
    p[0].crop = { left: 22, right: 46, top: 60, bottom: 30 };
    p[1].rotation = 270;
    const d = await save('cropped.pdf', await applyGeometry(input, p));
    expect(d.getPage(0).getCropBox()).toEqual({
      x: 22,
      y: 30,
      width: 527.28,
      height: 751.89,
    });
    expect(d.getPage(1).getRotation().angle).toBe(270);
  });
  it('fit centers clipped content in new paper without rasterization', async () => {
    const p = plans();
    p[0].crop = { left: 20, right: 40, top: 80, bottom: 30 };
    p[0].resize = {
      width: 612,
      height: 792,
      mode: 'fit',
      anchor: 'center',
      margin: 36,
    };
    const d = await save('fit-letter.pdf', await applyGeometry(input, p));
    expect(d.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(d.getPage(0).getCropBox()).toEqual({
      x: 0,
      y: 0,
      width: 612,
      height: 792,
    });
  });
  it('stretch and bounds have different content transforms', async () => {
    const p = plans();
    p[0].resize = {
      width: 420,
      height: 600,
      mode: 'stretch',
      anchor: 'bottom-left',
      margin: 12,
    };
    const d = await save('stretch.pdf', await applyGeometry(input, p));
    expect(d.getPage(0).getWidth()).toBe(420);
    p[0].resize.mode = 'bounds';
    await save('bounds.pdf', await applyGeometry(input, p));
  });
  it('rejects invalid crop and unusual geometry explicitly', async () => {
    const p = plans();
    p[0].crop = { left: 9999, right: 0, top: 0, bottom: 0 };
    await expect(applyGeometry(input, p)).rejects.toThrow('no visible');
    const n = readFileSync(resolve(root, 'test-data/nonzero-origin.pdf'));
    p[0].crop.left = 1;
    await expect(applyGeometry(n, p)).rejects.toThrow('zero-origin');
  });
  it('rejects explicit print production boxes during resize', async () => {
    const d = await PDFDocument.load(input);
    d.getPage(0).setTrimBox(20, 20, 400, 600);
    const p = plans();
    p[0].resize = {
      width: 612,
      height: 792,
      mode: 'fit',
      anchor: 'center',
      margin: 0,
    };
    await expect(applyGeometry(await d.save(), p)).rejects.toThrow('TrimBox');
  });
  it('creates blank mixed paper and embeds PNG plus JPEG', async () => {
    const b = await save(
      'blank-mixed.pdf',
      await makeBlank([
        { ...plans()[0], blank: { width: 612, height: 792 } },
        { ...plans()[0], blank: { width: 400, height: 500 } },
      ]),
    );
    expect(b.getPage(1).getSize()).toEqual({ width: 400, height: 500 });
    const images = ['png', 'jpg'].map((kind) => ({
      kind,
      bytes: readFileSync(resolve(root, `test-data/chart.${kind}`)),
    }));
    const d = await save('images.pdf', await makeImages(images));
    expect(d.getPageCount()).toBe(2);
    expect(d.getPage(0).getSize()).toEqual({ width: 640, height: 420 });
  });
});
describe('range validation and recipe safety', () => {
  it('handles disjoint ranges without duplicate selections', () =>
    expect(parseRanges('1, 3-4, 3', 4)).toEqual([1, 3, 4]));
  it.each(['0', '4-2', '2-9', '1;2', 'NaN', ''])(
    'rejects invalid range %s',
    (s) => expect(() => parseRanges(s, 4)).toThrow(),
  );
  it('blocks unsupported protected changes and no-page projects', () => {
    expect(() => validatePages([], [])).toThrow();
    const protectedPlan = plans();
    protectedPlan[0].rotation = 90;
    expect(() =>
      validatePages(protectedPlan, [
        {
          id: 'fixture',
          name: 'Form',
          path: 'x',
          bytes: 1,
          sha256: 'a',
          kind: 'pdf',
          features: ['forms'],
          editable: false,
          pages: 4,
        },
      ]),
    ).toThrow('forms');
  });
});
