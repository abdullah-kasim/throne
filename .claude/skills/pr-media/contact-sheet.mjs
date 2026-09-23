#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { altTextFor, listMediaFiles } from './media-folder.mjs';

export const CONTACT_SHEET_NAME = 'index.html';

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mediaElement(file) {
  const source = escapeHtml(encodeURI(file.name));
  if (file.kind === 'video') return `<video controls preload="metadata" src="${source}"></video>`;
  return `<img src="${source}" alt="${escapeHtml(altTextFor(file.name))}">`;
}

function section(file) {
  return `<section>
<h2>${escapeHtml(file.name)}</h2>
${mediaElement(file)}
<p>${escapeHtml(altTextFor(file.name))}</p>
</section>`;
}

export function contactSheetHtml(folder, files) {
  const title = escapeHtml(path.basename(folder));
  return `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<style>
body { margin: 0; padding: 24px; font: 15px/1.4 system-ui, sans-serif; background: #f6f7f9; color: #1f2328; }
h1 { font-size: 20px; margin: 0 0 8px; }
h2 { font-size: 15px; margin: 0 0 8px; font-family: ui-monospace, monospace; }
section { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; margin: 0 0 24px; }
img, video { display: block; max-width: 100%; height: auto; border: 1px solid #d0d7de; }
p { margin: 8px 0 0; color: #59636e; }
</style>
<h1>${title}</h1>
<p>${files.length} file${files.length === 1 ? '' : 's'}: ${files.map((file) => escapeHtml(file.name)).join(', ')}</p>
${files.map(section).join('\n')}
`;
}

export function writeContactSheet(folder) {
  const files = listMediaFiles(folder);
  const target = path.join(folder, CONTACT_SHEET_NAME);
  writeFileSync(target, contactSheetHtml(folder, files));
  return { target, files };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const folder = process.argv[2];
  if (!folder) {
    console.error('usage: contact-sheet.mjs <media folder>');
    process.exit(2);
  }
  try {
    const { target, files } = writeContactSheet(path.resolve(folder));
    console.log(`${target} (${files.length} files)`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
