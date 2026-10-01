import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COMMENT_BOX_SELECTOR = '#new_comment_field';
export const COMMENT_FILE_INPUT_SELECTOR = '#fc-new_comment_field';
const SIGN_IN_WAIT_SECONDS = Number(process.env.PR_MEDIA_SIGN_IN_WAIT_SECONDS ?? 600);
const SIGN_IN_POLL_MILLISECONDS = 3000;
const UPLOAD_POLL_MILLISECONDS = 1000;
const UPLOAD_BASE_WAIT_MILLISECONDS = 60000;
const UPLOAD_WAIT_MILLISECONDS_PER_MEGABYTE = 2000;

export function profileDirectoryFor(host, home = os.homedir()) {
  return path.join(home, '.config', 'throne', 'agent-browser', host.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
}

export function gitProxyFor(host) {
  const result = spawnSync('git', ['config', '--get-urlmatch', 'http.proxy', `https://${host}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

export function proxyFor(host, environment = process.env, readGitProxy = gitProxyFor) {
  return (
    environment.PR_MEDIA_BROWSER_PROXY ||
    environment.HTTPS_PROXY ||
    environment.https_proxy ||
    environment.ALL_PROXY ||
    environment.all_proxy ||
    readGitProxy(host) ||
    ''
  );
}

export function chromeProxy(proxy) {
  return proxy.replace(/^socks5h:\/\//i, 'socks5://');
}

export function attachmentUrlIn(text) {
  const match = text.match(/https:\/\/[^\s"'()<>]+\/user-attachments\/(?:assets|files)\/[^\s"'()<>]+/);
  return match ? match[0] : null;
}

export function uploadStillRunning(text) {
  return /\[Uploading [^\]]*\]\(\)/i.test(text);
}

export function uploadWaitMilliseconds(sizeInBytes) {
  return UPLOAD_BASE_WAIT_MILLISECONDS + Math.ceil(sizeInBytes / 1048576) * UPLOAD_WAIT_MILLISECONDS_PER_MEGABYTE;
}

export function browserSession(host, environment = process.env, readGitProxy = gitProxyFor) {
  const name = `pr-media-${host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const proxy = chromeProxy(proxyFor(host, environment, readGitProxy));
  return {
    name,
    host,
    arguments: ['--namespace', name, '--profile', profileDirectoryFor(host), ...(proxy ? ['--proxy', proxy] : [])],
  };
}

function waitMilliseconds(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runBrowser(session, command, ...rest) {
  const result = spawnSync(process.env.AGENT_BROWSER ?? 'agent-browser', [...session.arguments, command, '--json', ...rest], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_BROWSER_SESSION: session.name },
  });
  const lastLine = (result.stdout ?? '').trim().split('\n').pop() ?? '';
  let reply;
  try {
    reply = JSON.parse(lastLine);
  } catch {
    throw new Error(`agent-browser ${command} gave no JSON reply (exit ${result.status}): ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
  }
  if (!reply.success) {
    const failure = JSON.stringify(reply.error);
    if (/process_singleton|SingletonLock/.test(failure)) {
      throw new Error(`another browser is already using the saved profile ${profileDirectoryFor(session.host)}; wait for the other publish to finish, or close that browser with: agent-browser close --all`);
    }
    throw new Error(`agent-browser ${command} failed: ${failure.slice(0, 300)}`);
  }
  return reply.data ?? {};
}

function evaluate(session, script) {
  return runBrowser(session, 'eval', script).result;
}

function signedInLogin(session) {
  return evaluate(session, "document.querySelector('meta[name=user-login]')?.content || ''") || '';
}

function closeBrowser(session) {
  spawnSync(process.env.AGENT_BROWSER ?? 'agent-browser', ['--namespace', session.name, 'close'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_BROWSER_SESSION: session.name },
  });
}

function withHeadedWindow(session) {
  return { ...session, arguments: [...session.arguments, '--headed'] };
}

export function ensureSignedIn(session, pageUrl, log = (line) => process.stderr.write(`${line}\n`)) {
  runBrowser(session, 'open', pageUrl);
  let login = signedInLogin(session);
  if (login) return login;
  closeBrowser(session);
  const headed = withHeadedWindow(session);
  runBrowser(headed, 'open', `https://${session.host}/login?return_to=${encodeURIComponent(pageUrl)}`);
  log(`pr-media: ${session.host} is not signed in. A browser window is open on its sign-in page; sign in there. Waiting up to ${SIGN_IN_WAIT_SECONDS}s.`);
  const deadline = Date.now() + SIGN_IN_WAIT_SECONDS * 1000;
  while (Date.now() < deadline) {
    waitMilliseconds(SIGN_IN_POLL_MILLISECONDS);
    login = signedInLogin(headed);
    if (login) break;
  }
  closeBrowser(headed);
  if (!login) throw new Error(`no sign-in to ${session.host} within ${SIGN_IN_WAIT_SECONDS}s; run publish again to retry`);
  runBrowser(session, 'open', pageUrl);
  login = signedInLogin(session);
  if (!login) throw new Error(`signed in to ${session.host}, but the saved profile in ${profileDirectoryFor(session.host)} did not keep the session`);
  log(`pr-media: signed in to ${session.host} as ${login}; the profile keeps the session for later runs`);
  return login;
}

function setCommentBox(session, text) {
  evaluate(
    session,
    `(() => { const box = document.querySelector(${JSON.stringify(COMMENT_BOX_SELECTOR)}); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', { bubbles: true })); return box.value.length; })()`,
  );
}

function commentBoxText(session) {
  return evaluate(session, `document.querySelector(${JSON.stringify(COMMENT_BOX_SELECTOR)})?.value ?? ''`) ?? '';
}

function commentBoxIsPresent(session) {
  return evaluate(
    session,
    `!!document.querySelector(${JSON.stringify(COMMENT_BOX_SELECTOR)}) && !!document.querySelector(${JSON.stringify(COMMENT_FILE_INPUT_SELECTOR)})`,
  );
}

export function uploadWithBrowser(pullRequest, files, folder, log = (line) => process.stderr.write(`${line}\n`)) {
  const session = browserSession(pullRequest.host);
  const pageUrl = `https://${pullRequest.host}/${pullRequest.owner}/${pullRequest.repo}/pull/${pullRequest.number}`;
  const login = ensureSignedIn(session, pageUrl, log);
  if (!commentBoxIsPresent(session)) {
    closeBrowser(session);
    throw new Error(`${pageUrl} has no ${COMMENT_BOX_SELECTOR} comment box with a ${COMMENT_FILE_INPUT_SELECTOR} file input; the page layout changed, so fall back to --wizard and --collect`);
  }
  log(`pr-media: uploading ${files.length} file(s) to ${pullRequest.host} as ${login} through the pull request's comment box; nothing is posted`);
  const urls = new Map();
  try {
    for (const file of files) {
      const filePath = path.join(folder, file.name);
      setCommentBox(session, '');
      runBrowser(session, 'upload', COMMENT_FILE_INPUT_SELECTOR, filePath);
      const deadline = Date.now() + uploadWaitMilliseconds(statSync(filePath).size);
      let text = '';
      while (Date.now() < deadline) {
        text = commentBoxText(session);
        if (attachmentUrlIn(text) && !uploadStillRunning(text)) break;
        waitMilliseconds(UPLOAD_POLL_MILLISECONDS);
      }
      const url = attachmentUrlIn(text);
      if (!url || uploadStillRunning(text)) {
        throw new Error(`${file.name}: no finished upload in the comment box before the wait ran out; it held: ${text.slice(0, 200) || '(nothing)'}`);
      }
      urls.set(file.name, url);
      log(`pr-media: uploaded ${file.name}`);
    }
  } finally {
    try {
      setCommentBox(session, '');
    } finally {
      closeBrowser(session);
    }
  }
  return urls;
}
