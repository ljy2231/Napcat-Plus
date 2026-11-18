import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ts from 'typescript';

// Transpile the actual components for Node, as in the existing console tests.
const require = createRequire(import.meta.url);
async function loadTsx (url) {
  const source = await readFile(url, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports = {};
  new Function('require', 'exports', outputText)(require, exports);
  return exports;
}
const { siteConfig } = await loadTsx(new URL('../../config/site.tsx', import.meta.url));
const { default: Menus } = await loadTsx(new URL('./menus.tsx', import.meta.url));

function renderMenu (path) {
  return renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [path] },
    React.createElement(Menus, { items: siteConfig.navItems })));
}

test('QQ 登录 is the first connection item and preserves the other sections', () => {
  const html = renderMenu('/');
  assert.match(html, /连接与工具<\/div><a[^>]*href="\/qq_login"[^>]*><span class="console-nav-icon">.*?<\/span><span>QQ 登录<\/span><\/a>/);
  assert.match(html, /QQ 登录<\/span><\/a><\/div><div><a[^>]*href="\/network"/);
  assert.match(html, /系统管理<\/div><a[^>]*href="\/extension"/);
  assert.match(html, /工作空间<\/div><a[^>]*href="\/"/);
  assert.equal(siteConfig.navItems.filter((item) => item.href === '/qq_login').length, 1);
});

test('QQ 登录 uses the same active navigation styling', () => {
  const html = renderMenu('/qq_login');
  assert.match(html, /<a[^>]*aria-current="page"[^>]*class="console-nav-item is-active"[^>]*href="\/qq_login"/);
});
