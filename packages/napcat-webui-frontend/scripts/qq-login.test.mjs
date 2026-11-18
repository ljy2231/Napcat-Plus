import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual page with a tiny hook/effect harness, without a browser or
// additional dependencies. Mocked JSX keeps the rendered tree inspectable.
const source = await readFile(new URL('../src/pages/qq_login.tsx', import.meta.url), 'utf8');
const consoleSource = await readFile(new URL('../src/utils/console.ts', import.meta.url), 'utf8');
const compile = (text) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const consoleModule = { exports: {} };
vm.runInNewContext(compile(consoleSource), { exports: consoleModule.exports, module: consoleModule });

function createPage () {
  const hooks = [];
  let cursor = 0;
  let effects = [];
  let timerId = 0;
  const timers = new Map();
  const responses = [];
  const toasts = [];
  const navigations = [];
  let tree;
  const react = {
    useState (initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = initial;
      return [hooks[i], (value) => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }];
    },
    useRef (initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: initial };
      return hooks[i];
    },
    useEffect (callback, deps) {
      const i = cursor++;
      const previous = hooks[i];
      if (!previous || deps.some((dep, index) => !Object.is(dep, previous.deps[index]))) {
        effects.push(() => { previous?.cleanup?.(); hooks[i] = { deps, cleanup: callback() }; });
      }
    },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const toast = Object.assign(() => {}, { success: (message) => toasts.push(message), error: (message) => toasts.push(message) });
  const manager = {
    checkQQLoginStatusWithQrcode: async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, '缺少轮询响应');
      return response;
    },
    getQQQuickLoginListNew: async () => [],
  };
  const mocks = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'react-hot-toast': { toast },
    'react-router-dom': { useNavigate: () => (...args) => navigations.push(args) },
    'crypto-js': {},
    '@/utils/console': consoleModule.exports,
    '@/controllers/qq_manager': { __esModule: true, default: manager },
    '@/hooks/use-dialog': { __esModule: true, default: () => ({ confirm () {} }) },
  };
  const require = (id) => mocks[id] ?? new Proxy({ __esModule: true, default: id }, { get: (target, key) => target[key] ?? String(key) });
  const module = { exports: {} };
  vm.runInNewContext(compile(source), {
    module, exports: module.exports, require,
    setInterval: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id), setTimeout: () => 0, clearTimeout: () => {},
  });
  const Page = module.exports.default;
  async function render () {
    cursor = 0;
    effects = [];
    tree = Page();
    for (const effect of effects) effect();
    await Promise.resolve();
    await Promise.resolve();
  }
  async function poll (response) {
    responses.push(response);
    assert.equal(timers.size, 1);
    [...timers.values()][0]();
    await Promise.resolve();
    await Promise.resolve();
  }
  return { responses, toasts, navigations, render, poll, get tree () { return tree; } };
}

function text (node) {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (typeof node !== 'object') return String(node);
  return `${typeof node.props.title === 'string' ? node.props.title : ''} ${text(node.props.children)}`;
}
const online = { isLogin: true, coreReady: true, isOffline: false, loginPhase: 'ready', qrcodeurl: '' };
const offline = { isLogin: false, coreReady: false, isOffline: false, loginPhase: 'waiting_qrcode', qrcodeurl: 'qq://qr' };

test('已登录直接打开和刷新页面：显示在线，不提醒或跳转，持续轮询', async () => {
  for (let visit = 0; visit < 2; visit++) {
    const page = createPage();
    page.responses.push(online);
    await page.render();
    // loginPhase 改变会重建 effect 并立即发起额外请求。
    page.responses.push(online);
    await page.render();
    await page.render();
    assert.match(text(page.tree), /在线就绪/);
    assert.match(text(page.tree), /QQ 已登录，无需再次登录/);
    assert.doesNotMatch(text(page.tree), /扫码登录/);
    await page.poll(online);
    await page.render();
    assert.equal(page.toasts.length, 0);
    assert.equal(page.navigations.length, 0);
  }
});

test('未登录页面保留登录方式，完成登录时仅提醒和跳转一次', async () => {
  const page = createPage();
  page.responses.push(offline);
  await page.render();
  await page.render();
  assert.match(text(page.tree), /扫码登录/);
  assert.match(text(page.tree), /快捷登录/);
  assert.match(text(page.tree), /密码登录/);
  await page.poll(online);
  page.responses.push(online);
  await page.render();
  await page.render();
  await page.poll(online);
  assert.deepEqual(page.toasts, ['QQ登录成功']);
  assert.equal(page.navigations.length, 1);
  assert.equal(page.navigations[0][0], '/');
  assert.equal(page.navigations[0][1].replace, true);
});

test('核心未就绪或离线时不显示在线成功提示', async () => {
  for (const status of [{ ...online, coreReady: false }, { ...online, coreReady: undefined }, { ...online, isOffline: true }]) {
    const page = createPage();
    page.responses.push(status);
    await page.render();
    page.responses.push(status);
    await page.render();
    await page.render();
    assert.doesNotMatch(text(page.tree), /在线就绪|QQ 已登录，无需再次登录/);
    assert.match(text(page.tree), status.isOffline ? /QQ 当前已离线/ : /正在等待核心服务就绪/);
  }
});

test('在线后掉线时重新展示登录方式和二维码', async () => {
  const page = createPage();
  page.responses.push(online);
  await page.render();
  page.responses.push(online);
  await page.render();
  await page.render();
  await page.poll(offline);
  page.responses.push(offline);
  await page.render();
  await page.render();
  assert.match(text(page.tree), /扫码登录/);
  assert.doesNotMatch(text(page.tree), /QQ 已登录，无需再次登录/);
  assert.equal(page.toasts.length, 0);
  assert.equal(page.navigations.length, 0);
});

test('初始请求失败不等同于未登录，恢复为已登录时不跳转', async () => {
  const page = createPage();
  page.responses.push(new Error('network'));
  await page.render();
  await page.render();
  assert.match(text(page.tree), /状态暂不可用/);
  await page.poll(online);
  page.responses.push(online);
  await page.render();
  await page.render();
  assert.match(text(page.tree), /在线就绪/);
  assert.equal(page.toasts.length, 0);
  assert.equal(page.navigations.length, 0);
});
