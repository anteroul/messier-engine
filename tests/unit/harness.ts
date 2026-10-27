// Minimal assertion helpers shared by the unit tests. Each file prints PASS/FAIL lines and exits non-zero on failure.
let failures = 0;
let passes = 0;

export function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
  if (ok) passes++;
  else failures++;
}

/** Checks two values are equal by JSON; prints both on failure. */
export function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? '' : `got ${a}, expected ${e}`);
}

export function near(name: string, actual: ArrayLike<number> | number, expected: ArrayLike<number> | number, eps = 1e-5): void {
  const a = typeof actual === 'number' ? [actual] : Array.from(actual);
  const e = typeof expected === 'number' ? [expected] : Array.from(expected);
  const ok = a.length === e.length && a.every((v, i) => Math.abs(v - e[i]) <= eps);
  check(name, ok, ok ? '' : `got [${a.map((v) => v.toFixed(5))}], expected [${e.map((v) => v.toFixed(5))}]`);
}

export function throws(name: string, fn: () => unknown, pattern?: RegExp): void {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (err) {
    const msg = (err as Error).message;
    check(name, !pattern || pattern.test(msg), msg);
  }
}

process.on('exit', () => {
  console.log(failures ? `${failures} FAILURE(S), ${passes} passed` : `ALL ${passes} PASSED`);
  if (failures) process.exitCode = 1;
});
