import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const utility = transpile(await readFile(new URL('../src/utils/console-update.ts', import.meta.url), 'utf8'));
const update = await import(dataUrl(utility));
const valid = { currentVersion: 'v1', latestVersion: 'v2', status: 'available', releaseUrl: 'https://example.com/release' };

test('valid checks, unknown and malformed checks are presented conservatively', () => {
  assert.equal(update.consoleUpdateLabel(update.parseConsoleUpdate(valid), false, null), '有新版本！');
  assert.equal(update.consoleUpdateLabel(update.parseConsoleUpdate({ ...valid, status: 'current' }), false, null), '已是最新版本');
  for (const value of [null, {}, { ...valid, status: 'unknown' }, { ...valid, latestVersion: null }, { ...valid, currentVersion: '' }, { ...valid, status: 'new' }]) {
    assert.equal(update.consoleUpdateLabel(update.parseConsoleUpdate(value), false, null), '版本检查不可用');
  }
  assert.equal(update.consoleUpdateLabel(update.parseConsoleUpdate(valid), true, null), '正在检查版本');
  assert.equal(update.consoleUpdateLabel(update.parseConsoleUpdate(valid), false, new Error('offline')), '版本检查不可用');
});

test('release links only allow absolute HTTPS without credentials', () => {
  assert.equal(update.parseConsoleUpdate(valid).releaseUrl, valid.releaseUrl);
  for (const releaseUrl of ['javascript:alert(1)', 'http://example.com', '//example.com', 'https://user:pass@example.com']) assert.equal(update.parseConsoleUpdate({ ...valid, releaseUrl }).releaseUrl, undefined);
});

// Render real components with a stubbed hook and lightweight UI elements, without a browser.
globalThis.__updateTest = { React, result: {}, utility: update };
const src = await readFile(new URL('../src/components/console-update.tsx', import.meta.url), 'utf8');
const componentSource = transpile(src)
  .replace("import { Button } from '@heroui/button';", "const Button = ({children, isDisabled, onPress}) => React.createElement('button', {disabled: isDisabled, onClick: onPress}, children);")
  .replace("import { Link } from 'react-router-dom';", "const Link = ({children, to, ...props}) => React.createElement('a', {href: to, ...props}, children);")
  .replace("import useConsoleUpdate from '@/hooks/use-console-update';", "const useConsoleUpdate = () => globalThis.__updateTest.result;")
  .replace("import { consoleUpdateLabel } from '@/utils/console-update';", "const { consoleUpdateLabel } = globalThis.__updateTest.utility;");
const components = await import(dataUrl('const React = globalThis.__updateTest.React;\n' + componentSource));
function render(component, result, props = {}) {
  globalThis.__updateTest.result = { loading: false, refresh() {}, ...result };
  return renderToStaticMarkup(React.createElement(component, props));
}

test('dashboard and about show available version and release link', () => {
  const data = update.parseConsoleUpdate(valid);
  const card = render(components.ConsoleVersionCard, { data });
  assert.match(card, /有新版本！/); assert.match(card, /最新版本/); assert.match(card, /v2/);
  const panel = render(components.ConsoleUpdatePanel, { data });
  assert.match(panel, /https:\/\/example.com\/release/);
});

test('stale, failed and loading checks never advertise current or update', () => {
  const data = update.parseConsoleUpdate(valid);
  for (const result of [{ data, error: new Error('offline') }, { data, loading: true }, { data: update.parseConsoleUpdate({ ...valid, status: 'unknown' }) }]) {
    for (const component of [components.ConsoleVersionCard, components.ConsoleUpdatePanel]) {
      const html = render(component, result);
      assert.doesNotMatch(html, /已是最新版本|有新版本！|更新 Docker/);
    }
  }
  assert.match(render(components.ConsoleVersionCard, { data: update.parseConsoleUpdate({ ...valid, status: 'current' }) }), /已是最新版本/);
});
