import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const runtime = [
  'react',
  'react-dom',
  'scheduler',
  'pdfjs-dist',
  'pdf-lib',
  '@pdf-lib/standard-fonts',
  '@pdf-lib/upng',
  'pako',
  'tslib',
  'lucide-react',
  '@tauri-apps/api',
];
let manifest =
  '# Bundled JavaScript components\n\nGenerated from package-lock.json and installed package license files. App has no chosen public redistribution license yet.\n\n';
let licenses = 'PDF Workbench JavaScript third-party license texts\n';
for (const name of runtime) {
  const dir = `node_modules/${name}`;
  if (!existsSync(`${dir}/package.json`)) continue;
  const p = JSON.parse(readFileSync(`${dir}/package.json`));
  manifest += `- ${name} ${p.version}: ${p.license}\n`;
  for (const file of [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENCE',
    'COPYING',
  ])
    if (existsSync(`${dir}/${file}`)) {
      licenses += `\n\n========== ${name} ${p.version} ==========\n${readFileSync(`${dir}/${file}`, 'utf8')}\n`;
      break;
    }
}
writeFileSync('notices/JavaScript-components.md', manifest);
writeFileSync('notices/JavaScript-LICENSES.txt', licenses);
