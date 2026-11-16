// A stand-in for the Web Audio API under Node: just enough nodes for the engine's audio, recording what plays.
// Import it before anything calls audio.resume().

class Param {
  value: number;
  constructor(v = 0) {
    this.value = v;
  }
}

class Node {
  connections: Node[] = [];
  connect<T extends Node>(n: T): T {
    this.connections.push(n);
    return n;
  }
  disconnect(): void {
    this.connections = [];
  }
}

export class FakeBufferSource extends Node {
  buffer: { duration: number } | null = null;
  loop = false;
  playbackRate = new Param(1);
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  /** Simulates the end of playback. */
  finish(): void {
    this.onended?.();
  }
}

export class FakePanner extends Node {
  panningModel = '';
  distanceModel = '';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  positionX = new Param();
  positionY = new Param();
  positionZ = new Param();
  get position(): number[] {
    return [this.positionX.value, this.positionY.value, this.positionZ.value];
  }
}

class Listener {
  positionX = new Param();
  positionY = new Param();
  positionZ = new Param();
  forwardX = new Param();
  forwardY = new Param();
  forwardZ = new Param(-1);
  upX = new Param();
  upY = new Param(1);
  upZ = new Param();
}

export class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 0;
  destination = new Node();
  listener = new Listener();
  sources: FakeBufferSource[] = [];
  panners: FakePanner[] = [];
  gains: { gain: Param }[] = [];
  constructor() {
    FakeAudioContext.last = this;
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  createGain() {
    const g = Object.assign(new Node(), { gain: new Param(1) });
    this.gains.push(g);
    return g;
  }
  createDynamicsCompressor() {
    return new Node();
  }
  createPanner() {
    const p = new FakePanner();
    this.panners.push(p);
    return p;
  }
  createBufferSource() {
    const s = new FakeBufferSource();
    this.sources.push(s);
    return s;
  }
  createBuffer(channels: number, length: number, rate: number) {
    return { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, copyToChannel() {} };
  }
  /** Sources started and not stopped or finished. */
  get playing(): FakeBufferSource[] {
    return this.sources.filter((s) => s.started && !s.stopped);
  }
}

Object.assign(globalThis, { AudioContext: FakeAudioContext });
