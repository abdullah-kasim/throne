const justHappenedHeading = 'Just happened';
const saveFileName = 'save';
const bulletLinePattern = /^(\s*[-*+]\s+)(.*)$/;
const outcomesThatReloadTheEntry = ['saved', 'unchanged', 'entry-changed'];
const unchangedWords = 'Nothing to save: this entry is as it was loaded.';
const unsavedChangesWords = 'Unsaved changes.';
const unsavedTextWords = 'Your text that was not saved:';
const vanishedEntryWords = 'This entry changed on the page before you saved it, so your text was not saved.';
const unitOfBlock = new WeakMap();
const carriedStates = new Map();
const saveAnnouncement = document.getElementById('save-announcement');
let shownUnits = new Map();

function unitKey(sectionHeading, firstLine) {
  return `${sectionHeading}\n${firstLine}`;
}

function editorLine(source, index) {
  const bullet = bulletLinePattern.exec(source);
  const line = element('div', renderInline(bullet === null ? source.trim() : bullet[2]), 'unit-line');
  if (bullet !== null) line.classList.add('listed');
  line.setAttribute('data-line', String(index));
  line.hidden = source.trim() === '';
  return line;
}

function inlineMarkdown(node) {
  return [...node.childNodes].map(nodeMarkdown).join('');
}

function nodeMarkdown(node) {
  if (node.nodeName === '#text') return node.textContent.replaceAll(' ', ' ');
  if (node.nodeName === 'BR') return '\n';
  const inner = inlineMarkdown(node);
  const address = node.nodeName === 'A' ? node.getAttribute('href') : null;
  if (address !== null) return inner === address ? inner : `[${inner}](${address})`;
  if (node.nodeName === 'CODE') return inner.includes('`') ? `\`\` ${inner} \`\`` : `\`${inner}\``;
  if (['STRONG', 'B'].includes(node.nodeName)) return inner.trim() === '' ? inner : `**${inner}**`;
  if (['EM', 'I'].includes(node.nodeName)) return inner.trim() === '' ? inner : `*${inner}*`;
  if (['DIV', 'P'].includes(node.nodeName)) return `\n${inner}`;
  return inner;
}

function editedLines(unit) {
  const lineNodes = [...unit.editor.childNodes];
  const indexes = lineNodes.map((node) => (node.nodeName === 'DIV' ? node.getAttribute('data-line') : null));
  return lineNodes.flatMap((node, position) => {
    const source = indexes[position] === null ? undefined : unit.lines[indexes[position]];
    const written = (node.nodeName === 'DIV' ? inlineMarkdown(node) : nodeMarkdown(node)).replace(/^\n+|\n+$/g, '');
    if (source === undefined) return written.trim() === '' ? [] : written.split('\n');
    if (written.trim() === '') return source.trim() === '' ? [source] : [];
    const appearsOnce = indexes.indexOf(indexes[position]) === indexes.lastIndexOf(indexes[position]);
    if (appearsOnce && written === inlineMarkdown(editorLine(source, 0))) return [source];
    const prefix = bulletLinePattern.exec(source)?.[1] ?? /^\s*/.exec(source)[0];
    return written.split('\n').map((text) => `${prefix}${text}`);
  });
}

function unitMarkdown(unit) {
  const lines = [...(unit.heading === null ? [] : [unit.heading]), ...editedLines(unit)];
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop();
  return lines.join('\n');
}

function unitIsDirty(unit) {
  return unitMarkdown(unit) !== unit.loaded;
}

function focusedUnit() {
  return unitOfBlock.get(document.activeElement?.closest?.('.unit'));
}

function unitButton(words, label, action) {
  const button = element('button', [words]);
  button.setAttribute('type', 'button');
  button.setAttribute('aria-label', label);
  button.setAttribute('data-action', action);
  return button;
}

function createUnit(key, heading, lines, label) {
  const editor = element('div', lines.map(editorLine), 'unit-editor');
  const editorAttributes = { contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': label, spellcheck: 'true' };
  Object.entries(editorAttributes).forEach(([name, value]) => editor.setAttribute(name, value));
  const saveButton = unitButton('Save', `Save ${label}`, 'save');
  saveButton.hidden = true;
  const removeButtons = heading === null ? [] : [unitButton('Remove', `Remove ${label}`, 'remove')];
  const status = element('span', [], 'unit-status');
  const block = element('div', [editor, element('div', [saveButton, ...removeButtons, status], 'unit-controls')], 'unit');
  const loaded = [...(heading === null ? [] : [heading]), ...lines].join('\n');
  const unit = { key, heading, lines, loaded, editor, saveButton, status, block, replaceable: false, nextKey: key };
  unitOfBlock.set(block, unit);
  return unit;
}

function showUnitStatus(unit, message, isProblem) {
  unit.status.textContent = message;
  unit.status.classList.toggle('problem', isProblem);
}

function showSaveState(unit, message, isProblem) {
  showUnitStatus(unit, message, isProblem);
  saveAnnouncement.textContent = message;
}

function unsavedTextBlock(text) {
  return element('div', [element('p', [unsavedTextWords]), ...renderBlocks(text.split('\n'))], 'unsaved');
}

function showCarriedState(unit) {
  const carried = carriedStates.get(unit.key);
  if (carried === undefined) return;
  carriedStates.delete(unit.key);
  showUnitStatus(unit, carried.message, carried.isProblem);
  if (carried.unsavedText !== '') unit.block.append(unsavedTextBlock(carried.unsavedText));
}

function entryEnd(lines, start) {
  let end = start + 1;
  for (let position = start + 1; position < lines.length && ![2, 3].includes(headingPattern.exec(lines[position])?.[1].length); position += 1) {
    if (lines[position].trim() !== '') end = position + 1;
  }
  return end;
}

function renderPageBlocks(lines, previousUnits) {
  const blocks = [];
  const units = new Map();
  let pendingLines = [];
  let sectionHeading = '';
  const showPendingLines = () => blocks.push(...renderBlocks(pendingLines.splice(0)));
  const showUnit = (key, heading, unitLines, label) => {
    const previous = previousUnits.get(key);
    const keepsPrevious = previous !== undefined && !previous.replaceable && (unitIsDirty(previous) || previous === focusedUnit());
    const unit = keepsPrevious ? previous : createUnit(key, heading, unitLines, label);
    if (!keepsPrevious) showCarriedState(unit);
    units.set(key, unit);
    blocks.push(unit.block);
  };
  for (let position = 0; position < lines.length; position += 1) {
    const line = lines[position];
    const heading = headingPattern.exec(line);
    if (heading !== null && [2, 3].includes(heading[1].length)) showPendingLines();
    if (heading !== null && heading[1].length === 2) {
      sectionHeading = heading[2].trim();
      blocks.push(readHeading(lines, position).block);
    } else if (heading !== null && heading[1].length === 3) {
      const end = entryEnd(lines, position);
      blocks.push(readHeading(lines, position).block);
      showUnit(unitKey(sectionHeading, line), line, lines.slice(position + 1, end), `${heading[2].trim()} entry`);
      position = end - 1;
    } else if (sectionHeading === justHappenedHeading && bulletLinePattern.test(line)) {
      showPendingLines();
      showUnit(unitKey(sectionHeading, line), null, [line], 'Just happened line');
    } else pendingLines.push(line);
  }
  showPendingLines();
  return { blocks, units };
}

function noticesOfUnsavedText(previousUnits, units) {
  for (const [key, unit] of previousUnits) {
    if (!units.has(key) && !unit.replaceable && unitIsDirty(unit)) carriedStates.set(key, { message: vanishedEntryWords, isProblem: true, unsavedText: unitMarkdown(unit) });
  }
  const notices = [...carriedStates.values()].filter(({ unsavedText }) => unsavedText !== '');
  carriedStates.clear();
  return notices.map(({ message, unsavedText }) => element('section', [element('p', [message], 'problem'), unsavedTextBlock(unsavedText)]));
}

function showEntries(markdown) {
  const previouslyFocused = focusedUnit();
  const selection = previouslyFocused === undefined ? null : window.getSelection();
  const caret = selection && [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset];
  const { blocks, units } = renderPageBlocks(markdown.split(/\r?\n/), shownUnits);
  pageContent.replaceChildren(...noticesOfUnsavedText(shownUnits, units), ...groupIntoSections(blocks, readEntries(markdown)));
  shownUnits = units;
  const unitToFocus = units.get(previouslyFocused?.nextKey);
  unitToFocus?.editor.focus();
  if (unitToFocus !== undefined && unitToFocus === previouslyFocused && caret[0] !== null) window.getSelection().setBaseAndExtent(...caret);
}

async function postSave(loaded, edited) {
  try {
    const body = JSON.stringify({ loaded, edited });
    const response = await fetch(new URL(saveFileName, folderThePageWasServedFrom()).href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const answer = await response.json().catch(() => ({}));
    if (typeof answer.outcome === 'string' && typeof answer.message === 'string') return answer;
    return { outcome: 'failed', message: `Not saved: the page server answered ${response.status}.` };
  } catch {
    return { outcome: 'failed', message: 'Not saved: the page server could not be reached.' };
  }
}

function neighbourKey(unit) {
  const keys = [...shownUnits.keys()];
  const position = keys.indexOf(unit.key);
  return keys[position + 1] ?? keys[position - 1];
}

async function saveUnit(unit, edited) {
  if (unit.isSaving) return;
  if (edited === unit.loaded) return showSaveState(unit, unchangedWords, false);
  showSaveState(unit, 'Saving.', false);
  unit.isSaving = true;
  const { outcome, message } = await postSave(unit.loaded, edited);
  unit.isSaving = false;
  const isProblem = outcome !== 'saved' && outcome !== 'unchanged';
  if (!outcomesThatReloadTheEntry.includes(outcome)) return showSaveState(unit, message, true);
  const savedKey = unit.heading !== null || edited === '' ? unit.key : unitKey(justHappenedHeading, edited.split('\n')[0]);
  const key = isProblem ? unit.key : savedKey;
  carriedStates.set(key, { message, isProblem, unsavedText: isProblem ? edited : '' });
  Object.assign(unit, { replaceable: true, nextKey: edited === '' && !isProblem ? neighbourKey(unit) : key });
  await refreshPage();
  if ([...shownUnits.values()].includes(unit)) showEntries(shownMarkdown ?? '');
  saveAnnouncement.textContent = message;
}

document.addEventListener('input', (event) => {
  const unit = unitOfBlock.get(event.target.closest?.('.unit'));
  if (unit === undefined) return;
  const isDirty = unitIsDirty(unit);
  unit.saveButton.hidden = !isDirty;
  unit.status.textContent = isDirty ? unsavedChangesWords : '';
  unit.status.classList.toggle('problem', false);
});

document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key?.toLowerCase() !== 's') return;
  event.preventDefault();
  const unit = focusedUnit();
  if (unit !== undefined) saveUnit(unit, unitMarkdown(unit));
});

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a');
  if (link?.closest('.unit-editor') && (event.metaKey || event.ctrlKey)) return window.open(link.href, '_blank', 'noreferrer');
  const button = event.target.closest?.('[data-action]');
  const unit = unitOfBlock.get(button?.closest('.unit'));
  if (unit !== undefined) saveUnit(unit, button.getAttribute('data-action') === 'remove' ? '' : unitMarkdown(unit));
});
