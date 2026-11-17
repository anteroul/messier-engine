import { Script, input, sceneManager } from 'messier';

/** Backspace goes back to the menu scene, when the build (or the project being played) has one. */
export default class ArcadeLink extends Script {
  update(): void {
    if (!input.pressed('Backspace')) return;
    for (let i = 0; i < sceneManager.sceneCount; i++) {
      if (sceneManager.sceneName(i) === 'Arcade') void sceneManager.loadScene(i);
    }
  }
}
