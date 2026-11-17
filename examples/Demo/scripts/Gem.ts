import { AudioSource, GameObject, Script, audio, vec3, type Scene, type Vec3 } from 'messier';

/** Spins and bobs; the player picks it up by touching it, which scores and bursts into sparks. */
export default class Gem extends Script {
  points = 1;
  /** Degrees per second. */
  spin = 120;
  pickupRadius = 0.8;
  sparks = 12;
  private home: Vec3 = [0, 0, 0];
  private age = 0;

  awake(): void {
    this.object.addToGroup('gems');
    // Before the first render, which comes before start(). Grows in from here; not 0, which has no inverse.
    this.transform.scale = [0.01, 0.01, 0.01];
  }

  start(): void {
    this.home = vec3.clone(this.transform.position); // set by the spawner after instantiate()
    this.age = Math.random() * 10; // so gems don't bob in step
  }

  update(dt: number): void {
    this.age += dt;
    const grow = Math.min(1, this.transform.scale[0] + dt * 4);
    this.transform.scale = [grow, grow, grow];
    this.transform.setEulerDeg(20, this.age * this.spin, 0);
    this.transform.position = [this.home[0], this.home[1] + Math.sin(this.age * 2.5) * 0.15, this.home[2]];

    const player = this.scene.getGroup('player')[0];
    if (player && vec3.distance(player.transform.worldPosition, this.transform.worldPosition) < this.pickupRadius) this.collect();
  }

  collect(): void {
    findScript<GameApi>(this.scene, 'GameManager')?.addPoints(this.points);
    // Played by the audio system, not a source on this gem: the gem is destroyed, which would cut its sounds off.
    const chime = this.scene.findByName('Gem Sound')?.getComponent(AudioSource);
    if (chime?.clip) audio.play(chime.clip, { volume: chime.volume, pitch: 0.9 + Math.random() * 0.25 });
    const template = this.find('Spark Template');
    for (let i = 0; template && i < this.sparks; i++) {
      const spark = GameObject.instantiate(template);
      spark.name = 'Spark';
      spark.transform.worldPosition = this.transform.worldPosition;
      const a = (i / this.sparks) * Math.PI * 2;
      const fx = findScript<SparkApi>(spark, 'Spark');
      fx?.launch([Math.cos(a) * 3, 3 + Math.random() * 2, Math.sin(a) * 3]);
    }
    // Deferred: this update finishes, then the gem is torn down at the end of the frame.
    GameObject.destroy(this.object);
  }
}

interface GameApi {
  addPoints(n: number): void;
}

interface SparkApi {
  launch(velocity: Vec3): void;
}

/** A script by name, on an object or anywhere live in a scene. */
function findScript<T>(where: Scene | GameObject, name: string): T | null {
  const scripts = where instanceof GameObject ? where.getComponents(Script) : where.query(Script);
  return (scripts.find((s) => s.typeName === name) as unknown as T | undefined) ?? null;
}
