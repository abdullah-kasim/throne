#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTROL_STATE_COUNT = 3;
const MAXIMUM_SHOTS_PER_STATE = 8;
const SCROLL_OVERLAP = 100;
const REQUIRED_FIELDS = ['base', 'head', 'viewports', 'themes', 'chains'];

async function loadRunDescription(inputPath) {
  const { default: run } = await import(pathToFileURL(path.resolve(inputPath)).href);
  for (const field of REQUIRED_FIELDS) {
    if (!run?.[field]) throw new Error(`${inputPath} names no ${field}`);
  }
  for (const chain of run.chains) {
    if (!chain.url) throw new Error(`chain ${chain.name} names no start url`);
    if (!Array.isArray(chain.states) || chain.states.length === 0) throw new Error(`chain ${chain.name} names no states`);
    for (const state of chain.states) {
      if (typeof state.settle !== 'function') throw new Error(`state ${chain.name}/${state.name} names no settle condition`);
    }
  }
  return run;
}

function loadPlaywright(run) {
  const requireFromProject = createRequire(path.join(path.resolve(run.playwrightFrom ?? process.cwd()), 'package.json'));
  const requireFromPlaywright = createRequire(requireFromProject.resolve('playwright'));
  return {
    chromium: requireFromProject('playwright').chromium,
    PNG: requireFromPlaywright('playwright-core/lib/utilsBundle').PNG,
  };
}

async function openSide(browser, run, viewport, label, role) {
  const context = await browser.newContext({ ...run.contextOptions, viewport, colorScheme: run.themes[0] });
  const page = await context.newPage();
  await run.preparePage?.(page, { side: role });
  return { page, context, label, role, url: run[role], theme: run.themes[0] };
}

function openPair(browser, run, viewport, sides) {
  return Promise.all(sides.map(([label, role]) => openSide(browser, run, viewport, label, role)));
}

function closePair(pair) {
  return Promise.all(pair.map((side) => side.context.close()));
}

function startChain(pair, chain) {
  return Promise.all(
    pair.map(async (side) => {
      await chain.preparePage?.(side.page, { side: side.role });
      await side.page.goto(side.url + chain.url, { waitUntil: 'domcontentloaded' });
    }),
  );
}

function takeStep(pair, state) {
  return Promise.all(
    pair.map(async (side) => {
      await state.step?.(side.page, { side: side.role });
      await state.settle(side.page, { side: side.role });
    }),
  );
}

function waitForPaint(page) {
  return page.evaluate(() => new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted))));
}

async function switchThemeInPlace(side, run, theme) {
  if (side.theme === theme) return;
  await side.page.emulateMedia({ colorScheme: theme });
  await run.applyTheme?.(side.page, theme);
  await waitForPaint(side.page);
  side.theme = theme;
}

async function captureScrolledShots(page, run) {
  await page.mouse.move(0, 0);
  const target = await page.evaluateHandle((scrollRoot) => {
    let element = scrollRoot ? document.querySelector(scrollRoot) : null;
    while (element && element !== document.body) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) return element;
      element = element.parentElement;
    }
    return document.scrollingElement;
  }, run.scrollRoot ?? null);
  const { height, visibleHeight } = await target.evaluate((element) => ({ height: element.scrollHeight, visibleHeight: element.clientHeight }));
  const step = visibleHeight - SCROLL_OVERLAP;
  const shots = [];
  for (let top = 0; shots.length < MAXIMUM_SHOTS_PER_STATE; top += step) {
    await target.evaluate((element, y) => { element.scrollTop = y; }, top);
    await waitForPaint(page);
    shots.push(await page.screenshot({ animations: 'disabled', caret: 'hide' }));
    if (top + visibleHeight >= height) break;
  }
  await target.evaluate((element) => { element.scrollTop = 0; });
  return shots;
}

function countDifferentPixels(PNG, first, second) {
  const a = PNG.sync.read(first);
  const b = PNG.sync.read(second);
  if (a.width !== b.width || a.height !== b.height) return null;
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) count++;
  }
  return count;
}

function compareShots(PNG, firstShots, secondShots) {
  if (firstShots.length !== secondShots.length) return `shot count ${firstShots.length}/${secondShots.length}`;
  let total = 0;
  for (let i = 0; i < firstShots.length; i++) {
    const count = countDifferentPixels(PNG, firstShots[i], secondShots[i]);
    if (count === null) return `shot ${i} size differs`;
    total += count;
  }
  return total;
}

async function saveShots(outputFolder, name, side, shots) {
  const paths = shots.map((_, index) => path.join(outputFolder, 'shots', `${name}-${side.label}-${index}.png`));
  await Promise.all(shots.map((shot, index) => writeFile(paths[index], shot)));
  return paths;
}

async function captureTheme({ pair, run, theme, name, outputFolder, PNG }) {
  const shotsPerSide = await Promise.all(
    pair.map(async (side) => {
      await switchThemeInPlace(side, run, theme);
      return captureScrolledShots(side.page, run);
    }),
  );
  const paths = await Promise.all(pair.map((side, index) => saveShots(outputFolder, name, side, shotsPerSide[index])));
  return { pixels: compareShots(PNG, shotsPerSide[0], shotsPerSide[1]), shots: Object.fromEntries(pair.map((side, index) => [side.label, paths[index]])) };
}

function isDifference(row) {
  return Boolean(row.error) || row.pixels !== 0;
}

function printRow(kind, row) {
  const verdict = isDifference(row) ? 'DIFFERS' : 'same';
  const outcome = row.error || (typeof row.pixels === 'number' ? `${row.pixels} px` : row.pixels);
  console.log(`${verdict} ${kind} ${row.chain}/${row.state} ${row.viewport} ${row.theme} ${outcome}`);
}

async function walkChainOnBothSides({ browser, run, chain, viewportName, sides, themes, stateLimit, kind, outputFolder, PNG }) {
  const viewport = run.viewports[viewportName];
  const pair = await openPair(browser, run, viewport, sides);
  const rows = [];
  try {
    await startChain(pair, chain);
    for (const state of chain.states.slice(0, stateLimit)) {
      const place = { chain: chain.name, state: state.name, viewport: viewportName };
      let stepError = '';
      try {
        await takeStep(pair, state);
      } catch (error) {
        stepError = String(error.message).split('\n')[0];
      }
      for (const theme of themes) {
        const row = { ...place, theme, pixels: null, shots: {}, error: stepError };
        if (!stepError) {
          try {
            Object.assign(row, await captureTheme({ pair, run, theme, name: `${kind}-${chain.name}-${state.name}-${viewportName}-${theme}`, outputFolder, PNG }));
          } catch (error) {
            row.error = String(error.message).split('\n')[0];
          }
        }
        rows.push(row);
        printRow(kind, row);
        if (isDifference(row)) return rows;
      }
    }
    return rows;
  } finally {
    await closePair(pair);
  }
}

function controlChains(chains) {
  const picked = [];
  let remaining = CONTROL_STATE_COUNT;
  for (const chain of chains) {
    if (remaining === 0) break;
    const stateLimit = Math.min(remaining, chain.states.length);
    picked.push({ chain, stateLimit });
    remaining -= stateLimit;
  }
  return picked;
}

async function checkControlIsQuiet({ browser, run, outputFolder, PNG }) {
  const viewportName = Object.keys(run.viewports)[0];
  const rows = [];
  for (const { chain, stateLimit } of controlChains(run.chains)) {
    rows.push(...(await walkChainOnBothSides({ browser, run, chain, viewportName, sides: [['base', 'base'], ['control', 'base']], themes: [run.themes[0]], stateLimit, kind: 'control', outputFolder, PNG })));
  }
  return { quiet: !rows.some(isDifference), rows };
}

async function locateFirstDifferingState({ browser, run, chain, viewportName, theme, lastIndex, outputFolder, PNG }) {
  const viewport = run.viewports[viewportName];
  for (let index = 0; index <= lastIndex; index++) {
    const state = chain.states[index];
    const pair = await openPair(browser, run, viewport, [['base', 'base'], ['head', 'head']]);
    try {
      await startChain(pair, chain);
      for (const earlier of chain.states.slice(0, index + 1)) await takeStep(pair, earlier);
      const row = { chain: chain.name, state: state.name, viewport: viewportName, theme, error: '', ...(await captureTheme({ pair, run, theme, name: `fresh-${chain.name}-${state.name}-${viewportName}-${theme}`, outputFolder, PNG })) };
      printRow('fresh', row);
      if (isDifference(row)) return row;
    } catch (error) {
      const row = { chain: chain.name, state: state.name, viewport: viewportName, theme, pixels: null, shots: {}, error: String(error.message).split('\n')[0] };
      printRow('fresh', row);
      return row;
    } finally {
      await closePair(pair);
    }
  }
  return null;
}

function withControlPixels(rows, controlRows) {
  return rows.map(({ pixels, ...row }) => {
    const control = controlRows.find((candidate) => ['chain', 'state', 'viewport', 'theme'].every((key) => candidate[key] === row[key]));
    return { ...row, headPixels: pixels, controlPixels: control ? control.pixels : null };
  });
}

async function runPixelParity(inputPath, outputFolder) {
  const run = await loadRunDescription(inputPath);
  const { chromium, PNG } = loadPlaywright(run);
  await mkdir(path.join(outputFolder, 'shots'), { recursive: true });
  const browser = await chromium.launch();
  const results = { noisy: false, control: [], states: [], located: [] };
  try {
    const control = await checkControlIsQuiet({ browser, run, outputFolder, PNG });
    results.control = control.rows;
    if (!control.quiet) {
      const failedRow = control.rows.find((row) => row.error);
      results.noisy = !failedRow;
      console.log(failedRow ? `the control could not finish at ${failedRow.chain}/${failedRow.state}, so the run stops: ${failedRow.error}` : 'page is noisy: base against base differs, so no difference on this page can be trusted');
      return results;
    }
    for (const chain of run.chains) {
      for (const viewportName of Object.keys(run.viewports)) {
        const rows = await walkChainOnBothSides({ browser, run, chain, viewportName, sides: [['base', 'base'], ['head', 'head']], themes: run.themes, stateLimit: chain.states.length, kind: 'chain', outputFolder, PNG });
        results.states.push(...rows);
        const failing = rows.find(isDifference);
        if (!failing) continue;
        const lastIndex = chain.states.findIndex((state) => state.name === failing.state);
        const located = await locateFirstDifferingState({ browser, run, chain, viewportName, theme: failing.theme, lastIndex, outputFolder, PNG });
        results.located.push({ chain: chain.name, viewport: viewportName, theme: failing.theme, chainStoppedAt: failing.state, firstDifferingState: located ? located.state : null, fresh: located });
        console.log(located ? `located ${chain.name} ${viewportName} ${failing.theme}: first differing state on a fresh page is ${located.state}` : `located ${chain.name} ${viewportName} ${failing.theme}: no state differs on a fresh page, so the difference comes from the chain's history or from noise`);
      }
    }
    return results;
  } finally {
    await browser.close();
    results.states = withControlPixels(results.states, results.control);
    await writeFile(path.join(outputFolder, 'results.json'), JSON.stringify(results, null, 2));
  }
}

const [inputPath, outputFolder] = process.argv.slice(2);
if (!inputPath || !outputFolder) {
  console.error('usage: pixel-parity.mjs <run description .mjs> <output folder>');
  process.exit(2);
}
const results = await runPixelParity(inputPath, outputFolder);
const differs = results.noisy || results.control.some((row) => row.error) || results.states.some((row) => row.error || row.headPixels !== 0);
process.exit(differs ? 1 : 0);
