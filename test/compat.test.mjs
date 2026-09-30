/**
 * Compatibility-shim tests: the helpers that let one host half serve both dsh
 * settings generations (legacy `installSettingsSection` and modern volatile
 * Config forms). These import `lib/compat.js` directly, so they need no
 * `@deepseek-ai/*` resolution.
 */

import { suite, assert } from './helpers.mjs';
import {
  isModernSettings,
  isVolatileRef,
  optionalService,
  resolveNamespace,
  unwrapDeep,
  volatileField,
} from '../lib/compat.js';

const s = suite('compat');

s.test('volatileField marks a schemastery field when supported and is a no-op otherwise', () => {
  let marked = false;
  const modernField = {
    volatile() {
      marked = true;
      return { wrapped: true };
    },
  };
  assert(volatileField(modernField) !== undefined, 'modern field is wrapped');
  assert(marked === true, 'volatile() was called');

  // Regression: a schemastery schema is a CALLABLE object, so an
  // `typeof x === 'object'` guard would skip every real field.
  let callableMarked = false;
  const callableField = function schemaLike() {};
  callableField.volatile = () => {
    callableMarked = true;
    return callableField;
  };
  assert(typeof callableField === 'function', 'the fixture really is a function');
  volatileField(callableField);
  assert(callableMarked === true, 'callable (schemastery) fields are wrapped too');

  // dsh ≤ 0.1.1-rc.2 ships schemastery 3.18.1, which has no volatile().
  const legacyField = { type: 'boolean' };
  assert(volatileField(legacyField) === legacyField, 'legacy field passes through untouched');
  const legacyCallable = function legacySchemaLike() {};
  assert(volatileField(legacyCallable) === legacyCallable, 'callable without volatile() passes through');

  // Defensive: a volatile() that throws must not take the Config literal down.
  const hostile = { volatile() { throw new TypeError('volatile schema is already wrapped'); } };
  assert(volatileField(hostile) === hostile, 'throwing volatile() falls back to the plain field');

  assert(volatileField(undefined) === undefined, 'undefined passes through');
  assert(volatileField(null) === null, 'null passes through');
});

s.test('isVolatileRef recognizes the frozen cosmokit handle only', () => {
  assert(isVolatileRef(Object.freeze({ get: () => 1 })) === true, 'frozen handle detected');
  assert(isVolatileRef({ get: () => 1 }) === false, 'a mutable getter bag is not a handle');
  assert(isVolatileRef(Object.freeze({ value: 1 })) === false, 'frozen plain object rejected');
  assert(isVolatileRef(null) === false, 'null rejected');
  assert(isVolatileRef(undefined) === false, 'undefined rejected');
  assert(isVolatileRef('x') === false, 'string rejected');
});

s.test('unwrapDeep replaces volatile handles at any depth', () => {
  const handle = (value) => Object.freeze({ get: () => value });
  const config = {
    enabled: handle(true),
    leadMinutes: 5,
    windows: handle({ zone: 'Asia/Shanghai', peak: [{ days: ['mon'], ranges: ['09:00-12:00'] }] }),
    pricing: handle({ model: 'flash', currency: 'CNY' }),
    list: [handle('a'), { nested: handle('b') }],
  };
  const plain = unwrapDeep(config);
  assert(plain.enabled === true, 'top-level handle unwrapped');
  assert(plain.windows.peak[0].ranges[0] === '09:00-12:00', 'nested handle unwrapped');
  assert(plain.pricing.model === 'flash', 'handle object unwrapped');
  assert(plain.list[0] === 'a' && plain.list[1].nested === 'b', 'inside arrays too');
  assert(plain.leadMinutes === 5, 'plain scalars untouched');
});

s.test('optionalService swallows a throwing ctx.get', () => {
  assert(optionalService({ get: () => undefined }, 'settings') === undefined, 'undefined service');
  assert(optionalService({ get: () => ({ ok: true }) }, 'settings').ok === true, 'returns the service');
  assert(optionalService({ get() { throw new Error('unknown service'); } }, 'nope') === undefined, 'throw swallowed');
  assert(optionalService({}, 'nope') === undefined, 'missing get() is tolerated');
});

s.test('isModernSettings requires the SettingsForms surface', () => {
  assert(isModernSettings({ describe() {}, configure() {} }) === true, 'describe + configure = modern');
  assert(isModernSettings({ describe() {} }) === false, 'describe alone is not enough');
  assert(isModernSettings({ configure() {} }) === false, 'configure alone is not enough');
  // The legacy namespace service has update/register but neither method.
  assert(isModernSettings({ writable: true, update() {}, register() {} }) === false, 'legacy service rejected');
  assert(isModernSettings(undefined) === false, 'absent service rejected');
});

s.test('resolveNamespace prefers explicit config, then the loader entry id, then the default', () => {
  assert(resolveNamespace({}, { settingsNamespace: 'renamed' }) === 'renamed', 'explicit config wins');
  assert(resolveNamespace({}, { settingsNamespace: '  ' }) === 'peak-shift', 'blank config ignored');
  const fiberCtx = { fiber: { entry: { options: { id: 'from-loader' } } } };
  assert(resolveNamespace(fiberCtx, {}) === 'from-loader', 'loader entry id used when config is blank');
  assert(resolveNamespace(fiberCtx, { settingsNamespace: 'explicit' }) === 'explicit', 'config still wins');
  assert(resolveNamespace({}, {}) === 'peak-shift', 'default fallback');
  assert(resolveNamespace({ fiber: { entry: { options: {} } } }, {}) === 'peak-shift', 'empty entry id falls back');
  assert(resolveNamespace({ get fiber() { throw new Error('no fiber'); } }, {}) === 'peak-shift', 'throwing fiber access tolerated');
});

export const run = () => s.run();
