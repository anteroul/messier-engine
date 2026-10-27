import { check, eq } from './harness';
import { Signal } from '@root/src/engine/signal.ts';

// ---- typed args, connect, disconnect
{
  const hit = new Signal<[damage: number, source: string]>();
  const seen: string[] = [];
  const onHit = (d: number, s: string) => seen.push(`${s}:${d}`);
  hit.connect(onHit);
  hit.emit(3, 'spike');
  hit.emit(5, 'bat');
  eq('listener gets typed args in order', seen, ['spike:3', 'bat:5']);
  check('disconnect reports a connection', hit.disconnect(onHit) && !hit.disconnect(onHit));
  hit.emit(1, 'x');
  eq('disconnected listener not called', seen.length, 2);

  const dispose = hit.connect(onHit);
  dispose();
  hit.emit(1, 'y');
  check('connect() returns a disposer', seen.length === 2 && hit.connectionCount === 0);
}

// ---- once
{
  const s = new Signal<[number]>();
  const got: number[] = [];
  s.once((n) => got.push(n));
  s.emit(1);
  s.emit(2);
  eq('once fires a single time', got, [1]);
  check('once connection is gone afterwards', s.connectionCount === 0);
}

// ---- changes during emit
{
  const s = new Signal();
  const order: string[] = [];
  const b = () => order.push('b');
  const late = () => order.push('late');
  s.connect(() => {
    order.push('a');
    s.disconnect(b);
    s.connect(late);
  });
  s.connect(b);
  s.emit();
  eq('disconnect during emit skips; connect waits for next emit', order, ['a']);
  order.length = 0;
  s.emit();
  eq('next emit sees the new listener', order, ['a', 'late']);

  // Re-entrant emit.
  const r = new Signal<[number]>();
  const depth: number[] = [];
  r.connect((n) => {
    depth.push(n);
    if (n < 3) r.emit(n + 1);
  });
  r.emit(1);
  eq('re-entrant emit', depth, [1, 2, 3]);

  // A throwing listener doesn't leave the signal stuck in "emitting" mode.
  const t = new Signal();
  const boom = () => {
    throw new Error('boom');
  };
  t.connect(boom);
  try {
    t.emit();
  } catch {
    /* expected */
  }
  t.disconnect(boom);
  check('signal recovers after a listener throws', t.connectionCount === 0);
}

// ---- owner auto-disconnect
{
  const a = new Signal<[number]>();
  const b = new Signal();
  const owner = {};
  const other = {};
  let calls = 0;
  a.connect(() => calls++, owner);
  b.connect(() => calls++, owner);
  a.connect(() => calls++, other);
  Signal.disconnectOwner(owner);
  a.emit(1);
  b.emit();
  check('disconnectOwner drops every connection of that owner only', calls === 1 && a.connectionCount === 1 && b.connectionCount === 0, `calls=${calls}`);

  // Disconnecting an owner from inside an emit.
  const c = new Signal();
  const o2 = {};
  const log: string[] = [];
  c.connect(() => {
    log.push('first');
    Signal.disconnectOwner(o2);
  });
  c.connect(() => log.push('owned'), o2);
  c.emit();
  eq('owner disconnected mid-emit is skipped', log, ['first']);
}

// ---- await next()
{
  const ready = new Signal<[string, number]>();
  const p = ready.next();
  ready.emit('go', 7);
  ready.emit('again', 8);
  const [word, n] = await p;
  check('next() resolves with the first emit args', word === 'go' && n === 7 && ready.connectionCount === 0);

  const owner = {};
  let resolved = false;
  void ready.next(owner).then(() => (resolved = true));
  Signal.disconnectOwner(owner);
  ready.emit('late', 0);
  await Promise.resolve();
  check('next() with a destroyed owner never resolves', !resolved && ready.connectionCount === 0);
}
