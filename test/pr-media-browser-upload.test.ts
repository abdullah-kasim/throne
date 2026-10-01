import assert from 'node:assert/strict';
import { test } from 'node:test';

const upload = await import('../.claude/skills/pr-media/browser-upload.mjs');
const publish = await import('../.claude/skills/pr-media/publish.mjs');

const enterprisePullRequest = { host: 'git.example.test', owner: 'shop', repo: 'storefront', number: '12' };
const publicPullRequest = { host: 'github.com', owner: 'shop', repo: 'storefront', number: '12' };

function options(overrides: Record<string, unknown> = {}) {
  return { collect: false, wizard: false, assets: new Map(), dryRun: false, ...overrides };
}

test('an uploaded image tag yields its attachment URL', () => {
  const text = '<img width="1400" height="900" alt="01-cart-after" src="https://git.example.test/user-attachments/assets/b871-5c3e" />\n';
  assert.equal(upload.attachmentUrlIn(text), 'https://git.example.test/user-attachments/assets/b871-5c3e');
});

test('an uploaded video, a bare URL on its own line, yields its attachment URL', () => {
  assert.equal(upload.attachmentUrlIn('\nhttps://git.example.test/user-attachments/assets/9a5e-7174\n\n'), 'https://git.example.test/user-attachments/assets/9a5e-7174');
});

test('markdown image syntax yields the URL without the closing parenthesis', () => {
  assert.equal(upload.attachmentUrlIn('![cart](https://github.com/user-attachments/assets/abc-123)'), 'https://github.com/user-attachments/assets/abc-123');
});

test('a comment box with no upload yields no URL', () => {
  assert.equal(upload.attachmentUrlIn(''), null);
  assert.equal(upload.attachmentUrlIn('some text https://git.example.test/shop/storefront/pull/12'), null);
});

test('the uploading placeholder counts as an upload still running', () => {
  assert.equal(upload.uploadStillRunning('![Uploading 01-cart-after.png…]()'), true);
  assert.equal(upload.uploadStillRunning('[Uploading 03-checkout-after.mp4…]()'), true);
  assert.equal(upload.uploadStillRunning('<img alt="01-cart-after" src="https://git.example.test/user-attachments/assets/b871" />'), false);
});

const noGitProxy = () => '';

test('the proxy comes from the dedicated variable, then HTTPS_PROXY, then git config for the host', () => {
  assert.equal(upload.proxyFor('git.example.test', { PR_MEDIA_BROWSER_PROXY: 'http://proxy.example.test:3128', HTTPS_PROXY: 'socks5h://127.0.0.1:1080' }, noGitProxy), 'http://proxy.example.test:3128');
  assert.equal(upload.proxyFor('git.example.test', { HTTPS_PROXY: 'socks5h://127.0.0.1:1080' }, noGitProxy), 'socks5h://127.0.0.1:1080');
  assert.equal(upload.proxyFor('git.example.test', {}, (host: string) => (host === 'git.example.test' ? 'socks5h://127.0.0.1:1081' : '')), 'socks5h://127.0.0.1:1081');
  assert.equal(upload.proxyFor('git.example.test', {}, noGitProxy), '');
});

test('Chrome gets socks5 where the setting says socks5h', () => {
  assert.equal(upload.chromeProxy('socks5h://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
  assert.equal(upload.chromeProxy('http://proxy.example.test:3128'), 'http://proxy.example.test:3128');
});

test('the browser session carries the profile, and the proxy only when one is found', () => {
  const withProxy = upload.browserSession('Git.Example.Test', {}, () => 'socks5h://127.0.0.1:1080');
  assert.equal(withProxy.name, 'pr-media-git-example-test');
  assert.deepEqual(withProxy.arguments.slice(-2), ['--proxy', 'socks5://127.0.0.1:1080']);
  assert.ok(withProxy.arguments.includes('--profile'));
  const withoutProxy = upload.browserSession('git.example.test', {}, noGitProxy);
  assert.equal(withoutProxy.arguments.includes('--proxy'), false);
});

test('gh gets the host proxy for an enterprise host, and github.com is left alone', () => {
  const readProxy = () => 'socks5h://127.0.0.1:1080';
  assert.equal(publish.environmentForHost('git.example.test', { PATH: '/bin' }, readProxy).HTTPS_PROXY, 'socks5h://127.0.0.1:1080');
  assert.equal(publish.environmentForHost('github.com', { PATH: '/bin' }, readProxy).HTTPS_PROXY, undefined);
  assert.equal(publish.environmentForHost('git.example.test', { HTTPS_PROXY: 'http://own.example.test:1' }, readProxy).HTTPS_PROXY, 'http://own.example.test:1');
});

test('each host keeps its own saved profile directory', () => {
  assert.equal(upload.profileDirectoryFor('Git.Example.Test', '/home/example'), '/home/example/.config/throne/agent-browser/git-example-test');
});

test('large files get a longer upload wait than small ones', () => {
  assert.ok(upload.uploadWaitMilliseconds(80 * 1048576) > upload.uploadWaitMilliseconds(100 * 1024));
});

test('an enterprise publish uploads through the browser unless asked otherwise', () => {
  assert.equal(publish.uploadsThroughTheBrowser(enterprisePullRequest, options()), true);
  assert.equal(publish.uploadsThroughTheBrowser(enterprisePullRequest, options({ wizard: true })), false);
  assert.equal(publish.uploadsThroughTheBrowser(enterprisePullRequest, options({ collect: true })), false);
  assert.equal(publish.uploadsThroughTheBrowser(enterprisePullRequest, options({ assets: new Map([['01-cart-after.png', 'https://git.example.test/user-attachments/assets/1']]) })), false);
});

test('a public github.com publish keeps using gh --attach', () => {
  assert.equal(publish.uploadsThroughTheBrowser(publicPullRequest, options()), false);
});
