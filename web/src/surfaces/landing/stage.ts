import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * The landing film's 3D stage: a silver studio with one door.
 * Requests travel up a lane to the door. Hostile ones stop at the threshold (or at the wall, or are
 * pulled back after measuring); honest ones split onto two tracks beyond it: a wide silver track
 * for proven payees and a thin marigold one for strangers, whose budget runs out.
 * Plain three.js, no framework. The page drives it with setScroll(p) and setMode(mode).
 */

export type Mode = 'hero' | 'open' | 'rise' | 'sidedoor' | 'measure' | 'tracks' | 'bound' | 'trace' | 'ledger';
export type Stage = { setScroll(p: number): void; setMode(m: Mode): void; resize(): void; dispose(): void };

type V3 = [number, number, number];
type Shot = { pos: V3; look: V3; fov: number };

/** One camera shot per chapter, in page order. */
const SHOTS: Shot[] = [
  { pos: [-7.5, 2.4, -15], look: [-1.2, 2.9, 0], fov: 38 }, // hero
  { pos: [11, 9, -17], look: [0, 0.6, 7], fov: 42 }, // prologue: no door
  { pos: [3.8, 1.3, -11.5], look: [0, 2.9, 0], fov: 42 }, // I: the door rises
  { pos: [-15, 5.2, -9], look: [0, 1.2, 0.5], fov: 40 }, // II: one door, the wall
  { pos: [4.8, 2, -5.8], look: [0, 1.2, 0.6], fov: 44 }, // III: measured at the threshold
  { pos: [-0.4, 9.5, -2.2], look: [0, 0, 13], fov: 50 }, // IV: two tracks, from above the door
  { pos: [0.01, 36, 7], look: [0, 0, 7], fov: 38 }, // V: plan view, the bound
  { pos: [9, 3.6, 24], look: [-2.5, 0.6, 9], fov: 42 }, // VI: TRACE, downstream
  { pos: [0, 17, -30], look: [0, 0, 2], fov: 36 }, // epilogue
];

const C = {
  silver: new THREE.Color('#e9e8ee'),
  rose: new THREE.Color('#eedfe0'),
  floor: new THREE.Color('#e2e1e8'),
  grid: new THREE.Color('#cfccd8'),
  gridMajor: new THREE.Color('#b9b2c4'),
  metal: new THREE.Color('#ececf2'),
  aub: new THREE.Color('#4f1f46'),
  aubLight: new THREE.Color('#7a3a6d'),
  mari: new THREE.Color('#efb03a'),
  loss: new THREE.Color('#b5432f'),
  honest: new THREE.Color('#f7f7fa'),
  provenTrack: new THREE.Color('#c4c3cd'),
};

type Kind = 'honest' | 'hostile';
type Route = 'proven' | 'explore' | 'refuse' | 'wall' | 'revert' | 'free';
type Token = {
  live: boolean;
  kind: Kind;
  route: Route | null;
  x: number;
  z: number;
  y: number;
  vx: number;
  speed: number;
  size: number;
  age: number;
  fade: number; // 1 = solid, 0 = gone
  graduate: boolean;
  phase: number; // per-route progress
  color: THREE.Color;
};

const MAX = 240;
const LANE_START = -46;
const THRESHOLD_Z = -0.45;

function ribbon(curve: THREE.Curve<THREE.Vector3>, width: number, segments = 120): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPoint(t);
    const tan = curve.getTangent(t);
    const side = new THREE.Vector3().crossVectors(up, tan).normalize().multiplyScalar(width / 2);
    pos.push(p.x - side.x, p.y + 0.012, p.z - side.z, p.x + side.x, p.y + 0.012, p.z + side.z);
    if (i < segments) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export function createStage(canvas: HTMLCanvasElement, opts: { reduced: boolean }): Stage | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const bg = C.silver.clone();
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 16, 66);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);

  // Light: a soft studio key from above-front, a cool sky fill, and the marigold threshold glow.
  scene.add(new THREE.HemisphereLight('#ffffff', '#d9d6e0', 1.1));
  const key = new THREE.DirectionalLight('#ffffff', 2.2);
  key.position.set(-8, 16, -10);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -14;
  key.shadow.camera.right = 14;
  key.shadow.camera.top = 14;
  key.shadow.camera.bottom = -14;
  key.shadow.bias = -0.0004;
  key.shadow.radius = 6;
  scene.add(key);
  const glow = new THREE.PointLight(C.mari, 6, 7, 1.6);
  glow.position.set(0, 0.6, 0);
  scene.add(glow);

  // Floor and the ledger grid.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: C.floor, roughness: 0.92 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(400, 400, C.grid, C.grid);
  (grid.material as THREE.LineBasicMaterial).transparent = true;
  (grid.material as THREE.LineBasicMaterial).opacity = 0.55;
  grid.position.y = 0.003;
  scene.add(grid);
  const gridMajor = new THREE.GridHelper(400, 40, C.gridMajor, C.gridMajor);
  (gridMajor.material as THREE.LineBasicMaterial).transparent = true;
  (gridMajor.material as THREE.LineBasicMaterial).opacity = 0.6;
  gridMajor.position.y = 0.004;
  scene.add(gridMajor);

  // The lane up to the door.
  const laneMat = new THREE.MeshBasicMaterial({ color: C.gridMajor });
  for (const x of [-1.35, 1.35]) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.01, 60), laneMat);
    edge.position.set(x, 0.008, -30);
    scene.add(edge);
  }

  // The door.
  const door = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: C.metal, metalness: 1, roughness: 0.16, envMapIntensity: 1.35 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: '#bdbcc6', metalness: 1, roughness: 0.35 });
  const pillarGeo = new THREE.BoxGeometry(0.5, 6, 0.62);
  for (const x of [-1.62, 1.62]) {
    const p = new THREE.Mesh(pillarGeo, metal);
    p.position.set(x, 3, 0);
    p.castShadow = true;
    door.add(p);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.74, 0.5, 0.62), metal);
  lintel.position.set(0, 6.25, 0);
  lintel.castShadow = true;
  door.add(lintel);
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.14, 1.5), darkMetal);
  plinth.position.set(0, 0.07, 0);
  plinth.receiveShadow = true;
  door.add(plinth);
  const thresholdMat = new THREE.MeshStandardMaterial({ color: C.mari, emissive: C.mari, emissiveIntensity: 1.6, roughness: 0.4 });
  const threshold = new THREE.Mesh(new THREE.BoxGeometry(2.74, 0.05, 0.12), thresholdMat);
  threshold.position.set(0, 0.165, -0.1);
  door.add(threshold);
  const fieldMat = new THREE.MeshBasicMaterial({ color: C.aub, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const field = new THREE.Mesh(new THREE.PlaneGeometry(2.74, 6), fieldMat);
  field.position.set(0, 3.14, -0.05);
  door.add(field);
  scene.add(door);

  // The wall: no side doors. Faint until chapter II, flashes when something hits it.
  const wallMat = new THREE.MeshBasicMaterial({ color: C.aub, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const wallEdgeMat = new THREE.MeshBasicMaterial({ color: C.aub, transparent: true, opacity: 0 });
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(30, 2.4), wallMat);
    w.position.set(s * (1.87 + 15), 1.2, 0);
    scene.add(w);
    const e = new THREE.Mesh(new THREE.BoxGeometry(30, 0.03, 0.03), wallEdgeMat);
    e.position.set(s * (1.87 + 15), 2.4, 0);
    scene.add(e);
  }

  // Two tracks beyond the door.
  const provenCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0.8),
    new THREE.Vector3(-1.2, 0, 6),
    new THREE.Vector3(-5.5, 0, 16),
    new THREE.Vector3(-9, 0, 44),
  ]);
  const exploreCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0.8),
    new THREE.Vector3(1.4, 0, 6),
    new THREE.Vector3(5.5, 0, 16),
    new THREE.Vector3(9, 0, 44),
  ]);
  const provenMesh = new THREE.Mesh(
    ribbon(provenCurve, 1.7),
    new THREE.MeshStandardMaterial({ color: C.provenTrack, metalness: 0.7, roughness: 0.3, side: THREE.DoubleSide }),
  );
  provenMesh.receiveShadow = true;
  scene.add(provenMesh);
  const exploreMat = new THREE.MeshStandardMaterial({ color: C.mari, emissive: C.mari, emissiveIntensity: 0.45, roughness: 0.5, side: THREE.DoubleSide });
  scene.add(new THREE.Mesh(ribbon(exploreCurve, 0.36), exploreMat));
  // The graduation gate on the explore track (chapter VI): strangers who keep delivering become proven.
  const gate = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.05, 12, 48), metal);
  const gatePos = exploreCurve.getPoint(0.42);
  gate.position.set(gatePos.x, 0.75, gatePos.z);
  gate.rotation.y = Math.atan2(exploreCurve.getTangent(0.42).x, exploreCurve.getTangent(0.42).z);
  scene.add(gate);

  // Requests.
  const tokenGeo = new THREE.BoxGeometry(0.42, 0.26, 0.62);
  const tokenMat = new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.32 });
  const tokens = new THREE.InstancedMesh(tokenGeo, tokenMat, MAX);
  tokens.castShadow = true;
  tokens.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(tokens);
  const pool: Token[] = Array.from({ length: MAX }, () => ({
    live: false,
    kind: 'honest',
    route: null,
    x: 0,
    z: 0,
    y: 0,
    vx: 0,
    speed: 0,
    size: 1,
    age: 0,
    fade: 1,
    graduate: false,
    phase: 0,
    color: new THREE.Color(),
  }));

  // State.
  let mode: Mode = 'hero';
  let scrollP = 0;
  let width = 1;
  let height = 1;
  let flash = 0;
  let wallFlash = 0;
  let doorY = 0;
  let exploreLeft = 6;
  let spawnClock = 0;
  const camPos = new THREE.Vector3(...SHOTS[0]!.pos);
  const camLook = new THREE.Vector3(...SHOTS[0]!.look);
  let camFov = SHOTS[0]!.fov;

  const RATE: Record<Mode, { rate: number; hostile: number }> = {
    hero: { rate: 1.6, hostile: 0.35 },
    open: { rate: 2.4, hostile: 0.75 },
    rise: { rate: 1.8, hostile: 0.6 },
    sidedoor: { rate: 2.2, hostile: 0.6 },
    measure: { rate: 1.5, hostile: 0.5 },
    tracks: { rate: 4.2, hostile: 0.7 },
    bound: { rate: 2.6, hostile: 0.5 },
    trace: { rate: 2, hostile: 0.15 },
    ledger: { rate: 1.2, hostile: 0.3 },
  };

  function spawn(at?: number) {
    const t = pool.find((p) => !p.live);
    if (!t) return;
    const r = RATE[mode];
    t.live = true;
    t.kind = Math.random() < r.hostile ? 'hostile' : 'honest';
    t.route = null;
    t.age = 0;
    t.fade = 1;
    t.phase = 0;
    t.graduate = false;
    t.y = 0.3;
    t.vx = 0;
    t.size = mode === 'tracks' && t.kind === 'hostile' ? 0.62 : mode === 'measure' && t.kind === 'hostile' ? 1.45 : 1;
    t.speed = 3.2 + Math.random() * 1.6;
    if (mode === 'sidedoor' && t.kind === 'hostile') {
      // Tries to walk around the door.
      const side = Math.random() < 0.5 ? -1 : 1;
      t.x = side * (3 + Math.random() * 7);
    } else {
      t.x = (Math.random() - 0.5) * 1.6;
    }
    t.z = at ?? LANE_START - Math.random() * 6;
    t.color.copy(t.kind === 'hostile' ? C.aub : C.honest);
  }

  function decide(t: Token) {
    if (mode === 'open') {
      t.route = 'free';
      if (t.kind === 'hostile') t.color.copy(C.loss);
      return;
    }
    if (t.kind === 'hostile') {
      if (mode === 'tracks' && exploreLeft > 0) {
        // A Sybil stranger: paid from the shared exploration budget until it runs out.
        exploreLeft -= 1;
        t.route = 'explore';
        t.color.copy(C.mari);
        return;
      }
      t.route = mode === 'measure' ? 'revert' : 'refuse';
      if (t.route === 'refuse') flash = 1;
      return;
    }
    const explore = Math.random() < (mode === 'trace' ? 0.55 : 0.3) && exploreLeft > 0;
    if (explore) {
      exploreLeft -= 1;
      t.route = 'explore';
      t.color.copy(C.mari);
      t.graduate = mode === 'trace';
    } else {
      t.route = 'proven';
    }
  }

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pv = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const tmpC = new THREE.Color();

  function step(dt: number) {
    const r = RATE[mode];
    spawnClock += dt * r.rate;
    while (spawnClock > 1) {
      spawn();
      spawnClock -= 1;
    }
    // The exploration budget refills continuously, never all at once.
    exploreLeft = Math.min(6, exploreLeft + dt * (mode === 'tracks' ? 0.35 : 0.9));

    for (const t of pool) {
      if (!t.live) continue;
      t.age += dt;
      if (t.route === null) {
        if (Math.abs(t.x) > 2) {
          t.z += t.speed * dt;
          if (t.z >= -0.35) {
            t.route = 'wall';
            wallFlash = 1;
          }
        } else {
          t.z += t.speed * dt;
          if (t.z >= THRESHOLD_Z) decide(t);
        }
      } else if (t.route === 'refuse' || t.route === 'wall') {
        // Stopped at the threshold: settle, then sink through the floor.
        t.phase += dt;
        t.z = Math.min(t.z + Math.max(0, 0.4 - t.phase) * dt, t.route === 'wall' ? -0.35 : THRESHOLD_Z);
        if (t.phase > 0.6) t.y -= dt * 0.5;
        if (t.phase > 0.4) t.fade -= dt * 0.9;
      } else if (t.route === 'revert') {
        // Measured on the way out, then pulled back.
        t.phase += dt;
        if (t.phase < 0.8) t.z += t.speed * 0.6 * dt;
        else {
          if (t.phase < 0.85) flash = 1;
          t.z -= 4 * dt;
          if (t.z < -1.6) t.fade -= dt * 1.2;
          t.color.lerp(C.aubLight, dt * 2);
        }
      } else if (t.route === 'free') {
        t.z += t.speed * dt;
        if (t.z > 30) t.fade -= dt;
      } else {
        // On a track.
        const curve = t.route === 'proven' ? provenCurve : exploreCurve;
        t.phase += (t.speed * dt) / curve.getLength();
        const p = curve.getPoint(Math.min(t.phase, 1));
        t.x = p.x + (t.route === 'proven' ? Math.sin(t.age * 3 + t.speed) * 0.25 : 0);
        t.z = p.z;
        if (t.graduate && t.phase > 0.42) t.color.lerp(C.honest, dt * 3);
        if (t.phase > 0.95) t.fade -= dt * 1.5;
      }
      if (t.fade <= 0 || t.z > 60) t.live = false;
    }
  }

  function writeInstances() {
    let n = 0;
    for (const t of pool) {
      if (!t.live) continue;
      // Shrink anything passing close to the camera so it never floats over the page text.
      const near = Math.min(1, Math.max(0, (camera.position.distanceTo(pv.set(t.x, t.y, t.z)) - 11) / 4));
      const s = t.size * Math.max(0.001, Math.min(1, t.fade, t.age * 4, near));
      e.set(0, t.route === 'proven' || t.route === 'explore' ? Math.sin(t.age) * 0.1 : 0, 0);
      q.setFromEuler(e);
      pv.set(t.x, t.y + (t.size - 1) * 0.12, t.z);
      sv.set(s, s, s);
      m4.compose(pv, q, sv);
      tokens.setMatrixAt(n, m4);
      tmpC.copy(t.color);
      tokens.setColorAt(n, tmpC);
      n++;
    }
    tokens.count = n;
    tokens.instanceMatrix.needsUpdate = true;
    if (tokens.instanceColor) tokens.instanceColor.needsUpdate = true;
  }

  function shotAt(p: number): Shot {
    const i = Math.max(0, Math.min(SHOTS.length - 1, Math.floor(p)));
    const j = Math.min(SHOTS.length - 1, i + 1);
    const t = smooth(Math.max(0, Math.min(1, p - i)));
    const a = SHOTS[i]!;
    const b = SHOTS[j]!;
    const mix = (u: V3, v: V3): V3 => [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t, u[2] + (v[2] - u[2]) * t];
    return { pos: mix(a.pos, b.pos), look: mix(a.look, b.look), fov: a.fov + (b.fov - a.fov) * t };
  }

  function resize() {
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // On wide screens the chapter panel sits on the left, so push the subject right of centre.
    if (width > 900) camera.setViewOffset(width, height, -width * 0.14, 0, width, height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }

  // Prime the scene so the first frame already has traffic on it.
  for (let i = 0; i < 14; i++) spawn(LANE_START + i * 3.3);
  for (let i = 0; i < 160; i++) step(1 / 30);

  let last = performance.now();
  let raf = 0;
  let running = true;
  const tVec = new THREE.Vector3();
  const lookVec = new THREE.Vector3();

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!opts.reduced) step(dt);

    // Camera follows the scroll, damped so it glides rather than jumps.
    const shot = shotAt(scrollP);
    const k = opts.reduced ? 1 : 1 - Math.exp(-dt * 3.2);
    camPos.lerp(tVec.set(...shot.pos), k);
    camLook.lerp(lookVec.set(...shot.look), k);
    camFov += (shot.fov - camFov) * k;
    const breathe = opts.reduced ? 0 : Math.sin(now / 2600) * 0.06;
    camera.position.set(camPos.x + breathe, camPos.y + breathe * 0.5, camPos.z);
    camera.lookAt(camLook);
    if (Math.abs(camera.fov - camFov) > 0.01) {
      camera.fov = camFov;
      camera.updateProjectionMatrix();
    }

    // The door sinks away in the prologue (no lock but the model) and rises in chapter I.
    const doorTarget = mode === 'open' ? -6.8 : 0;
    doorY += (doorTarget - doorY) * (opts.reduced ? 1 : 1 - Math.exp(-dt * 2.2));
    door.position.y = doorY;
    glow.intensity = mode === 'open' ? 0 : 6 + flash * 10;
    thresholdMat.emissiveIntensity = 1.4 + flash * 2.4;

    flash = Math.max(0, flash - dt * 2.6);
    wallFlash = Math.max(0, wallFlash - dt * 2.2);
    fieldMat.opacity = mode === 'open' ? 0 : 0.03 + flash * 0.16;
    const wallBase = mode === 'sidedoor' ? 0.07 : 0;
    wallMat.opacity = wallBase + wallFlash * (mode === 'sidedoor' ? 0.3 : 0);
    wallEdgeMat.opacity = mode === 'sidedoor' ? 0.55 : 0;
    exploreMat.emissiveIntensity = 0.25 + (exploreLeft / 6) * 0.5;
    gate.visible = mode === 'trace' || mode === 'ledger';

    // The prologue is the danger chapter: the studio warms toward red.
    const target = mode === 'open' ? C.rose : C.silver;
    bg.lerp(target, opts.reduced ? 1 : 1 - Math.exp(-dt * 2));
    (scene.fog as THREE.Fog).color.copy(bg);

    writeInstances();
    renderer.render(scene, camera);
  }

  const onVis = () => {
    running = document.visibilityState === 'visible';
    last = performance.now();
  };
  document.addEventListener('visibilitychange', onVis);
  resize();
  raf = requestAnimationFrame(frame);

  return {
    setScroll(p) {
      scrollP = p;
    },
    setMode(m) {
      if (m === mode) return;
      mode = m;
      if (m === 'tracks') exploreLeft = 6;
    },
    resize,
    dispose() {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
