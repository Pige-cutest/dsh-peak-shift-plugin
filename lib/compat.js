/**
 * @module dsh-peak-shift/compat
 * Runtime compatibility shims between the two dsh settings generations.
 *
 * dsh changed its plugin-settings model twice:
 *
 * - **Legacy (≤ 0.1.1-rc.2)** — `@deepseek-ai/dsh-settings` exports
 *   `installSettingsSection(ctx, ns, schema, base, hooks)`, which owns a
 *   user-editable section of `$DSH_HOME/settings.yaml` and hands the plugin a
 *   resolved snapshot.
 * - **Modern (≥ 0.1.7-rc.2, incl. 0.2.x)** — no such export. A plugin marks
 *   fields of its own `Config` schema with `.volatile()`; the `settings`
 *   service (`SettingsForms`) projects them into a form keyed by the plugin's
 *   *profile entry id*, persists edits into the active profile's Cordis patch,
 *   and emits `settings/document-updated` when an entry changes.
 * - **Gap (0.1.2 – 0.1.6)** — neither API exists. The gate still runs from the
 *   composition config; only the settings UI is unavailable.
 *
 * Everything here is feature-detected so one codebase runs on all of them.
 * Nothing may be imported statically from `@deepseek-ai/dsh-settings` by name:
 * a missing named export is an ESM link-time error that would take the whole
 * plugin down on modern dsh.
 */

/**
 * Wrap a schemastery field as volatile when the installed schemastery supports
 * it (≥ 3.18.4, i.e. dsh ≥ 0.1.7-rc.2). On older schemastery the field is
 * returned untouched so the same Config literal still builds.
 *
 * Careful: a schemastery schema is a *callable* object (`typeof schema ===
 * 'function'`), so a plain `typeof x === 'object'` guard would silently skip
 * every real field. Only the presence of the method is checked.
 * @param {object} schema - a schemastery schema node.
 * @returns {object} the volatile field, or the original node.
 */
export function volatileField(schema) {
  if (schema === null || schema === undefined) return schema;
  if (typeof schema.volatile !== 'function') return schema;
  try {
    return schema.volatile();
  } catch {
    // Already wrapped (or an unsupported layout): keep the plain field.
    return schema;
  }
}

/**
 * Whether a value is a schemastery/cosmokit volatile reference.
 *
 * `createVolatile` returns a frozen `{ get, [write] }` handle; the write symbol
 * is internal, so this recognizes the shape rather than importing a symbol that
 * may not exist on older cosmokit.
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether the value is a volatile reference.
 */
export function isVolatileRef(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.get === 'function' &&
    Object.isFrozen(value)
  );
}

/**
 * Recursively replace volatile references with their snapshots, so callers can
 * read plain data from a resolved config regardless of the settings generation.
 * @param {unknown} value - value from a parsed plugin config.
 * @returns {unknown} the same shape with volatile references unwrapped.
 */
export function unwrapDeep(value) {
  if (isVolatileRef(value)) return unwrapDeep(value.get());
  if (Array.isArray(value)) return value.map(unwrapDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = unwrapDeep(child);
    return out;
  }
  return value;
}

/**
 * Read a service by name without failing when the deployment does not provide
 * it. `ctx.get` throws for an unknown service in some versions and returns
 * `undefined` in others.
 * @param {object} ctx - a cordis context.
 * @param {string} serviceName - service to look up.
 * @returns {object|undefined} the service, or undefined.
 */
export function optionalService(ctx, serviceName) {
  try {
    return ctx.get(serviceName);
  } catch {
    return undefined;
  }
}

/**
 * Whether a `settings` service is the modern `SettingsForms` implementation.
 *
 * `SettingsForms` is identified by its describe/configure surface; the legacy
 * service has neither.
 * @param {object|undefined} settings - the resolved `settings` service.
 * @returns {boolean} whether the modern API is available.
 */
export function isModernSettings(settings) {
  return (
    settings !== undefined &&
    settings !== null &&
    typeof settings.describe === 'function' &&
    typeof settings.configure === 'function'
  );
}

/**
 * Resolve this plugin's settings namespace.
 *
 * The modern API keys a form by the plugin's *profile entry id* (the `id` in
 * `cordis.patch.yml`, `peak-shift` by default). The composition config may pin
 * it explicitly; otherwise the loader's own entry id is used, falling back to
 * the shipped default.
 * @param {object} ctx - the plugin's cordis context.
 * @param {object} config - validated plugin config.
 * @returns {string} the settings namespace / profile entry id.
 */
export function resolveNamespace(ctx, config) {
  const explicit = typeof config?.settingsNamespace === 'string' ? config.settingsNamespace.trim() : '';
  if (explicit !== '') return explicit;
  try {
    const id = ctx?.fiber?.entry?.options?.id;
    if (typeof id === 'string' && id !== '') return id;
  } catch {
    /* fiber internals are not guaranteed across versions */
  }
  return 'peak-shift';
}
