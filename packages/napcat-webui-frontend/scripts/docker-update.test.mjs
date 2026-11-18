import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const load = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const util = await load(compile(await readFile(new URL('../src/utils/docker-update.ts', import.meta.url), 'utf8')));
const idle = { enabled: true, phase: 'idle', generation: 2 };

test('parses known phases and refuses invalid states', () => {
  for (const phase of ['idle', 'pulling', 'applying', 'rolling_back', 'succeeded', 'failed', 'blocked', 'rate_limited']) assert.equal(util.parseDockerUpdateStatus({ enabled: true, phase }).phase, phase);
  assert.equal(util.parseDockerUpdateStatus({ enabled: false, phase: 'disabled' }).enabled, false);
  for (const value of [null, {}, { enabled: true, phase: 'disabled' }, { enabled: false, phase: 'idle' }, { enabled: true, phase: 'other' }]) assert.equal(util.parseDockerUpdateStatus(value), undefined);
  assert.equal(util.parseDockerUpdateStatus({ ...idle, generation: -1 }).generation, undefined);
});

test('rate limit retains Unix seconds and does not unlock without host confirmation', () => {
  const limited = util.parseDockerUpdateStatus({ enabled: true, phase: 'rate_limited', retryAt: 1700000060.5 });
  assert.equal(limited.retryAt, 1700000060.5);
  assert.equal(util.canStartDockerUpdate(limited, false, false), false);
  assert.match(util.dockerUpdatePhaseLabel(limited.phase), /等待/);
  for (const retryAt of [-1, Infinity, NaN, '1700000060']) assert.equal(util.parseDockerUpdateStatus({ ...limited, retryAt }).retryAt, undefined);
});

test('only enabled, non-running, unblocked and confirmed status may start', () => {
  assert.equal(util.canStartDockerUpdate(idle, false, false), true);
  assert.equal(util.canStartDockerUpdate(idle, true, false), false);
  assert.equal(util.canStartDockerUpdate(idle, false, true), false);
  for (const phase of ['pulling', 'applying', 'rolling_back', 'blocked', 'rate_limited']) assert.equal(util.canStartDockerUpdate({ ...idle, phase }, false, false), false);
  assert.equal(util.canStartDockerUpdate(undefined, false, false), false);
  assert.equal(util.isAcceptedDockerUpdate({ accepted: true }), true);
  for (const result of [null, {}, { accepted: false }, { accepted: 'true' }]) assert.equal(util.isAcceptedDockerUpdate(result), false);
});

// Exercise event handlers with a tiny deterministic hook harness; no network is used.
const state = { slots: [], index: 0, calls: 0, result: { data: idle, loading: false, refresh() {}, async runAsync() { return idle; } }, failPost: false };
const fakeHooks = {
  useState(initial) { const i = state.index++; if (!(i in state.slots)) state.slots[i] = initial; return [state.slots[i], value => { state.slots[i] = value; }]; },
  useRef(initial) { const i = state.index++; return state.slots[i] ??= { current: initial }; },
  useEffect() {},
};
const manager = { async startDockerUpdate() { state.calls++; if (state.failPost) throw Error('disconnected'); return { accepted: true }; }, getDockerUpdateStatus() {} };
globalThis.__dockerTest = { React, fakeHooks, util, manager, state };
const source = compile(await readFile(new URL('../src/components/docker-update.tsx', import.meta.url), 'utf8'))
  .replace("import { Button } from '@heroui/button';", "const Button = 'button';")
  .replace("import { useRequest } from 'ahooks';", "const useRequest = () => globalThis.__dockerTest.state.result;")
  .replace("import { useEffect, useRef, useState } from 'react';", "const { useEffect, useRef, useState } = globalThis.__dockerTest.fakeHooks;")
  .replace("import ConsoleManager from '@/controllers/console_manager';", "const ConsoleManager = globalThis.__dockerTest.manager;")
  .replace("import { canStartDockerUpdate, dockerUpdateBusy, dockerUpdatePhaseLabel, isAcceptedDockerUpdate, parseDockerUpdateStatus } from '@/utils/docker-update';", "const { canStartDockerUpdate, dockerUpdateBusy, dockerUpdatePhaseLabel, isAcceptedDockerUpdate, parseDockerUpdateStatus } = globalThis.__dockerTest.util;");
const { DockerUpdatePanel } = await load('const React = globalThis.__dockerTest.React;\n' + source);
function reset(data = idle) { state.slots = []; state.index = 0; state.calls = 0; state.failPost = false; state.result = { data, loading: false, refresh() {}, async runAsync() { return data; } }; }
function tree() { state.index = 0; return DockerUpdatePanel(); }
function nodes(node, list = []) {
  if (Array.isArray(node)) node.forEach(item => nodes(item, list));
  else if (node && typeof node === 'object' && node.props) { list.push(node); nodes(node.props.children, list); }
  return list;
}
function button(root, text) { return nodes(root).find(node => node.type === 'button' && node.props.children === text); }
function text(root) { return nodes(root).flatMap(node => typeof node.props.children === 'string' ? [node.props.children] : []).join(' '); }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('explicit confirmation gates POST and prevents duplicate submissions', async () => {
  reset(); let root = tree();
  assert.equal(button(root, '更新 Docker').props.isDisabled, false);
  button(root, '更新 Docker').props.onPress(); root = tree();
  assert.equal(state.calls, 0); assert.match(text(root), /请先备份/);
  button(root, '取消').props.onPress(); assert.equal(button(tree(), '确认更新 Docker'), undefined);
  button(tree(), '更新 Docker').props.onPress(); root = tree();
  const confirm = button(root, '确认更新 Docker'); confirm.props.onPress(); confirm.props.onPress();
  await tick(); root = tree();
  assert.equal(state.calls, 1); assert.match(text(root), /受理不代表更新完成/);
  assert.equal(button(root, '更新 Docker').props.isDisabled, true);
  button(root, '刷新更新器状态').props.onPress(); await tick();
  assert.equal(button(tree(), '更新 Docker').props.isDisabled, false);
});

test('disabled, running, blocked and disconnected states never allow update', () => {
  for (const data of [{ enabled: false, phase: 'disabled' }, { ...idle, phase: 'pulling' }, { ...idle, phase: 'applying' }, { ...idle, phase: 'rolling_back' }, { ...idle, phase: 'blocked' }, undefined]) {
    reset(data); if (data === undefined) state.result.data = undefined;
    assert.equal(button(tree(), '更新 Docker').props.isDisabled, true);
  }
});

test('rate limited UI reports a recoverable wait and disables the action', () => {
  reset({ enabled: true, phase: 'rate_limited', retryAt: Date.now() / 1000 + 30 });
  const root = tree();
  assert.match(text(root), /等待限制解除/);
  assert.equal(button(root, '更新 Docker').props.isDisabled, true);
});

test('interrupted submission reports uncertainty and requires reconnect', async () => {
  reset(); state.failPost = true;
  button(tree(), '更新 Docker').props.onPress(); button(tree(), '确认更新 Docker').props.onPress(); await tick();
  let root = tree(); assert.match(text(root), /结果尚未确认/); assert.equal(button(root, '更新 Docker').props.isDisabled, true);
  state.result.runAsync = async () => { throw Error('offline'); };
  button(root, '刷新更新器状态').props.onPress(); await tick(); root = tree();
  assert.match(text(root), /无法连接更新器/); assert.equal(button(root, '更新 Docker').props.isDisabled, true);
});
