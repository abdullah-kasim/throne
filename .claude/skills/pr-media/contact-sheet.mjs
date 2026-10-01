#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { altTextFor, filesInBodyOrder, groupIntoPairsAndSingles, listMediaFiles } from './media-folder.mjs';

export const CONTACT_SHEET_NAME = 'index.html';

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mediaElement(file) {
  const source = escapeHtml(encodeURI(file.name));
  if (file.kind === 'video') return `<video controls playsinline preload="metadata" src="${source}"></video>`;
  return `<img src="${source}" alt="${escapeHtml(altTextFor(file.name))}">`;
}

function section(file) {
  return `<section>
<h2>${escapeHtml(file.name)}</h2>
${mediaElement(file)}
<p>${escapeHtml(altTextFor(file.name))}</p>
</section>`;
}

function pairCell(side, file) {
  return `<td data-side="${side}">
${mediaElement(file)}
<p class="file">${escapeHtml(file.name)}</p>
</td>`;
}

function pairSection(pair) {
  return `<section class="pair">
<h2>${escapeHtml(pair.stem)}</h2>
<table>
<thead><tr><th>Before</th><th>After</th></tr></thead>
<tbody><tr>
${pairCell('Before', pair.before)}
${pairCell('After', pair.after)}
</tr></tbody>
</table>
<p>${escapeHtml(altTextFor(pair.stem))}</p>
</section>`;
}

function groupSection(group) {
  return group.pair ? pairSection(group.pair) : section(group.single);
}

function describeCounts(files, groups) {
  const pairCount = groups.filter((group) => group.pair).length;
  const fileCount = `${files.length} file${files.length === 1 ? '' : 's'}`;
  return pairCount === 0 ? fileCount : `${fileCount}, ${pairCount} before/after pair${pairCount === 1 ? '' : 's'}`;
}

export function contactSheetHtml(folder, files) {
  const title = escapeHtml(path.basename(folder));
  const groups = groupIntoPairsAndSingles(files);
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: light dark; --page: #f6f7f9; --card: #fff; --text: #1f2328; --muted: #59636e; --line: #d0d7de; }
@media (prefers-color-scheme: dark) {
  :root { --page: #0d1117; --card: #161b22; --text: #e6edf3; --muted: #9198a1; --line: #3d444d; }
}
body { margin: 0; padding: 24px; font: 15px/1.4 system-ui, sans-serif; background: var(--page); color: var(--text); }
h1 { font-size: 20px; margin: 0 0 8px; overflow-wrap: anywhere; }
h2 { font-size: 15px; margin: 0 0 8px; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 0 0 24px; }
img, video { display: block; box-sizing: border-box; max-width: 100%; height: auto; border: 1px solid var(--line); }
p { margin: 8px 0 0; color: var(--muted); overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th { text-align: left; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); padding: 0 8px 8px; }
td { vertical-align: top; padding: 0 8px; }
th:first-child, td:first-child { padding-left: 0; }
th:last-child, td:last-child { padding-right: 0; }
td .file { font: 12px/1.4 ui-monospace, monospace; margin-top: 6px; }
@media (max-width: 600px) {
  body { padding: 16px; }
  section { padding: 12px; }
  thead { display: none; }
  table, tbody, tr, td { display: block; width: 100%; }
  td { padding: 0; }
  td + td { margin-top: 16px; }
  td::before { content: attr(data-side); display: block; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 6px; }
}
</style>
<h1>${title}</h1>
<p>${describeCounts(files, groups)}: ${filesInBodyOrder(groups).map((file) => escapeHtml(file.name)).join(', ')}</p>
${groups.map(groupSection).join('\n')}
</html>
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
