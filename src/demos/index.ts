import type { Scene } from '../engine';
import { buildArcade } from './arcade';
import { buildNeonRun } from './neonRun';
import { ARCADE_SCENE } from './shared';
import { buildStarfall } from './starfall';
import { buildTopple } from './topple';

export interface DemoGame {
  /** Scene name in the demo project. */
  readonly name: string;
  build(scene: Scene): void;
}

/** The showcase scenes, in the order they're listed in the demo project: the menu, then the games. */
export const DEMO_GAMES: readonly DemoGame[] = [
  { name: ARCADE_SCENE, build: buildArcade },
  { name: 'Neon Run', build: buildNeonRun },
  { name: 'Topple', build: buildTopple },
  { name: 'Starfall', build: buildStarfall },
];
