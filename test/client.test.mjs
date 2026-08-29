/**
 * Browser-half tests: the hand-written client bundle loads in the lazy-CJS
 * factory format, registers the keyed Plugins-settings card, and its
 * component renders and stages edits correctly under a minimal React stub.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { suite, assert } from './helpers.mjs';

/** Evaluate lib/client.js in a sandbox and capture the module registration. */
function loadBundleEntry() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const captured = [];
  const sandbox = { window: { __ModuleLoader__: { load(entry) { captured.push(entry); } } }, console };
  vm.runInNewContext(source, sandbox);
  assert(captured.length === 1, 'one module registration');
  return captured[0];
}

/** Minimal React: element trees + per-render hook slots + re-render on setState. */
function makeReactStub() {
  const hookStore = [];
  let index = 0;
  const rerenders = new Set();
  const react = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true),
      };
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
    useState(initial) {
      const slot = index++;
      if (!(slot in hookStore)) hookStore[slot] = typeof initial === 'function' ? initial() : initial;
      return [hookStore[slot], (value) => {
        hookStore[slot] = typeof value === 'function' ? value(hookStore[slot]) : value;
        for (const rerender of rerenders) rerender();
      }];
    },
    useEffect() {
      index += 1; // reserve the slot; effects are not exercised here
    },
  };
  return { react, rerenders, beginRender: () => { index = 0; } };
}

/** Collect matching nodes/texts from a stub element tree, depth-first. */
function collect(node, pred, out = []) {
  if (node !== null && typeof node === 'object') {
    if (pred(node)) out.push(node);
    for (const child of node.children ?? []) collect(child, pred, out);
  } else if (pred(node)) {
    out.push(node);
  }
  return out;
}

const elements = (tree, type) => collect(tree, (node) => node !== null && typeof node === 'object' && node.type === type);
const textsOf = (tree) => collect(tree, (node) => typeof node === 'string' || typeof node === 'number').map(String);

/** A mock browser-plugin context capturing slot registrations. */
function makeBrowserCtx(scope, mirror) {
  const registrations = [];
  const localeCalls = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    locale: {
      register(ns, dicts) {
        localeCalls.push({ ns, langs: Object.keys(dicts) });
        return () => {};
      },
      bind() {
        return (key) => key; // identity: copy keys appear as literal text
      },
    },
    settingsScope: {
      bind() { return scope; },
      describe() { return mirror; },
    },
    slots: {
      inject(slotName, registrar) {
        if (slotName !== 'settings.plugin.item') return;
        const result = registrar();
        if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
          for (const registration of result) registrations.push(registration);
        } else {
          registrations.push(result);
        }
      },
      register(options, component) {
        return { options, component };
      },
    },
  };
  return { ctx, registrations, localeCalls };
}

const READY_SNAPSHOT = Object.freeze({
  status: 'ready',
  writable: true,
  revision: 3,
  value: Object.freeze({
    enabled: true,
    leadMinutes: 5,
    days: Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri']),
    morning: '09:00-12:00',
    afternoon: '14:00-18:00',
    model: 'flash',
  }),
  user: Object.freeze({}),
  base: Object.freeze({
    stats: Object.freeze({
      shiftedRequests: 9,
      savedEstimate: 12.34,
      currency: 'USD',
      window: 'peak',
      nextPeakAt: '',
      nextOffPeakAt: '2026-08-24T05:00:00.000Z',
      updatedAt: 1,
    }),
    agents: Object.freeze([
      Object.freeze({
        id: 'session-panel-a',
        paused: true,
        manual: false,
        reason: '',
        pausedAt: 1,
        park: 2,
        shiftedRequests: 3,
        savedEstimate: 0.4,
      }),
      Object.freeze({
        id: 'session-panel-b',
        paused: false,
        manual: false,
        reason: '',
        pausedAt: 0,
        park: 0,
        shiftedRequests: 6,
        savedEstimate: 11.94,
      }),
    ]),
  }),
});

/** A scope stub recording set/unset writes against a replaceable snapshot. */
function makeScope(initialSnapshot) {
  let snapshot = initialSnapshot;
  const listeners = new Set();
  const writes = [];
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      set(field, value) { writes.push(['set', field, value]); return Promise.resolve(); },
      unset(field) { writes.push(['unset', field]); return Promise.resolve(); },
    },
    mirror: { load() { writes.push(['describe-load']); return Promise.resolve(); } },
    writes,
    setSnapshot(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const s = suite('client');

s.test('bundle registers in factory format and exports the browser plugin shape', () => {
  const entry = loadBundleEntry();
  assert(entry.id === 'dsh-peak-shift', 'module id is the package id');
  assert(typeof entry.factory === 'function', 'lazy-CJS factory');
  const { react } = makeReactStub();
  const client = entry.factory((spec) => {
    if (spec === 'react') return react;
    throw new Error(`unexpected external require: ${spec}`);
  });
  assert(typeof client.apply === 'function', 'exports apply()');
  assert(Array.isArray(client.inject), 'exports inject list');
  for (const service of ['slots', 'locale', 'connection', 'settingsScope']) {
    assert(client.inject.includes(service), `injects ${service}`);
  }
});

s.test('apply() registers one keyed card on settings.plugin.item with dictionaries', () => {
  const entry = loadBundleEntry();
  const { react } = makeReactStub();
  const client = entry.factory((spec) => react);
  const { scope, mirror } = makeScope(READY_SNAPSHOT);
  const { ctx, registrations, localeCalls } = makeBrowserCtx(scope, mirror);
  client.apply(ctx);
  assert(registrations.length === 1, 'exactly one card registered');
  assert(registrations[0].options.key === 'peak-shift', 'card keyed on the settings namespace');
  assert(localeCalls.length === 1 && localeCalls[0].ns === 'peak-shift', 'dictionary namespace registered');
  assert([...localeCalls[0].langs].sort().join(',') === 'en,zh', 'zh + en dictionaries');
});

s.test('apply() is fail-safe when the slots service throws', () => {
  const entry = loadBundleEntry();
  const { react } = makeReactStub();
  const client = entry.factory((spec) => react);
  const { scope, mirror } = makeScope(READY_SNAPSHOT);
  const { ctx } = makeBrowserCtx(scope, mirror);
  ctx.slots.inject = () => {
    throw new Error('slot ledger missing');
  };
  client.apply(ctx); // must not throw
});

s.test('card renders collapsed, opens with stats, stages edits, and saves writes', async () => {
  const entry = loadBundleEntry();
  const reactStub = makeReactStub();
  const { react, rerenders } = reactStub;
  const client = entry.factory((spec) => react);
  const { scope, mirror, writes, setSnapshot } = makeScope(READY_SNAPSHOT);
  const { ctx, registrations } = makeBrowserCtx(scope, mirror);
  client.apply(ctx);

  const { options, component } = registrations[0];
  const props = options.inject();
  assert(typeof props.t === 'function' && typeof props.poll === 'function', 'inject provides t/actions/poll');

  let tree;
  const render = () => {
    reactStub.beginRender();
    tree = component(props);
  };
  rerenders.add(render);
  render();

  const texts = () => textsOf(tree);
  assert(tree.type === 'li', 'card root is a list item');
  assert(!texts().includes('stats.shifted'), 'collapsed: stats hidden');

  // Open the disclosure header.
  elements(tree, 'button').find((button) => textsOf(button).includes('title')).props.onClick();
  assert(texts().some((text) => text.startsWith('stats.shifted')), 'expanded: stats visible');
  assert(texts().some((text) => text.includes('12.34')), 'savings amount rendered');
  assert(texts().includes('windows.title'), 'expanded: window editors visible');

  // Staged edit: morning range becomes dirty, invalid input is flagged.
  const morningInput = () => elements(tree, 'input').find((input) => input.props.value === '09:00-12:00');
  morningInput().props.onChange({ target: { value: '07:00-07:30' } });
  assert(texts().includes('unsaved'), 'dirty chip on the header');
  const edited = elements(tree, 'input').find((input) => input.props.value === '07:00-07:30');
  assert(edited !== undefined, 'draft text renders in the control');
  edited.props.onChange({ target: { value: '99:99-99:99' } });
  assert(texts().includes('windows.invalid'), 'invalid range flagged');
  const saveButton = () => elements(tree, 'button').find((button) => textsOf(button).includes('save'));
  assert(saveButton().props.disabled === true, 'invalid draft blocks save');
  edited.props.onChange({ target: { value: '07:00-07:30' } });

  // Save: exactly the changed field is written, staged state clears.
  saveButton().props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(writes.some((write) => write[0] === 'set' && write[1] === 'morning' && write[2] === '07:00-07:30'), 'morning override written');
  assert(!writes.some((write) => write[1] === 'days'), 'unchanged fields not written');
  assert(!texts().includes('unsaved'), 'draft cleared after save');

  // Master switch writes immediately; the reset link unsets the override.
  elements(tree, 'input').find((input) => input.props.type === 'checkbox' && input.props.checked === true).props.onChange({ target: { checked: false } });
  assert(writes.some((write) => write[0] === 'set' && write[1] === 'enabled' && write[2] === false), 'switch writes enabled');

  // Price-table selector writes the model field immediately.
  assert(texts().includes('pricing.title'), 'pricing block visible');
  const modelSelect = elements(tree, 'select').find((select) => select.props.value === 'flash');
  assert(modelSelect !== undefined, 'price-table select present');
  modelSelect.props.onChange({ target: { value: 'pro' } });
  assert(writes.some((write) => write[0] === 'set' && write[1] === 'model' && write[2] === 'pro'), 'select writes the price table');

  // Agents panel: roster renders, per-agent resume writes the command channel.
  assert(texts().includes('session-panel-a'), 'paused agent listed');
  assert(texts().includes('session-panel-b'), 'active agent listed');
  assert(texts().some((text) => text.startsWith('agents.park')), 'park queue size shown for the parked agent');
  const resumeButton = elements(tree, 'button').find((button) => textsOf(button).includes('agents.resume'));
  assert(resumeButton !== undefined, 'paused agent has a resume button');
  resumeButton.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(writes.some((write) => write[0] === 'set' && write[1] === 'commands' && write[2] === 'resume:session-panel-a'), 'resume button writes the command channel');
  const resumeAllButton = elements(tree, 'button').find((button) => textsOf(button).includes('agents.resumeAll'));
  assert(resumeAllButton !== undefined, 'resume-all button present while agents are paused');
  resumeAllButton.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(writes.some((write) => write[0] === 'set' && write[1] === 'commands' && write[2] === 'resume-all'), 'resume-all writes the command channel');

  setSnapshot({ ...READY_SNAPSHOT, user: { enabled: false } });
  render();
  assert(texts().some((text) => text.includes('overridden')), 'user override marked');
  elements(tree, 'button').find((button) => textsOf(button).includes('reset')).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(writes.some((write) => write[0] === 'unset' && write[1] === 'enabled'), 'reset unsets the override');
});

s.test('card renders nothing while the namespace is unavailable; poll re-reads the mirror', async () => {
  const entry = loadBundleEntry();
  const { react } = makeReactStub();
  const client = entry.factory((spec) => react);
  const { scope, mirror, writes } = makeScope({ ...READY_SNAPSHOT, status: 'unavailable' });
  const { ctx, registrations } = makeBrowserCtx(scope, mirror);
  client.apply(ctx);
  const { options, component } = registrations[0];
  const props = options.inject();
  assert(component(props) === null, 'no trace while unavailable');

  await props.poll();
  assert(writes.some((write) => write[0] === 'describe-load'), 'poll refreshes the shared describe mirror');
});

export const run = () => s.run();
