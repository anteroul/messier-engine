import { check, eq, near, throws } from './harness';
import { Clock } from '@root/src/engine/time.ts';

// ---- step counts for various frame times at 60 Hz
{
  const c = new Clock();
  eq('default rate is 60 Hz', c.fixedRate, 60);
  const counts = [1 / 60, 1 / 120, 1 / 120, 1 / 30, 0.004, 0.004, 0.004, 0.004].map((dt) => c.beginFrame(dt));
  eq('steps per frame', counts, [1, 0, 1, 2, 0, 0, 0, 0]);
  near('alpha is the leftover fraction', c.alpha, 0.016 * 60, 1e-6);
  eq('the frame that crosses the step runs it', c.beginFrame(0.004), 1);
  check('frameCount and time advance', c.frameCount === 9 && Math.abs(c.time - (1 / 60 + 1 / 60 + 1 / 30 + 0.02)) < 1e-9);
}

// ---- floating point: three 1/180 frames make exactly one step
{
  const c = new Clock();
  c.fixedRate = 60;
  const n = c.beginFrame(1 / 180) + c.beginFrame(1 / 180) + c.beginFrame(1 / 180);
  eq('accumulated thirds make one step', n, 1);
  check('alpha near zero after an exact step', c.alpha < 1e-6, String(c.alpha));
}

// ---- substep cap (spiral of death)
{
  const c = new Clock();
  c.maxSubsteps = 4;
  eq('a 1 s hitch runs only maxSubsteps', c.beginFrame(1), 4);
  check('backlog dropped, fraction kept', c.alpha >= 0 && c.alpha < 1, String(c.alpha));
  eq('next normal frame is back to one step', c.beginFrame(1 / 60), 1);
}

// ---- configurable rate, timeScale, fixedTime
{
  const c = new Clock();
  c.fixedRate = 50;
  near('fixedDeltaTime follows rate', c.fixedDeltaTime, 0.02);
  eq('50 Hz at 0.1 s frame', c.beginFrame(0.1), 5);
  for (let i = 0; i < 5; i++) c.fixedStepDone();
  near('fixedTime counts the steps run', c.fixedTime, 0.1);

  c.reset();
  c.timeScale = 0.5;
  eq('timeScale slows fixed steps', c.beginFrame(0.04), 1);
  near('deltaTime is scaled', c.deltaTime, 0.02);
  near('unscaledDeltaTime is not', c.unscaledDeltaTime, 0.04);
  c.timeScale = 0;
  eq('timeScale 0 pauses fixed steps', c.beginFrame(1), 0);
  near('unscaled time keeps running', c.unscaledTime, 1.04);

  throws('rejects a zero step', () => (c.fixedDeltaTime = 0), /positive/);
  c.reset();
  check('reset zeroes counters', c.time === 0 && c.frameCount === 0 && c.alpha === 0 && c.fixedTime === 0);
}
