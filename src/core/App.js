import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EventBus } from './EventBus.js';
import { State } from './State.js';
import { ModuleManager } from './ModuleManager.js';
import { PhaseManager } from './PhaseManager.js';
import { CameraDirector } from './services/CameraDirector.js';
import { CONFIG, QUALITY } from './config.js';

export class App {
  constructor(container = document.body) {
    const q = QUALITY[CONFIG.quality];

    this.bus = new EventBus();
    this.state = new State(this.bus);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d12);

    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 10, 500000);
    this.camera.position.set(0, 2000, 45000); this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: q.antialias });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.domElement.id = 'three-canvas';
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    // default lights; the sun module will take over the sun later
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const sun = new THREE.DirectionalLight(0xffe2c0, 2.0);
    sun.position.set(150, 200, 100);
    this.scene.add(sun);

    this.services = { camera: new CameraDirector(this.camera, this.controls) };
    this.phases = new PhaseManager(this.bus);

    // the toolbox every module receives
    this.ctx = {
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      controls: this.controls,
      bus: this.bus,
      state: this.state,
      services: this.services,
      lights: { sun },
      config: CONFIG,
    };
    this.modules = new ModuleManager(this.ctx);

    this.clock = new THREE.Clock();
    addEventListener('resize', () => this.onResize());
  }

  start() {
    this.renderer.setAnimationLoop(() => {
      const dt = Math.min(this.clock.getDelta(), 0.1); // cap big jumps (tab switches, lag)
      this.services.camera.update(dt);
      this.controls.update();
      this.modules.update(dt, this.clock.elapsedTime);
      this.renderer.render(this.scene, this.camera);
    });
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }
}
