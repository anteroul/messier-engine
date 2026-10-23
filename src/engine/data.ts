// Helpers for reading saved data defensively. Saved files can come from older
// or newer versions (or be hand-edited), so unknown keys are ignored and values
// of the wrong type keep the target's default.

export type Json = Record<string, unknown>;

export function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Copies `keys` from `src` onto `target` when the value has the same type as the target's current one (numbers must be finite). */
export function assignKnown<T extends object>(target: T, src: unknown, keys: readonly (keyof T & string)[]): T {
  if (!isObject(src)) return target;
  const t = target as Record<string, unknown>;
  for (const k of keys) {
    const cur = t[k], v = src[k];
    if (Array.isArray(cur)) {
      if (Array.isArray(v) && v.length === cur.length && v.every((x) => typeof x === 'number' && Number.isFinite(x))) t[k] = [...v];
    } else if (typeof v === typeof cur && (typeof v !== 'number' || Number.isFinite(v))) {
      t[k] = v;
    }
  }
  return target;
}

/** Plain-data copy of `keys` (arrays are copied). */
export function pickData<T extends object>(src: T, keys: readonly (keyof T & string)[]): Json {
  const out: Json = {};
  const s = src as Record<string, unknown>;
  for (const k of keys) out[k] = Array.isArray(s[k]) ? [...(s[k] as unknown[])] : s[k];
  return out;
}
