import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Type-only imports disappear during transpilation. No UI runtime or new test
// dependency is needed to exercise these pure data helpers with Node's runner.
const source = await readFile(new URL('../src/utils/console.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const helpers = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const toolsSource = await readFile(new URL('../src/utils/tools.ts', import.meta.url), 'utf8');
const toolsOutput = ts.transpileModule(toolsSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const tools = await import(`data:text/javascript;base64,${Buffer.from(toolsOutput).toString('base64')}`);
const config = { enabled: true, url: 'ws://gsuid_core:8765', tokenConfigured: true, reconnectIntervalMs: 5000, maxReconnectAttempts: 10 };
const storeSource = await readFile(new URL('../src/utils/plugin-store.ts', import.meta.url), 'utf8');
const storeOutput = ts.transpileModule(storeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const store = await import(`data:text/javascript;base64,${Buffer.from(storeOutput).toString('base64')}`);

test('store links only accept HTTPS and never embedded credentials', () => {
  assert.equal(store.safePluginHomepage('https://github.com/example/repo'), 'https://github.com/example/repo');
  for (const value of ['javascript:alert(1)', 'http://host', 'https://user:secret@host', '//host', 'invalid']) assert.equal(store.safePluginHomepage(value), undefined);
});
test('built-in store navigation is an explicit internal allowlist', () => {
  assert.equal(store.builtinPluginPath({ availability: 'builtin', builtinPath: '/gscore' }), '/gscore');
  for (const path of ['/terminal', '//evil.example', 'https://evil.example', '/gscore?token=secret']) assert.equal(store.builtinPluginPath({ availability: 'builtin', builtinPath: path }), undefined);
  assert.equal(store.builtinPluginPath({ availability: 'external', builtinPath: '/tools' }), undefined);
});
test('store never advertises installation for missing or unverified availability', () => {
  assert.equal(store.pluginAvailabilityLabel({}), '暂不可用');
  assert.equal(store.pluginAvailabilityLabel({ availability: 'installable' }), '安装暂停');
});

test('cleanup input is limited to safe categories and bounded days', () => {
  assert.equal(tools.cleanupInputError(['logs', 'cache'], 7), undefined);
  for (const categories of [[], ['qq'], ['logs', 'database']]) assert(tools.cleanupInputError(categories, 7));
  for (const days of [0, -1, 3651, 1.5, NaN]) assert(tools.cleanupInputError(['logs'], days));
});

test('preview expiry rejects malformed values and formats bytes without fabrication', () => {
  assert.equal(tools.previewExpiry('invalid'), 0);
  assert.equal(tools.previewExpiry(1700000000000), 1700000000000);
  assert.equal(tools.formatBytes(0), '0 B');
  assert.equal(tools.formatBytes(1024), '1.0 KB');
  assert.equal(tools.formatBytes(-1), '—');
});

test('absent status cannot be presented as connected', () => {
  assert.equal(helpers.loginPresentation().tone, 'neutral');
  assert.equal(helpers.gscorePresentation().tone, 'neutral');
  assert.equal(helpers.gscorePresentation('disabled').label, '未启用');
});

test('login only reports ready when both login and core are confirmed', () => {
  const login = { isLogin: true, coreReady: false, isOffline: false, loginPhase: 'initializing', loginError: '' };
  assert.equal(helpers.loginPresentation(login).tone, 'warning');
  assert.equal(helpers.loginPresentation({ ...login, coreReady: true }).label, '在线就绪');
  assert.equal(helpers.loginPresentation({ ...login, loginError: 'connection timeout' }).tone, 'danger');
});

test('uptime handles absent, negative, non-finite and real server seconds', () => {
  for (const value of [undefined, -1, Infinity, NaN]) assert.equal(helpers.formatUptime(value), '—');
  assert.equal(helpers.formatUptime(0), '0 分 0 秒');
  assert.equal(helpers.formatUptime(90), '1 分 30 秒');
  assert.equal(helpers.formatUptime(3661), '1 小时 1 分');
  assert.equal(helpers.formatUptime(90000), '1 天 1 小时');
});

test('GS URL validation accepts WebSockets, rejects embedded credentials', () => {
  assert.equal(helpers.validateGSCoreConfig(config), undefined);
  assert.equal(helpers.validateGSCoreConfig({ ...config, url: 'wss://example.com/ws/bot' }), undefined);
  for (const url of ['https://example.com', 'invalid', 'ws://name:secret@host', 'ws://host?token=secret', 'ws://host#fragment']) {
    assert(helpers.validateGSCoreConfig({ ...config, url }));
  }
});

test('retry policy validates bounded integer values', () => {
  for (const reconnectIntervalMs of [0, 999, 300001, NaN, 1000.5]) assert(helpers.validateGSCoreConfig({ ...config, reconnectIntervalMs }));
  for (const maxReconnectAttempts of [0, -1, 101, 1.5, NaN]) assert(helpers.validateGSCoreConfig({ ...config, maxReconnectAttempts }));
  assert.equal(helpers.validateGSCoreConfig({ ...config, reconnectIntervalMs: 1000, maxReconnectAttempts: 1 }), undefined);
  assert.equal(helpers.validateGSCoreConfig({ ...config, reconnectIntervalMs: 300000, maxReconnectAttempts: 100 }), undefined);
});

test('empty token input preserves existing credential without leaking metadata', () => {
  const payload = helpers.buildGSCoreUpdate(config, '', false);
  assert(!Object.hasOwn(payload, 'token'));
  assert(!Object.hasOwn(payload, 'tokenConfigured'));
});

test('explicit token clear sends empty string; replacement sends only new token', () => {
  assert.equal(helpers.buildGSCoreUpdate(config, '', true).token, '');
  assert.equal(helpers.buildGSCoreUpdate(config, 'new-token', false).token, 'new-token');
  assert.equal(helpers.buildGSCoreUpdate(config, 'new-token', true).token, '');
});
