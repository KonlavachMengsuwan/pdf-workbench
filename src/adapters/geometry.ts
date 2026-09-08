import {
  PDFDocument,
  degrees,
  PDFName,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
} from 'pdf-lib';
import type { Page } from '../model';
/** Geometry adapter: only preflight-approved documents without interactive structures. */
export async function applyGeometry(
  bytes: Uint8Array,
  pages: Page[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (doc.getPageCount() !== pages.length)
    throw new Error('Engine output page count does not match the recipe.');
  doc.getPages().forEach((page, i) => {
    const plan = pages[i];
    const media = page.getMediaBox();
    if (
      (plan.crop || plan.resize) &&
      (media.x !== 0 || media.y !== 0 || page.node.has(PDFName.of('UserUnit')))
    )
      throw new Error(
        `Page ${i + 1}: crop/resize requires a zero-origin MediaBox and standard PDF units in this release.`,
      );
    if (plan.crop) {
      const c = plan.crop;
      const x = media.x + c.left,
        y = media.y + c.bottom,
        w = media.width - c.left - c.right,
        h = media.height - c.bottom - c.top;
      if (w < 1 || h < 1)
        throw new Error(`Page ${i + 1}: crop margins leave no visible page.`);
      page.setCropBox(x, y, w, h);
    }
    if (plan.resize) {
      const r = plan.resize;
      const box = page.getCropBox();
      for (const key of ['BleedBox', 'TrimBox', 'ArtBox'])
        if (page.node.has(PDFName.of(key)))
          throw new Error(
            `Page ${i + 1}: resize of explicit ${key} production geometry is unsupported; crop or organize remains available.`,
          );
      if (r.mode === 'bounds') {
        page.setMediaBox(0, 0, r.width, r.height);
        page.setCropBox(0, 0, r.width, r.height);
      } else {
        page.node.normalize();
        const start = doc.context.register(
          doc.context.contentStream([
            pushGraphicsState(),
            rectangle(box.x, box.y, box.width, box.height),
            clip(),
            endPath(),
          ]),
        );
        const end = doc.context.register(
          doc.context.contentStream([popGraphicsState()]),
        );
        page.node.wrapContentStreams(start, end);
        const sx = (r.width - 2 * r.margin) / box.width,
          sy = (r.height - 2 * r.margin) / box.height;
        const ax = r.mode === 'fit' ? Math.min(sx, sy) : sx,
          ay = r.mode === 'fit' ? Math.min(sx, sy) : sy;
        const tx =
          (r.anchor === 'center' ? (r.width - box.width * ax) / 2 : r.margin) -
          box.x * ax;
        const ty =
          (r.anchor === 'center'
            ? (r.height - box.height * ay) / 2
            : r.margin) -
          box.y * ay;
        // Translate then scale wraps content so its final mapping is x'=ax*x+tx.
        page.translateContent(tx / ax, ty / ay);
        page.scaleContent(ax, ay);
        page.setMediaBox(0, 0, r.width, r.height);
        page.setCropBox(0, 0, r.width, r.height);
      }
    }
    if (plan.rotation)
      page.setRotation(
        degrees(
          (((page.getRotation().angle + plan.rotation) % 360) + 360) % 360,
        ),
      );
  });
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}
export async function makeBlank(pages: Page[]): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (const p of pages) {
    const b = p.blank ?? { width: 595.28, height: 841.89 };
    if (
      !Number.isFinite(b.width) ||
      !Number.isFinite(b.height) ||
      b.width < 12 ||
      b.height < 12 ||
      b.width > 14400 ||
      b.height > 14400
    )
      throw new Error('Invalid blank paper dimensions.');
    d.addPage([b.width, b.height]);
  }
  return d.save();
}
export async function makeImages(
  images: { bytes: Uint8Array; kind: string }[],
): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (const item of images) {
    const im =
      item.kind === 'png'
        ? await d.embedPng(item.bytes)
        : await d.embedJpg(item.bytes);
    const max = Math.max(im.width, im.height);
    const ratio = Math.min(1, 14400 / max);
    const p = d.addPage([im.width * ratio, im.height * ratio]);
    p.drawImage(im, { x: 0, y: 0, width: p.getWidth(), height: p.getHeight() });
  }
  return d.save();
}
