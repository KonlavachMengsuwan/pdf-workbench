import { cpSync, mkdirSync } from 'node:fs';
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  mkdirSync(`public/pdfjs/${dir}`, { recursive: true });
  cpSync(`node_modules/pdfjs-dist/${dir}`, `public/pdfjs/${dir}`, {
    recursive: true,
    filter: (p) => !p.split('/').some((x) => x.startsWith('._')),
  });
}
