import { Component } from './component';
import type { Material } from './material';
import type { Mesh } from './mesh';

/** Draws a mesh with a material at its object's transform. Needs both to draw. */
export class MeshRenderer extends Component {
  mesh: Mesh | null = null;
  material: Material | null = null;
  castShadows = true;

  /** Shares the mesh and copies the material, so per-object material edits stay per object. */
  clone(): MeshRenderer {
    const r = new MeshRenderer();
    r.mesh = this.mesh;
    r.material = this.material?.clone() ?? null;
    r.castShadows = this.castShadows;
    r.enabled = this.enabled;
    return r;
  }
}
