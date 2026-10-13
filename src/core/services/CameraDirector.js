import * as THREE from 'three';

// The ONLY thing that should move the camera on purpose.
// Cutscenes and flythroughs call this instead of touching OrbitControls.
export class CameraDirector {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.tween = null;
  }

  lockControls() { this.controls.enabled = false; }
  unlockControls() { this.controls.enabled = true; }

  /** Smoothly move the camera. pos/look are [x, y, z]. Resolves when done. */
  flyTo(pos, look, duration = 2) {
    return new Promise((resolve) => {
      this.tween = {
        fromPos: this.camera.position.clone(),
        toPos: new THREE.Vector3(...pos),
        fromLook: this.controls.target.clone(),
        toLook: new THREE.Vector3(...look),
        t: 0,
        duration: Math.max(duration, 0.001),
        restore: this.controls.enabled, // give controls back as we found them
        resolve,
      };
      this.lockControls();
    });
  }

  update(delta) {
    const tw = this.tween;
    if (!tw) return;
    tw.t += delta;
    const k = Math.min(tw.t / tw.duration, 1);
    const e = k * k * (3 - 2 * k); // smoothstep
    this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
    this.controls.target.lerpVectors(tw.fromLook, tw.toLook, e);
    if (k >= 1) {
      this.tween = null;
      this.controls.enabled = tw.restore;
      tw.resolve();
    }
  }
}