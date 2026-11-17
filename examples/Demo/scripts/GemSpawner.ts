import { GameObject, Script, raycastScene, vec3, type Scene, type Signal, type Vec3 } from 'messier';

/** Keeps a few gems on the field by cloning a hidden template, and clears them when the round is won. */
export default class GemSpawner extends Script {
  maxGems = 4;
  /** Seconds between spawns. */
  interval = 1;
  /** Half size of the square gems appear in. */
  area = 7;
  /** Gems don't appear closer than this to the player. */
  minDistance = 3;
  private template: GameObject | null = null;
  private timer = 0;

  start(): void {
    this.template = this.find('Gem Template');
    const game = findScript<GameApi>(this.scene, 'GameManager');
    game?.won.connect(() => {
      this.enabled = false;
      // getGroup() is live: iterate a copy, as gems leave it when destroy() detaches them.
      for (const gem of [...this.scene.getGroup('gems')]) GameObject.destroy(gem);
    }, this);
    game?.restarted.connect(() => (this.enabled = true), this);
  }

  onEnable(): void {
    this.timer = this.interval;
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0 || !this.template || this.scene.getGroup('gems').length >= this.maxGems) return;
    this.timer = this.interval;
    // The template sits under an inactive parent; the copy goes to the top level, where it is active.
    const gem = GameObject.instantiate(this.template);
    gem.name = 'Gem';
    gem.transform.worldPosition = this.randomSpot();
  }

  private randomSpot(): Vec3 {
    const player = this.scene.getGroup('player')[0];
    let spot: Vec3 = [0, 0, 0];
    for (let i = 0; i < 20; i++) {
      spot = [(Math.random() * 2 - 1) * this.area, 0.7, (Math.random() * 2 - 1) * this.area];
      if (player && vec3.distance(spot, player.transform.worldPosition) < this.minDistance) continue;
      // Only on open floor: look straight down for what's below the spot.
      const hit = raycastScene(this.scene, { origin: [spot[0], 5, spot[2]], dir: [0, -1, 0] });
      if (hit?.object.name === 'Floor') break;
    }
    return spot;
  }
}

interface GameApi {
  won: Signal<[]>;
  restarted: Signal<[]>;
}

function findScript<T>(scene: Scene, name: string): T | null {
  return (scene.query(Script).find((s) => s.typeName === name) as unknown as T | undefined) ?? null;
}
