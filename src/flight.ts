import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { initLatencyChart, recordLatency } from "./latency.ts";
import type { FlightManeuver, FlightPilotResponse, FlightSnapshot } from "./types.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const hudSpd = document.querySelector("#hud-spd")!;
const hudAlt = document.querySelector("#hud-alt")!;
const hudHdg = document.querySelector("#hud-hdg")!;
const hudThr = document.querySelector("#hud-thr")!;
const hudRing = document.querySelector("#hud-ring")!;
const hudRingMax = document.querySelector("#hud-ring-max")!;
const hudKills = document.querySelector("#hud-kills")!;
const hudKillsMax = document.querySelector("#hud-kills-max")!;
const hudHpYou = document.querySelector("#hud-hp-you")!;
const hudHpJev = document.querySelector("#hud-hp-jev")!;
const hudMsl = document.querySelector("#hud-msl")!;
const hudFlr = document.querySelector("#hud-flr")!;
const crosshair = document.querySelector("#crosshair")!;
const radarCanvas = document.querySelector<HTMLCanvasElement>("#radar")!;
const radarRng = document.querySelector("#radar-rng")!;
const radarAlt = document.querySelector("#radar-alt")!;
const radarCtx = radarCanvas.getContext("2d")!;
const RADAR_MIN = 260;
const RADAR_MAX = 2200;
const feedList = document.querySelector("#decisions");
const banner = document.querySelector("#flight-banner")!;
const bannerText = document.querySelector("#flight-banner-text")!;
const statusAction = document.querySelector("#pilot-action")!;
const statusMeta = document.querySelector("#pilot-meta")!;

const WORLD = 4800;
const SEA = 0;
const RING_RADIUS = 16;

function noise2(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const h = (ix: number, iz: number) => {
    const n = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  return (
    h(xi, zi) * (1 - u) * (1 - v) +
    h(xi + 1, zi) * u * (1 - v) +
    h(xi, zi + 1) * (1 - u) * v +
    h(xi + 1, zi + 1) * u * v
  );
}

function fbm(x: number, z: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < 5; i++) {
    sum += (noise2(x * freq, z * freq) * 2 - 1) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.05;
  }
  return sum / norm;
}

function heightAt(x: number, z: number): number {
  if (Math.abs(x) < 32 && z < 180 && z > -340) return 1.15;
  const d = Math.hypot(x * 0.92, z + 180);
  const island = Math.max(0, 1 - d / 1750);
  const n = fbm(x * 0.0018, z * 0.0018);
  const detail = fbm(x * 0.007, z * 0.007);
  const ridge = Math.exp(-((x - 640) ** 2 + (z + 200) ** 2) / 220000) * 95;
  const peak = Math.exp(-((x + 780) ** 2 + (z + 980) ** 2) / 180000) * 145;
  const land = 12 + n * 58 + detail * 14 + ridge + peak;
  return Math.max(SEA - 28, island * land);
}

function onRunway(x: number, z: number): boolean {
  return Math.abs(x) < 18 && z < 160 && z > -300 && heightAt(x, z) < 2.2;
}

function makeNoiseMap(size: number, repeat: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = 0.55 + 0.45 * fbm(x * 0.07, y * 0.07);
      const i = (y * size + x) * 4;
      img.data[i] = 88 + n * 90;
      img.data[i + 1] = 102 + n * 80;
      img.data[i + 2] = 62 + n * 40;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeCloudSprite(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 16, 128, 128, 120);
  g.addColorStop(0, "rgba(255,255,255,0.92)");
  g.addColorStop(0.45, "rgba(236,244,255,0.45)");
  g.addColorStop(1, "rgba(220,236,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeAirplane(env: THREE.Texture, skin: "gold" | "red" = "gold"): THREE.Group {
  const plane = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({
    color: skin === "gold" ? 0xe7c14a : 0x8f2222,
    metalness: 0.35,
    roughness: 0.28,
    clearcoat: 0.65,
    clearcoatRoughness: 0.22,
    envMap: env,
    envMapIntensity: 0.45,
  });
  const white = new THREE.MeshPhysicalMaterial({
    color: skin === "gold" ? 0xf4f1ea : 0x2a3038,
    metalness: 0.25,
    roughness: 0.32,
    envMap: env,
    envMapIntensity: 0.35,
  });
  const stripe = new THREE.MeshPhysicalMaterial({
    color: skin === "gold" ? 0xb42318 : 0xf0c63a,
    metalness: 0.4,
    roughness: 0.3,
    envMap: env,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1f24, metalness: 0.7, roughness: 0.35, envMap: env });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x8ecfff,
    metalness: 0.1,
    roughness: 0.05,
    transmission: 0.55,
    thickness: 0.4,
    transparent: true,
    opacity: 0.75,
    envMap: env,
    envMapIntensity: 0.6,
  });

  const fuse = new THREE.Mesh(new THREE.CapsuleGeometry(0.48, 3.6, 8, 20), paint);
  fuse.rotation.x = Math.PI / 2;
  fuse.position.y = 0.12;
  plane.add(fuse);

  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), dark);
  nose.scale.set(1, 1, 1.15);
  nose.position.set(0, 0.12, -2.55);
  plane.add(nose);

  const cowling = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.5, 0.7, 16), white);
  cowling.rotation.x = Math.PI / 2;
  cowling.position.set(0, 0.12, -2.15);
  plane.add(cowling);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(10.4, 0.09, 1.7, 1, 1, 2), white);
  wing.position.set(0, 0.08, -0.15);
  plane.add(wing);
  const wingTipL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.22, 0.9), stripe);
  wingTipL.position.set(-5.15, 0.12, -0.15);
  const wingTipR = wingTipL.clone();
  wingTipR.position.x = 5.15;
  plane.add(wingTipL, wingTipR);

  const stripeBar = new THREE.Mesh(new THREE.BoxGeometry(10.5, 0.03, 0.22), stripe);
  stripeBar.position.set(0, 0.14, -0.15);
  plane.add(stripeBar);

  const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a3036, metalness: 0.7, roughness: 0.35 });
  const addGun = (x: number) => {
    const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.35, 10), gunMat);
    gun.rotation.x = Math.PI / 2;
    gun.position.set(x, -0.18, -0.95);
    plane.add(gun);
  };
  addGun(-3.6);
  addGun(3.6);

  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.35, 1.05), white);
  tail.position.set(0, 0.85, 2.15);
  tail.rotation.x = -0.12;
  plane.add(tail);

  const stab = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.07, 0.85), white);
  stab.position.set(0, 0.42, 2.2);
  plane.add(stab);

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), glass);
  canopy.scale.set(0.72, 0.72, 1.35);
  canopy.position.set(0, 0.42, -0.35);
  plane.add(canopy);

  const makeWheel = (x: number, y: number, z: number) => {
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.7, 8), dark);
    strut.position.set(x, y, z);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.07, 8, 16), dark);
    wheel.rotation.y = Math.PI / 2;
    wheel.position.set(x, y - 0.38, z);
    plane.add(strut, wheel);
  };
  makeWheel(-1.15, -0.15, -0.2);
  makeWheel(1.15, -0.15, -0.2);
  makeWheel(0, -0.05, -2.05);

  const prop = new THREE.Group();
  prop.name = "prop";
  const spinner = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), white);
  spinner.scale.z = 1.4;
  prop.add(spinner);
  const bladeGeo = new THREE.BoxGeometry(0.14, 2.35, 0.04);
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(bladeGeo, dark);
    blade.rotation.z = (i * Math.PI * 2) / 3;
    blade.rotation.y = 0.18;
    prop.add(blade);
  }
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1.2, 24),
    new THREE.MeshBasicMaterial({ color: 0x222226, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
  );
  disc.name = "prop-disc";
  prop.add(disc);
  prop.position.set(0, 0.12, -2.82);
  plane.add(prop);

  plane.traverse((obj: THREE.Object3D) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
  return plane;
}

function makeTerrain(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(WORLD, WORLD, 240, 240);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors: number[] = [];
  const color = new THREE.Color();
  const sand = new THREE.Color(0xcbb58a);
  const grass = new THREE.Color(0x4f8a46);
  const pine = new THREE.Color(0x2f6a3a);
  const rock = new THREE.Color(0x7a7d78);
  const snow = new THREE.Color(0xeef3f7);
  const asphalt = new THREE.Color(0x3d4248);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = heightAt(x, z);
    pos.setY(i, Math.max(y, SEA - 4));
    if (Math.abs(x) < 28 && z < 160 && z > -320 && y < 2.4) color.copy(asphalt);
    else if (y < 2.8) color.copy(sand);
    else if (y < 22) color.copy(grass);
    else if (y < 58) color.copy(pine);
    else if (y < 92) color.copy(rock);
    else color.copy(snow);
    const mottling = 0.88 + noise2(x * 0.04, z * 0.04) * 0.22;
    color.multiplyScalar(mottling);
    colors.push(color.r, color.g, color.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: makeNoiseMap(256, 70),
    roughness: 0.92,
    metalness: 0.0,
    envMapIntensity: 0.08,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function makeTrees(scene: THREE.Scene): void {
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 2.4, 7);
  const leafGeo = new THREE.SphereGeometry(1.35, 10, 8);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3b22, roughness: 0.9 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2d6b38, roughness: 0.75 });
  const spots: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 520; i++) {
    const x = (noise2(i * 0.17, 2.1) - 0.5) * 2400;
    const z = (noise2(i * 0.19, 8.4) - 0.5) * 2400;
    const y = heightAt(x, z);
    if (y < 7 || y > 52 || onRunway(x, z) || Math.abs(x) < 48) continue;
    spots.push([x, y, z, 0.65 + noise2(i, 1) * 1.5]);
  }
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, spots.length);
  trunks.castShadow = leaves.castShadow = true;
  trunks.receiveShadow = leaves.receiveShadow = true;
  const dummy = new THREE.Object3D();
  spots.forEach((s, i) => {
    dummy.position.set(s[0], s[1] + 1.2 * s[3], s[2]);
    dummy.scale.set(s[3], s[3], s[3]);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.y = s[1] + 2.8 * s[3];
    dummy.scale.set(s[3] * 1.1, s[3] * 1.25, s[3] * 1.1);
    dummy.updateMatrix();
    leaves.setMatrixAt(i, dummy.matrix);
  });
  scene.add(trunks, leaves);
}

function makeClouds(scene: THREE.Scene): void {
  const tex = makeCloudSprite();
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
  });
  for (let i = 0; i < 48; i++) {
    const group = new THREE.Group();
    const n = 4 + (i % 4);
    for (let j = 0; j < n; j++) {
      const s = new THREE.Sprite(mat);
      const sc = 28 + ((i + j) % 5) * 10;
      s.scale.set(sc, sc * 0.62, 1);
      s.position.set((j - n / 2) * 18, Math.sin(j + i) * 6, j * 4);
      group.add(s);
    }
    group.position.set(((i * 197) % 3200) - 1600, 110 + (i % 6) * 18, ((i * 311) % 3200) - 1700);
    scene.add(group);
  }
}

type Ring = { mesh: THREE.Mesh; position: THREE.Vector3; taken: boolean };

function makeRings(scene: THREE.Scene, env: THREE.Texture): Ring[] {
  const path: Array<[number, number, number]> = [
    [0, 42, -210],
    [50, 56, -400],
    [160, 68, -540],
    [280, 62, -650],
    [340, 78, -820],
    [190, 96, -1020],
    [-30, 84, -1120],
    [-190, 74, -940],
    [-240, 58, -740],
    [-90, 50, -560],
    [20, 46, -370],
  ];
  const rings: Ring[] = [];
  const geo = new THREE.TorusGeometry(RING_RADIUS, 0.45, 12, 48);
  for (let i = 0; i < path.length; i++) {
    const [x, y, z] = path[i]!;
    const mat = new THREE.MeshPhysicalMaterial({
      color: i === 0 ? 0xffe566 : 0x7ad4ff,
      emissive: i === 0 ? 0x664400 : 0x0a3048,
      roughness: 0.18,
      metalness: 0.15,
      transmission: 0.35,
      transparent: true,
      opacity: 0.92,
      envMap: env,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    const next = path[i + 1] ?? [x, y, z - 80];
    mesh.lookAt(next[0], next[1], next[2]);
    mesh.castShadow = true;
    scene.add(mesh);
    rings.push({ mesh, position: mesh.position.clone(), taken: false });
  }
  return rings;
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function noiseBuffer(ctx: AudioContext, seconds: number, pink: boolean): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    if (!pink) {
      data[i] = white;
      continue;
    }
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.052691;
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22;
  }
  return buf;
}

type PlaneAudio = {
  ctx: AudioContext;
  master: GainNode;
  airGain: GainNode;
  airFilter: BiquadFilterNode;
  rumbleGain: GainNode;
  rumbleFilter: BiquadFilterNode;
  osc: OscillatorNode;
  oscGain: GainNode;
  foeGain: GainNode;
  foeFilter: BiquadFilterNode;
  foeAir: AudioBufferSourceNode;
  foeOsc: OscillatorNode;
  foePan: StereoPannerNode;
};

function createPlaneAudio(): PlaneAudio {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  const air = ctx.createBufferSource();
  air.buffer = noiseBuffer(ctx, 2.5, true);
  air.loop = true;
  const airFilter = ctx.createBiquadFilter();
  airFilter.type = "bandpass";
  airFilter.frequency.value = 380;
  airFilter.Q.value = 0.55;
  const airGain = ctx.createGain();
  airGain.gain.value = 0.55;
  air.connect(airFilter);
  airFilter.connect(airGain);
  airGain.connect(master);

  const rumble = ctx.createBufferSource();
  rumble.buffer = air.buffer;
  rumble.loop = true;
  const rumbleFilter = ctx.createBiquadFilter();
  rumbleFilter.type = "lowpass";
  rumbleFilter.frequency.value = 140;
  rumbleFilter.Q.value = 0.4;
  const rumbleGain = ctx.createGain();
  rumbleGain.gain.value = 0.4;
  rumble.connect(rumbleFilter);
  rumbleFilter.connect(rumbleGain);
  rumbleGain.connect(master);

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 48;
  const oscFilter = ctx.createBiquadFilter();
  oscFilter.type = "lowpass";
  oscFilter.frequency.value = 160;
  const oscGain = ctx.createGain();
  oscGain.gain.value = 0.035;
  osc.connect(oscFilter);
  oscFilter.connect(oscGain);
  oscGain.connect(master);

  const foePan = ctx.createStereoPanner();
  const foeGain = ctx.createGain();
  foeGain.gain.value = 0.0001;
  foePan.connect(foeGain);
  foeGain.connect(master);

  const foeAir = ctx.createBufferSource();
  foeAir.buffer = air.buffer;
  foeAir.loop = true;
  const foeFilter = ctx.createBiquadFilter();
  foeFilter.type = "bandpass";
  foeFilter.frequency.value = 900;
  foeFilter.Q.value = 0.7;
  foeAir.connect(foeFilter);
  foeFilter.connect(foePan);

  const foeOsc = ctx.createOscillator();
  foeOsc.type = "sawtooth";
  foeOsc.frequency.value = 72;
  const foeOscFilt = ctx.createBiquadFilter();
  foeOscFilt.type = "lowpass";
  foeOscFilt.frequency.value = 240;
  const foeOscGain = ctx.createGain();
  foeOscGain.gain.value = 0.12;
  foeOsc.connect(foeOscFilt);
  foeOscFilt.connect(foeOscGain);
  foeOscGain.connect(foePan);

  air.start();
  rumble.start();
  osc.start();
  foeAir.start();
  foeOsc.start();
  return {
    ctx,
    master,
    airGain,
    airFilter,
    rumbleGain,
    rumbleFilter,
    osc,
    oscGain,
    foeGain,
    foeFilter,
    foeAir,
    foeOsc,
    foePan,
  };
}

function burstNoise(ctx: AudioContext, dest: AudioNode, dur: number, gain: number, hp: number, lp: number): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, Math.max(0.08, dur), false);
  const hi = ctx.createBiquadFilter();
  hi.type = "highpass";
  hi.frequency.value = hp;
  const lo = ctx.createBiquadFilter();
  lo.type = "lowpass";
  lo.frequency.value = lp;
  const g = ctx.createGain();
  const now = ctx.currentTime;
  g.gain.setValueAtTime(gain, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(hi);
  hi.connect(lo);
  lo.connect(g);
  g.connect(dest);
  src.start(now);
  src.stop(now + dur + 0.02);
}

function playGun(audio: PlaneAudio): void {
  const { ctx, master } = audio;
  burstNoise(ctx, master, 0.07, 0.55, 800, 4200);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(180, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.06);
  g.gain.setValueAtTime(0.12, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.08);
  osc.connect(g);
  g.connect(master);
  osc.start();
  osc.stop(ctx.currentTime + 0.09);
}

function playBoom(audio: PlaneAudio): void {
  const { ctx, master } = audio;
  burstNoise(ctx, master, 0.45, 0.85, 40, 700);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(70, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(22, ctx.currentTime + 0.35);
  g.gain.setValueAtTime(0.5, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
  osc.connect(g);
  g.connect(master);
  osc.start();
  osc.stop(ctx.currentTime + 0.42);
}

function playMissile(audio: PlaneAudio): void {
  const { ctx, master } = audio;
  burstNoise(ctx, master, 0.35, 0.7, 180, 2400);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(420, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(90, ctx.currentTime + 0.32);
  g.gain.setValueAtTime(0.16, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.34);
  osc.connect(g);
  g.connect(master);
  osc.start();
  osc.stop(ctx.currentTime + 0.36);
}

function playLockTone(audio: PlaneAudio, locked: boolean): void {
  const { ctx, master } = audio;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "square";
  osc.frequency.value = locked ? 1480 : 760;
  g.gain.setValueAtTime(0.07, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (locked ? 0.08 : 0.12));
  osc.connect(g);
  g.connect(master);
  osc.start();
  osc.stop(ctx.currentTime + 0.14);
}

function playFlare(audio: PlaneAudio): void {
  const { ctx, master } = audio;
  burstNoise(ctx, master, 0.28, 0.42, 900, 6500);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(2400, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 0.22);
  g.gain.setValueAtTime(0.08, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.24);
  osc.connect(g);
  g.connect(master);
  osc.start();
  osc.stop(ctx.currentTime + 0.26);
}

const keys = new Set<string>();
window.addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.72;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x8fb8d6, 0.00022);

const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.25, 24000);
camera.matrixAutoUpdate = false;

const sky = new Sky();
sky.scale.setScalar(18000);
scene.add(sky);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 8;
skyU.rayleigh.value = 2.8;
skyU.mieCoefficient.value = 0.005;
skyU.mieDirectionalG.value = 0.8;
skyU.cloudCoverage.value = 0.42;
skyU.cloudDensity.value = 0.28;
skyU.cloudScale.value = 0.00016;
skyU.cloudSpeed.value = 0.000025;

const sunSpherical = new THREE.Vector3();
const elevation = 16;
const azimuth = 148;
sunSpherical.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevation), THREE.MathUtils.degToRad(azimuth));
skyU.sunPosition.value.copy(sunSpherical);

const pmrem = new THREE.PMREMGenerator(renderer);
skyU.showSunDisc.value = 0;
const envScene = new THREE.Scene();
envScene.add(sky);
const envMap = pmrem.fromScene(envScene).texture;
skyU.showSunDisc.value = 1;
scene.add(sky);
scene.environment = envMap;
scene.environmentIntensity = 0.28;

scene.add(new THREE.HemisphereLight(0xb9d7f2, 0x3e5a38, 0.62));
const sun = new THREE.DirectionalLight(0xfff1c2, 1.35);
sun.position.copy(sunSpherical).multiplyScalar(800);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 1400;
sun.shadow.camera.left = -180;
sun.shadow.camera.right = 180;
sun.shadow.camera.top = 180;
sun.shadow.camera.bottom = -180;
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.04;
scene.add(sun);
scene.add(sun.target);

type WaterMat = THREE.MeshPhysicalMaterial & { userData: { uTime?: { value: number } } };
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(WORLD * 1.3, WORLD * 1.3, 64, 64),
  new THREE.MeshPhysicalMaterial({
    color: 0x0d4f73,
    metalness: 0.45,
    roughness: 0.22,
    envMapIntensity: 0.55,
    transparent: true,
    opacity: 0.92,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  }) as WaterMat,
);
water.rotation.x = -Math.PI / 2;
water.position.y = SEA;
water.receiveShadow = true;
const waterMat = water.material as WaterMat;
waterMat.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = { value: 0 };
  waterMat.userData.uTime = shader.uniforms.uTime as { value: number };
  shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace(
    "#include <begin_vertex>",
    `#include <begin_vertex>
    float w1 = sin(transformed.x * 0.012 + uTime * 0.7);
    float w2 = sin(transformed.y * 0.018 + uTime * 0.9);
    transformed.z += w1 * 1.1 + w2 * 0.7;`,
  );
};
scene.add(water);

scene.add(makeTerrain());
makeTrees(scene);
makeClouds(scene);

const runway = new THREE.Mesh(
  new THREE.PlaneGeometry(24, 300),
  new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.78, metalness: 0.05 }),
);
runway.rotation.x = -Math.PI / 2;
runway.position.set(0, 1.22, -70);
runway.receiveShadow = true;
scene.add(runway);
const marks = new THREE.Mesh(
  new THREE.PlaneGeometry(0.7, 260),
  new THREE.MeshBasicMaterial({ color: 0xf3efe4 }),
);
marks.rotation.x = -Math.PI / 2;
marks.position.set(0, 1.26, -70);
scene.add(marks);

const plane = makeAirplane(envMap, "gold");
plane.matrixAutoUpdate = false;
scene.add(plane);
const prop = plane.getObjectByName("prop")!;
const propDisc = plane.getObjectByName("prop-disc") as THREE.Mesh;

const foeMesh = makeAirplane(envMap, "red");
foeMesh.matrixAutoUpdate = false;
scene.add(foeMesh);
const foeProp = foeMesh.getObjectByName("prop")!;
const foePropDisc = foeMesh.getObjectByName("prop-disc") as THREE.Mesh;
const foePos = new THREE.Vector3();
const foeX = new THREE.Vector3();
const foeY = new THREE.Vector3();
const foeZ = new THREE.Vector3();
const foeRot = new THREE.Matrix4();
const foeMat = new THREE.Matrix4();
const foeFwd = new THREE.Vector3();
const aimPoint = new THREE.Vector3();
const toVec = new THREE.Vector3();
let foeYaw = 0;
let foePitch = 0;
let foeTurbo = 0;
let foeSpeed = 0;
let foeHp = 5;
let foeAlive = true;
let foeFireCool = 0;
let foeGunSide = 0;
let foeInvuln = 0;
let playerHp = 5;
let playerInvuln = 0;
const MAX_HP = 5;
const HIT_R = 5.6;
const FIGHT_AGL_MIN = 16;
const FIGHT_AGL_PREF = 30;
const FIGHT_AGL_MAX = 48;

const rings = makeRings(scene, envMap);
hudRingMax.textContent = String(rings.length);

type Target = {
  group: THREE.Group;
  balloon: THREE.Mesh;
  pos: THREE.Vector3;
  radius: number;
  alive: boolean;
  phase: number;
  baseY: number;
};

type Bullet = {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  alive: boolean;
  life: number;
  owner: "you" | "jev";
};

type Blast = {
  group: THREE.Group;
  fire: THREE.Mesh;
  light: THREE.PointLight;
  bits: THREE.Mesh[];
  bitVel: THREE.Vector3[];
  age: number;
};

const TARGET_COUNT = 16;
const GUN_OFFSETS = [new THREE.Vector3(-3.6, -0.18, -1.55), new THREE.Vector3(3.6, -0.18, -1.55)];
const bulletGeo = new THREE.CylinderGeometry(0.1, 0.1, 2.6, 6);
bulletGeo.rotateX(Math.PI / 2);
const youBulletMat = new THREE.MeshBasicMaterial({ color: 0xfff3a1 });
const jevBulletMat = new THREE.MeshBasicMaterial({ color: 0xff4d3a });
const bullets: Bullet[] = [];
for (let i = 0; i < 80; i++) {
  const mesh = new THREE.Mesh(bulletGeo, youBulletMat);
  mesh.visible = false;
  scene.add(mesh);
  bullets.push({ mesh, vel: new THREE.Vector3(), alive: false, life: 0, owner: "you" });
}

type Flare = {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  alive: boolean;
  life: number;
  heat: number;
  owner: "you" | "jev";
};

type Missile = {
  group: THREE.Group;
  vel: THREE.Vector3;
  alive: boolean;
  life: number;
  owner: "you" | "jev";
  seek: "foe" | "you" | "balloon" | "flare";
  balloon: Target | null;
  flare: Flare | null;
  trail: THREE.Line;
  trailPos: Float32Array;
};

const MSL_AMMO = 4;
const MSL_SPEED = 305;
const MSL_TURN = 3.15;
const MSL_LIFE = 5.6;
const MSL_HIT = 8.2;
const TRAIL_N = 22;
const missileDir = new THREE.Vector3();
const missileLook = new THREE.Vector3();

function makeMissileVisual(color: number): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.2, 2.6, 8),
    new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.32 }),
  );
  body.rotation.x = Math.PI / 2;
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.62, 8),
    new THREE.MeshStandardMaterial({ color: 0xf4f0ea, metalness: 0.4, roughness: 0.35 }),
  );
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -1.55;
  const exhaust = new THREE.Mesh(
    new THREE.ConeGeometry(0.14, 0.7, 8),
    new THREE.MeshBasicMaterial({ color: 0xffc266 }),
  );
  exhaust.rotation.x = Math.PI / 2;
  exhaust.position.z = 1.55;
  for (const x of [-0.28, 0.28]) {
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.04, 0.38),
      new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.45 }),
    );
    fin.position.set(x, 0, 0.85);
    group.add(fin);
  }
  const light = new THREE.PointLight(color === 0xc45a3a ? 0xff5533 : 0xffcc66, 3.2, 16);
  light.position.z = 1.6;
  group.add(body, nose, exhaust, light);
  return group;
}

const missiles: Missile[] = [];
for (let i = 0; i < 12; i++) {
  const group = makeMissileVisual(i % 2 ? 0xc45a3a : 0xd8c27a);
  group.visible = false;
  scene.add(group);
  const trailPos = new Float32Array(TRAIL_N * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
  const trail = new THREE.Line(
    trailGeo,
    new THREE.LineBasicMaterial({ color: 0xffb35a, transparent: true, opacity: 0.7 }),
  );
  trail.visible = false;
  scene.add(trail);
  missiles.push({
    group,
    vel: new THREE.Vector3(),
    alive: false,
    life: 0,
    owner: "you",
    seek: "foe",
    balloon: null,
    flare: null,
    trail,
    trailPos,
  });
}

let playerMsl = MSL_AMMO;
let foeMsl = MSL_AMMO;
let foeMissileCool = 0;
let lockT = 0;
let lastLockBeep = 0;
const LOCK_NEED = 0.38;
const FLARE_AMMO = 10;
const FLARE_LIFE = 3.4;
const FLARE_HIT = 6.4;
const flareOff = new THREE.Vector3();
const flareSeek = new THREE.Vector3();
const flareGeo = new THREE.SphereGeometry(0.42, 7, 5);
const flareMat = new THREE.MeshBasicMaterial({
  color: 0xffd27a,
  transparent: true,
  opacity: 0.92,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const flares: Flare[] = [];
for (let i = 0; i < 16; i++) {
  const mesh = new THREE.Mesh(flareGeo, flareMat);
  mesh.visible = false;
  mesh.frustumCulled = true;
  scene.add(mesh);
  flares.push({
    mesh,
    vel: new THREE.Vector3(),
    alive: false,
    life: 0,
    heat: 0,
    owner: "you",
  });
}
let playerFlares = FLARE_AMMO;
let foeFlares = FLARE_AMMO;
let flareCool = 0;
let foeFlareCool = 0;

const balloonGeo = new THREE.SphereGeometry(3.4, 18, 14);
const basketGeo = new THREE.BoxGeometry(1.4, 1.1, 1.4);
const ropeMat = new THREE.MeshStandardMaterial({ color: 0x6b5344, roughness: 0.8 });
const colors = [0xe24b4b, 0xf0c14a, 0x3d9cf0, 0xe67e22, 0x9b59b6, 0x2ecc71];
const targets: Target[] = [];

function placeTargets(): void {
  let n = 0;
  let guard = 0;
  while (n < TARGET_COUNT && guard < 400) {
    guard += 1;
    const x = (Math.random() - 0.5) * 1600;
    const z = -120 - Math.random() * 1400;
    if (Math.abs(x) < 70 && z > -360) continue;
    const ground = heightAt(x, z);
    if (ground < 2) continue;
    const y = ground + 28 + Math.random() * 55;
    const existing = targets[n];
    if (existing) {
      existing.pos.set(x, y, z);
      existing.baseY = y;
      existing.alive = true;
      existing.group.visible = true;
      existing.group.position.copy(existing.pos);
      n += 1;
      continue;
    }
    const group = new THREE.Group();
    const mat = new THREE.MeshPhysicalMaterial({
      color: colors[n % colors.length],
      roughness: 0.35,
      metalness: 0.05,
      clearcoat: 0.4,
    });
    const balloon = new THREE.Mesh(balloonGeo, mat);
    balloon.castShadow = true;
    const basket = new THREE.Mesh(basketGeo, new THREE.MeshStandardMaterial({ color: 0x8a6a3b, roughness: 0.85 }));
    basket.position.y = -5.1;
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.4, 6), ropeMat);
    rope.position.y = -3.3;
    group.add(balloon, basket, rope);
    group.position.set(x, y, z);
    scene.add(group);
    targets.push({
      group,
      balloon,
      pos: new THREE.Vector3(x, y, z),
      radius: 5.2,
      alive: true,
      phase: Math.random() * Math.PI * 2,
      baseY: y,
    });
    n += 1;
  }
  hudKillsMax.textContent = String(targets.length);
}

placeTargets();

const blasts: Blast[] = [];
const fireGeo = new THREE.SphereGeometry(1, 12, 10);
const bitGeo = new THREE.TetrahedronGeometry(0.45);

function spawnBlast(at: THREE.Vector3): void {
  const group = new THREE.Group();
  group.position.copy(at);
  const fire = new THREE.Mesh(
    fireGeo,
    new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.95 }),
  );
  const light = new THREE.PointLight(0xff7a22, 18, 80, 2);
  group.add(fire, light);
  const bits: THREE.Mesh[] = [];
  const bitVel: THREE.Vector3[] = [];
  for (let i = 0; i < 18; i++) {
    const bit = new THREE.Mesh(
      bitGeo,
      new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff5a1f : 0xffe082 }),
    );
    const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.7, Math.random() - 0.5)
      .normalize()
      .multiplyScalar(18 + Math.random() * 22);
    bit.scale.setScalar(0.6 + Math.random());
    group.add(bit);
    bits.push(bit);
    bitVel.push(vel);
  }
  scene.add(group);
  blasts.push({ group, fire, light, bits, bitVel, age: 0 });
}

const gunWorld = new THREE.Vector3();
let gunSide = 0;
let fireCool = 0;
let kills = 0;
let mouseDown = false;
let audio: PlaneAudio | null = null;

function ensureAudio(): void {
  if (audio) {
    if (audio.ctx.state === "suspended") void audio.ctx.resume();
    return;
  }
  audio = createPlaneAudio();
}

function headingDeg(fwd: THREE.Vector3): number {
  return Math.round(((Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI + 360) % 360);
}

function sight(from: THREE.Vector3, fwd: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, to: THREE.Vector3) {
  toVec.copy(to).sub(from);
  const range = toVec.length();
  if (range < 0.001) return { range: 0, bearing: 0, elevation: 0, along: 1, lined: false };
  toVec.multiplyScalar(1 / range);
  const along = toVec.dot(fwd);
  const bearing = Math.atan2(toVec.dot(right), along);
  const elevation = Math.asin(THREE.MathUtils.clamp(toVec.dot(up), -1, 1));
  return {
    range,
    bearing,
    elevation,
    along,
    lined: along > 0.35 && Math.abs(bearing) < 0.18 && Math.abs(elevation) < 0.16,
  };
}

function fireFrom(
  owner: "you" | "jev",
  matrix: THREE.Matrix4,
  fwd: THREE.Vector3,
  rot: THREE.Matrix4,
  side: number,
): number {
  const slot = bullets.find((b) => !b.alive);
  if (!slot) return side;
  gunWorld.copy(GUN_OFFSETS[side]!);
  gunWorld.applyMatrix4(matrix);
  slot.mesh.position.copy(gunWorld);
  slot.vel.copy(fwd).multiplyScalar(220);
  slot.mesh.quaternion.setFromRotationMatrix(rot);
  slot.mesh.material = owner === "you" ? youBulletMat : jevBulletMat;
  slot.mesh.visible = true;
  slot.alive = true;
  slot.life = 1.6;
  slot.owner = owner;
  if (owner === "you") lastPlayerShot = performance.now();
  if (audio) playGun(audio);
  return 1 - side;
}

function fireGun(): void {
  if (crashed) return;
  gunSide = fireFrom("you", plane.matrix, forward, rotMatrix, gunSide);
}

function missileOn(who: "you" | "jev"): boolean {
  for (const m of missiles) {
    if (!m.alive) continue;
    if (who === "jev" && m.owner === "you" && m.seek === "foe") return true;
    if (who === "you" && m.owner === "jev") return true;
  }
  return false;
}

function lockCandidate(): { seek: "foe" | "balloon"; balloon: Target | null } | null {
  if (foeAlive) {
    const s = sight(planePosition, forward, axisX, axisY, foePos);
    if (s.along > 0.42 && s.range < 680 && Math.abs(s.bearing) < 0.48 && Math.abs(s.elevation) < 0.4) {
      return { seek: "foe", balloon: null };
    }
  }
  let best: Target | null = null;
  let bestRange = 380;
  for (const t of targets) {
    if (!t.alive) continue;
    const s = sight(planePosition, forward, axisX, axisY, t.pos);
    if (s.along > 0.58 && Math.abs(s.bearing) < 0.26 && Math.abs(s.elevation) < 0.22 && s.range < bestRange) {
      best = t;
      bestRange = s.range;
    }
  }
  if (best) return { seek: "balloon", balloon: best };
  return null;
}

function fireMissile(owner: "you" | "jev"): void {
  if (crashed && owner === "you") return;
  if (owner === "you") {
    if (playerMsl <= 0 || lockT < 1) return;
  } else if (foeMsl <= 0 || !foeAlive) return;
  const slot = missiles.find((m) => !m.alive);
  if (!slot) return;
  const matrix = owner === "you" ? plane.matrix : foeMesh.matrix;
  const fwd = owner === "you" ? forward : foeFwd;
  gunWorld.set(0, -0.35, -3.1);
  gunWorld.applyMatrix4(matrix);
  slot.group.position.copy(gunWorld);
  slot.vel.copy(fwd).multiplyScalar(MSL_SPEED);
  slot.alive = true;
  slot.life = MSL_LIFE;
  slot.owner = owner;
  slot.group.visible = true;
  slot.trail.visible = true;
  if (owner === "you") {
    const lock = lockCandidate();
    if (!lock) {
      slot.alive = false;
      slot.group.visible = false;
      slot.trail.visible = false;
      return;
    }
    slot.seek = lock.seek;
    slot.balloon = lock.balloon;
    slot.flare = null;
    playerMsl -= 1;
    lockT = 0.35;
  } else {
    slot.seek = "you";
    slot.balloon = null;
    slot.flare = null;
    foeMsl -= 1;
  }
  const pos = slot.trailPos;
  for (let i = 0; i < TRAIL_N; i++) {
    pos[i * 3] = gunWorld.x;
    pos[i * 3 + 1] = gunWorld.y;
    pos[i * 3 + 2] = gunWorld.z;
  }
  (slot.trail.geometry as THREE.BufferGeometry).attributes.position.needsUpdate = true;
  if (audio) playMissile(audio);
}

function killMissile(m: Missile): void {
  m.alive = false;
  m.group.visible = false;
  m.trail.visible = false;
  m.balloon = null;
  m.flare = null;
}

function killFlare(f: Flare): void {
  f.alive = false;
  f.mesh.visible = false;
  f.heat = 0;
}

function hottestFlare(m: Missile, victim: "you" | "jev"): Flare | null {
  let best: Flare | null = null;
  let bestScore = 0;
  const speed = m.vel.length();
  for (const f of flares) {
    if (!f.alive || f.owner !== victim || f.heat < 0.08) continue;
    flareSeek.copy(f.mesh.position).sub(m.group.position);
    const d = flareSeek.length();
    if (d < 0.05) continue;
    flareSeek.multiplyScalar(1 / d);
    const closing = speed > 0.5 ? m.vel.dot(flareSeek) / speed : 1;
    if (closing < -0.2 && d > 28) continue;
    const score = (f.heat * (0.55 + Math.max(0, closing))) / (6 + d * 0.12);
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

function missileTarget(m: Missile): THREE.Vector3 | null {
  if (m.owner === "jev" || m.seek === "you" || (m.seek === "flare" && m.flare?.owner === "you")) {
    const decoy = hottestFlare(m, "you");
    const close = m.group.position.distanceTo(planePosition) < 20;
    if (decoy && !close) {
      m.seek = "flare";
      m.flare = decoy;
      return decoy.mesh.position;
    }
    if (m.seek === "flare") {
      m.seek = "you";
      m.flare = null;
    }
  }
  if (m.owner === "you" && (m.seek === "foe" || (m.seek === "flare" && m.flare?.owner === "jev"))) {
    const decoy = hottestFlare(m, "jev");
    const close = foeAlive && m.group.position.distanceTo(foePos) < 20;
    if (decoy && !close) {
      m.seek = "flare";
      m.flare = decoy;
      return decoy.mesh.position;
    }
    if (m.seek === "flare" && m.flare?.owner === "jev") {
      m.seek = "foe";
      m.flare = null;
    }
  }
  if (m.seek === "flare" && m.flare?.alive) return m.flare.mesh.position;
  if (m.seek === "foe") return foeAlive ? foePos : null;
  if (m.seek === "you") return crashed ? null : planePosition;
  if (m.balloon?.alive) return m.balloon.pos;
  return null;
}

function popFlares(owner: "you" | "jev"): void {
  if (owner === "you") {
    if (crashed || playerFlares <= 0 || flareCool > 0) return;
  } else if (!foeAlive || foeFlares <= 0 || foeFlareCool > 0) return;
  const ammo = owner === "you" ? playerFlares : foeFlares;
  const n = Math.min(4, ammo);
  const matrix = owner === "you" ? plane.matrix : foeMesh.matrix;
  const fwd = owner === "you" ? forward : foeFwd;
  const right = owner === "you" ? axisX : foeX;
  const up = owner === "you" ? axisY : foeY;
  const inherit = owner === "you" ? speed : foeSpeed;
  let dumped = 0;
  for (const f of flares) {
    if (f.alive) continue;
    flareOff.set((dumped % 2 === 0 ? -1 : 1) * (1.1 + dumped * 0.35), -0.55, 2.1);
    flareOff.applyMatrix4(matrix);
    f.mesh.position.copy(flareOff);
    f.vel
      .copy(fwd)
      .multiplyScalar(-14 - dumped * 3)
      .addScaledVector(fwd, inherit * 0.28)
      .addScaledVector(right, (Math.random() - 0.5) * 16)
      .addScaledVector(up, 2 + Math.random() * 7);
    f.alive = true;
    f.life = FLARE_LIFE * (0.85 + Math.random() * 0.2);
    f.heat = 1;
    f.owner = owner;
    f.mesh.visible = true;
    dumped += 1;
    if (dumped >= n) break;
  }
  if (dumped <= 0) return;
  if (owner === "you") {
    playerFlares -= dumped;
    flareCool = 0.85;
  } else {
    foeFlares -= dumped;
    foeFlareCool = 0.9;
  }
  if (audio) playFlare(audio);
}

function logDecision(kind: string, text: string): void {
  if (!feedList) return;
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = text;
  feedList.prepend(li);
  while (feedList.children.length > 10) feedList.removeChild(feedList.lastChild as Node);
}

let jevBusy = false;
let jevManeuver: FlightManeuver = "pursue";
let jevWantFire = false;
let jevAskAt = 0;
let jevBreakDir = 1;
let lastPlayerShot = -9999;

function playerShooting(): boolean {
  return held("Space") || mouseDown || performance.now() - lastPlayerShot < 380;
}

function clockLabel(bearing: number): string {
  let hour = Math.round((((bearing * 180) / Math.PI + 360) % 360) / 30);
  if (hour === 0) hour = 12;
  return `${hour} o'clock`;
}

function huntManeuver(lined: boolean, shotAt: boolean, range: number): FlightManeuver {
  if (shotAt && !lined) return "break";
  if (lined) return "guns";
  if (range < 160) return "lead";
  return "pursue";
}

function orthonormalize(x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3): void {
  z.normalize();
  x.crossVectors(y, z).normalize();
  y.crossVectors(z, x).normalize();
}

function snapshotFlight(): FlightSnapshot {
  const you = sight(foePos, foeFwd, foeX, foeY, planePosition);
  const them = sight(planePosition, forward, axisX, axisY, foePos);
  const shooting = playerShooting();
  const alt = planePosition.y - foePos.y;
  return {
    rules:
      "You are Jev in the red plane. Hunt and shoot down the gold player. " +
      "clock is where they sit relative to your nose. they_are_shooting means they pulled the trigger. " +
      "Stay aggressive. Do not run.",
    you: {
      hp: foeHp,
      x: Math.round(foePos.x),
      y: Math.round(foePos.y),
      z: Math.round(foePos.z),
      heading_deg: headingDeg(foeFwd),
      speed: Math.round(foeSpeed),
    },
    foe: {
      hp: playerHp,
      x: Math.round(planePosition.x),
      y: Math.round(planePosition.y),
      z: Math.round(planePosition.z),
      heading_deg: headingDeg(forward),
      speed: Math.round(speed),
    },
    geometry: {
      range: Math.round(you.range),
      bearing_deg: Math.round((you.bearing * 180) / Math.PI),
      elevation_deg: Math.round((you.elevation * 180) / Math.PI),
      aspect_deg: Math.round((them.bearing * 180) / Math.PI),
      clock: clockLabel(you.bearing),
      high_or_low: alt > 12 ? "high" : alt < -12 ? "low" : "level",
      lined_up: you.lined,
      they_have_guns_on_you: them.lined,
      they_are_shooting: shooting,
      they_are_shooting_at_you: shooting && them.lined,
      incoming_missile: missileOn("jev"),
      closing: you.along > 0.15,
      alt_diff: Math.round(alt),
    },
  };
}

async function askJev(): Promise<void> {
  if (jevBusy || !foeAlive || crashed) return;
  jevBusy = true;
  const t0 = performance.now();
  const you = sight(foePos, foeFwd, foeX, foeY, planePosition);
  const them = sight(planePosition, forward, axisX, axisY, foePos);
  try {
    const res = await fetch("/api/flight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshotFlight()),
    });
    const ms = Math.round(performance.now() - t0);
    recordLatency(ms);
    const data = (await res.json()) as FlightPilotResponse;
    if (!res.ok) throw new Error(data.detail || data.error || `http ${res.status}`);
    const shotAt = playerShooting() && them.lined;
    let next = data.maneuver ?? huntManeuver(you.lined, shotAt || missileOn("jev"), you.range);
    if (next === "extend") next = "pursue";
    if (next === "climb" && foePos.y - heightAt(foePos.x, foePos.z) > FIGHT_AGL_PREF) next = "pursue";
    if (next === "break" && !shotAt && !missileOn("jev")) next = you.lined ? "guns" : "pursue";
    jevManeuver = next;
    jevWantFire = Number(data.fire ?? 0) >= 0.35 || you.lined;
    statusAction.textContent = `JEV  ${jevManeuver.toUpperCase()}`;
    statusMeta.textContent = `${ms}ms · ${clockLabel(you.bearing)} · ${playerShooting() ? "under fire" : "hunt"}`;
    logDecision(jevWantFire ? "flap" : "wait", `${jevManeuver.toUpperCase()}  ${clockLabel(you.bearing)}  ${ms}ms`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Jev call failed";
    statusAction.textContent = "ERROR";
    statusMeta.textContent = message;
    logDecision("error", message);
    jevManeuver = huntManeuver(you.lined, (playerShooting() && them.lined) || missileOn("jev"), you.range);
    jevWantFire = true;
  } finally {
    jevBusy = false;
    const hot = playerShooting();
    jevAskAt = performance.now() + (hot ? 450 : 800);
  }
}

function fightCeiling(x: number, z: number): number {
  return heightAt(x, z) + FIGHT_AGL_MAX;
}

function fightFloor(x: number, z: number): number {
  return Math.max(SEA + 18, heightAt(x, z) + FIGHT_AGL_MIN);
}

function steerFoe(_frames: number): { bank: number; pitch: number; turboOn: boolean } {
  const you = sight(foePos, foeFwd, foeX, foeY, planePosition);
  const them = sight(planePosition, forward, axisX, axisY, foePos);
  const leadAmt = THREE.MathUtils.clamp(you.range * 0.18, 10, 55);
  aimPoint.copy(planePosition).addScaledVector(forward, leadAmt);
  const gAim = heightAt(aimPoint.x, aimPoint.z);
  aimPoint.y = THREE.MathUtils.clamp(Math.min(planePosition.y, gAim + FIGHT_AGL_MAX), gAim + FIGHT_AGL_MIN, gAim + FIGHT_AGL_MAX);
  const lead = sight(foePos, foeFwd, foeX, foeY, aimPoint);
  const look =
    jevManeuver === "guns" && planePosition.y <= fightCeiling(planePosition.x, planePosition.z) ? you : lead;
  const shotAt = (playerShooting() && them.lined) || missileOn("jev");
  const agl = foePos.y - heightAt(foePos.x, foePos.z);
  let bank = 0;
  let pitch = 0;
  if (look.bearing > 0.04) bank = -1;
  else if (look.bearing < -0.04) bank = 1;
  if (look.elevation > 0.04) pitch = 1;
  else if (look.elevation < -0.04) pitch = -1;
  if (Math.abs(look.bearing) > 0.22 && agl < FIGHT_AGL_PREF) pitch = Math.max(pitch, 0.45);
  if (jevManeuver === "climb" && agl < FIGHT_AGL_PREF - 4) pitch = 1;
  if (jevManeuver === "dive" || agl > FIGHT_AGL_PREF + 6) pitch = Math.min(pitch, -0.35);
  if (shotAt || jevManeuver === "break") {
    bank = jevBreakDir;
    if (Math.abs(look.bearing) > 0.35) bank = look.bearing > 0 ? -1 : 1;
    pitch = agl > FIGHT_AGL_PREF ? -0.4 : pitch;
  }
  if (agl < FIGHT_AGL_MIN + 8 || foePos.y < SEA + 22) {
    pitch = 1;
    if (agl < FIGHT_AGL_MIN) bank *= 0.25;
  }
  if (agl > FIGHT_AGL_MAX - 8) pitch = Math.min(pitch, -0.75);
  if (agl > FIGHT_AGL_MAX) pitch = -1;
  const pointed = Math.abs(look.bearing) < 0.85 && you.along > -0.1;
  const turboOn = you.range > 150 && pointed && agl < FIGHT_AGL_MAX - 4;
  return { bank, pitch, turboOn };
}

function damagePlayer(amount = 1): void {
  if (playerInvuln > 0 || crashed) return;
  playerHp -= amount;
  playerInvuln = amount > 1 ? 1.05 : 0.85;
  spawnBlast(planePosition.clone().addScaledVector(forward, 2));
  if (audio) playBoom(audio);
  if (playerHp <= 0) crash(amount > 1 ? "Missile. Jev boxed you." : "Jev shot you down.");
}

function damageFoe(amount = 1): void {
  if (!foeAlive || foeInvuln > 0) return;
  foeHp -= amount;
  foeInvuln = amount > 1 ? 1.05 : 0.85;
  spawnBlast(foePos.clone());
  if (audio) playBoom(audio);
  if (foeHp <= 0) {
    foeAlive = false;
    foeMesh.visible = false;
    spawnBlast(foePos.clone());
    banner.classList.remove("is-hidden");
    bannerText.textContent = "Jev is down. R to scramble again.";
    statusAction.textContent = "SPLASH";
    statusMeta.textContent = "You shot Jev down";
    bannerUntil = Infinity;
    logDecision("flap", "JEV DOWN");
  }
}

function hitTarget(target: Target): void {
  target.alive = false;
  target.group.visible = false;
  kills += 1;
  spawnBlast(target.pos);
  if (audio) playBoom(audio);
}

const axisX = new THREE.Vector3(1, 0, 0);
const axisY = new THREE.Vector3(0, 1, 0);
const axisZ = new THREE.Vector3(0, 0, 1);
const planePosition = new THREE.Vector3();
const rotMatrix = new THREE.Matrix4();
const planeMatrix = new THREE.Matrix4();
const delayedRotMatrix = new THREE.Matrix4();
const delayedQuaternion = new THREE.Quaternion();
const quatFrom = new THREE.Quaternion();
const quatTo = new THREE.Quaternion();
const camMatrix = new THREE.Matrix4();
const tiltMatrix = new THREE.Matrix4();
const camOffMatrix = new THREE.Matrix4();
const forward = new THREE.Vector3();
const up = new THREE.Vector3();
const sunOffset = sunSpherical.clone().multiplyScalar(420);

const CRUISE = 1.35;
const MAX_TURN = 0.045;
const TURN_ACCEL = 0.0028;

let yawVel = 0;
let pitchVel = 0;
let turbo = 0;
let speed = 0;
let crashed = false;
let won = false;
let closeCam = false;
let nextRing = 0;
let bannerUntil = 0;

function reset(): void {
  axisX.set(1, 0, 0);
  axisY.set(0, 1, 0);
  axisZ.set(0, 0, 1);
  planePosition.set(0, 42, 80);
  yawVel = 0;
  pitchVel = 0;
  turbo = 0;
  speed = CRUISE;
  crashed = false;
  won = false;
  nextRing = 0;
  kills = 0;
  fireCool = 0;
  playerHp = MAX_HP;
  playerInvuln = 0;
  foeHp = MAX_HP;
  foeAlive = true;
  foeInvuln = 0;
  foeYaw = 0;
  foePitch = 0;
  foeTurbo = 0.2;
  foeSpeed = CRUISE;
  foeFireCool = 0;
  playerMsl = MSL_AMMO;
  foeMsl = MSL_AMMO;
  foeMissileCool = 1.2;
  lockT = 0;
  for (const m of missiles) {
    m.alive = false;
    m.group.visible = false;
    m.trail.visible = false;
    m.balloon = null;
    m.flare = null;
  }
  for (const f of flares) killFlare(f);
  playerFlares = FLARE_AMMO;
  foeFlares = FLARE_AMMO;
  flareCool = 0;
  foeFlareCool = 0;
  foePos.set(48, 32, -70);
  foeX.set(-1, 0, 0);
  foeY.set(0, 1, 0);
  foeZ.set(0, 0, -1);
  foeMesh.visible = true;
  jevManeuver = "pursue";
  jevWantFire = false;
  jevBusy = false;
  jevAskAt = performance.now() + 400;
  jevBreakDir = Math.random() < 0.5 ? 1 : -1;
  for (const b of bullets) {
    b.alive = false;
    b.mesh.visible = false;
  }
  for (const blast of blasts) scene.remove(blast.group);
  blasts.length = 0;
  placeTargets();
  if (audio) {
    const now = audio.ctx.currentTime;
    audio.master.gain.cancelScheduledValues(now);
    audio.master.gain.setValueAtTime(0.42, now);
  }
  delayedQuaternion.identity();
  delayedRotMatrix.identity();
  camera.matrixAutoUpdate = false;
  camera.fov = 58;
  camera.updateProjectionMatrix();
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i]!;
    ring.taken = false;
    const mat = ring.mesh.material as THREE.MeshPhysicalMaterial;
    mat.color.setHex(i === 0 ? 0xffe566 : 0x7ad4ff);
    mat.emissive.setHex(i === 0 ? 0x664400 : 0x0a3048);
  }
  banner.classList.remove("is-hidden");
  bannerText.textContent = "Hold the nose on Jev until the pipper goes red, then F for a missile.";
  bannerUntil = performance.now() + 4500;
  statusAction.textContent = "SCRAMBLE";
  statusMeta.textContent = "waiting for Jev";
  feedList?.replaceChildren();
}

function highlightRing(): void {
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i]!;
    const mat = ring.mesh.material as THREE.MeshPhysicalMaterial;
    if (ring.taken) {
      mat.color.setHex(0x8dff9a);
      mat.emissive.setHex(0x145522);
    } else if (i === nextRing) {
      mat.color.setHex(0xffe566);
      mat.emissive.setHex(0x664400);
    } else {
      mat.color.setHex(0x7ad4ff);
      mat.emissive.setHex(0x0a3048);
    }
  }
}

function crash(reason: string): void {
  crashed = true;
  turbo = 0;
  const ground = heightAt(planePosition.x, planePosition.z);
  planePosition.y = Math.max(planePosition.y, ground + 8);
  banner.classList.remove("is-hidden");
  bannerText.textContent = reason;
  statusAction.textContent = "DOWN";
  statusMeta.textContent = "R to restart";
  bannerUntil = Infinity;
  if (audio) {
    const now = audio.ctx.currentTime;
    audio.master.gain.cancelScheduledValues(now);
    audio.master.gain.setValueAtTime(audio.master.gain.value, now);
    audio.master.gain.linearRampToValueAtTime(0.0001, now + 0.4);
    playBoom(audio);
  }
}

function finish(): void {
  won = true;
  banner.classList.remove("is-hidden");
  bannerText.textContent = "Course complete. R to fly it again.";
  statusAction.textContent = "COMPLETE";
  statusMeta.textContent = `${rings.length} rings`;
  bannerUntil = Infinity;
}

function held(code: string): boolean {
  return keys.has(code);
}

function resize(): void {
  const w = canvas.clientWidth || 1280;
  const h = canvas.clientHeight || 720;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(canvas);
canvas.addEventListener("click", () => {
  canvas.focus();
  ensureAudio();
});
canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 0) {
    mouseDown = true;
    ensureAudio();
    fireGun();
  }
  if (e.button === 2) {
    ensureAudio();
    fireMissile("you");
  }
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("pointerup", () => {
  mouseDown = false;
});
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyR") reset();
  if (e.code === "KeyC") closeCam = !closeCam;
  if (e.code === "Space") ensureAudio();
  if (e.code === "KeyX") {
    if (e.repeat) return;
    ensureAudio();
    popFlares("you");
  }
  if (e.code === "KeyF") {
    if (e.repeat) return;
    e.preventDefault();
    ensureAudio();
    fireMissile("you");
  }
});

reset();
resize();

const clock = new THREE.Clock();

function drawRadar(elapsed: number): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const css = 176;
  if (radarCanvas.width !== css * dpr) {
    radarCanvas.width = css * dpr;
    radarCanvas.height = css * dpr;
  }
  const ctx = radarCtx;
  const w = radarCanvas.width;
  const cx = w / 2;
  const r = w * 0.46;
  ctx.clearRect(0, 0, w, w);
  ctx.fillStyle = "rgba(6, 22, 28, 0.78)";
  ctx.beginPath();
  ctx.arc(cx, cx, r + w * 0.02, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(120, 200, 180, 0.28)";
  ctx.lineWidth = Math.max(1, w * 0.008);
  for (const f of [1 / 3, 2 / 3, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cx, r * f, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx, cx - r);
  ctx.lineTo(cx, cx + r);
  ctx.moveTo(cx - r, cx);
  ctx.lineTo(cx + r, cx);
  ctx.stroke();
  const sweep = (elapsed * 1.35) % (Math.PI * 2);
  const grad = ctx.createConicGradient(sweep, cx, cx);
  grad.addColorStop(0, "rgba(120, 255, 190, 0.28)");
  grad.addColorStop(0.18, "rgba(120, 255, 190, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d7fff0";
  ctx.beginPath();
  ctx.moveTo(cx, cx - w * 0.035);
  ctx.lineTo(cx + w * 0.022, cx + w * 0.028);
  ctx.lineTo(cx - w * 0.022, cx + w * 0.028);
  ctx.closePath();
  ctx.fill();

  if (!foeAlive) {
    radarRng.textContent = "—";
    radarAlt.textContent = "—";
    ctx.fillStyle = "rgba(200, 210, 220, 0.55)";
    ctx.font = `${Math.round(w * 0.055)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("NO CNTC", cx, cx + r * 0.18);
    return;
  }
  const dx = foePos.x - planePosition.x;
  const dz = foePos.z - planePosition.z;
  const localRight = dx * axisX.x + dz * axisX.z;
  const localFwd = dx * forward.x + dz * forward.z;
  const dist = Math.hypot(localRight, localFwd);
  const range = THREE.MathUtils.clamp(dist * 1.25, RADAR_MIN, RADAR_MAX);
  const scale = r / range;
  let px = localRight * scale;
  let py = -localFwd * scale;
  const mag = Math.hypot(px, py);
  let offScale = false;
  if (mag > r * 0.92) {
    const k = (r * 0.92) / mag;
    px *= k;
    py *= k;
    offScale = true;
  }
  const bx = cx + px;
  const by = cx + py;
  const alt = foePos.y - planePosition.y;
  const altFt = Math.round(alt * 3.28);
  const band = Math.abs(alt) < 10 ? "level" : alt > 0 ? "high" : "low";
  const hFwd = foeFwd.x * forward.x + foeFwd.z * forward.z;
  const hRight = foeFwd.x * axisX.x + foeFwd.z * axisX.z;
  ctx.strokeStyle = "rgba(255, 120, 100, 0.95)";
  ctx.lineWidth = Math.max(2, w * 0.01);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + hRight * w * 0.055, by - hFwd * w * 0.055);
  ctx.stroke();
  ctx.fillStyle = "#ff6b5a";
  ctx.beginPath();
  ctx.arc(bx, by, w * (offScale ? 0.018 : 0.022), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 180, 160, 0.9)";
  ctx.lineWidth = Math.max(1, w * 0.007);
  ctx.stroke();
  if (band !== "level") {
    const stem = w * (0.04 + Math.min(0.05, Math.abs(alt) / 900));
    ctx.strokeStyle = "#ffe27a";
    ctx.fillStyle = "#ffe27a";
    ctx.lineWidth = Math.max(2, w * 0.014);
    ctx.beginPath();
    if (band === "high") {
      ctx.moveTo(bx, by);
      ctx.lineTo(bx, by - stem);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx, by - stem - w * 0.008);
      ctx.lineTo(bx + w * 0.028, by - stem + w * 0.028);
      ctx.lineTo(bx - w * 0.028, by - stem + w * 0.028);
    } else {
      ctx.moveTo(bx, by);
      ctx.lineTo(bx, by + stem);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx, by + stem + w * 0.008);
      ctx.lineTo(bx + w * 0.028, by + stem - w * 0.028);
      ctx.lineTo(bx - w * 0.028, by + stem - w * 0.028);
    }
    ctx.closePath();
    ctx.fill();
  }
  radarRng.textContent = dist.toFixed(0);
  radarAlt.textContent =
    band === "level" ? "LVL" : band === "high" ? `HI +${Math.abs(altFt)}` : `LO −${Math.abs(altFt)}`;
  for (const m of missiles) {
    if (!m.alive) continue;
    const mdx = m.group.position.x - planePosition.x;
    const mdz = m.group.position.z - planePosition.z;
    let mx = (mdx * axisX.x + mdz * axisX.z) * scale;
    let mz = -(mdx * forward.x + mdz * forward.z) * scale;
    const mm = Math.hypot(mx, mz);
    if (mm > r * 0.92 && mm > 0.001) {
      mx *= (r * 0.92) / mm;
      mz *= (r * 0.92) / mm;
    }
    ctx.fillStyle = m.owner === "jev" ? "#ffb347" : "#fff4c2";
    ctx.beginPath();
    ctx.arc(cx + mx, cx + mz, w * 0.013, 0, Math.PI * 2);
    ctx.fill();
  }
}

function tick(): void {
  const dt = Math.min(clock.getDelta(), 0.05);
  const frames = dt * 60;
  requestAnimationFrame(tick);

  skyU.time.value = clock.elapsedTime;
  const waterTime = waterMat.userData.uTime;
  if (waterTime) waterTime.value = clock.elapsedTime;
  playerInvuln = Math.max(0, playerInvuln - dt);
  foeInvuln = Math.max(0, foeInvuln - dt);
  if (foeAlive && !crashed && performance.now() >= jevAskAt) void askJev();

  if (!crashed && !won) {
    yawVel *= Math.pow(0.95, frames);
    pitchVel *= Math.pow(0.95, frames);

    if (held("KeyA") || held("ArrowLeft")) yawVel += TURN_ACCEL * frames;
    if (held("KeyD") || held("ArrowRight")) yawVel -= TURN_ACCEL * frames;
    if (held("KeyW") || held("ArrowUp")) pitchVel -= TURN_ACCEL * frames;
    if (held("KeyS") || held("ArrowDown")) pitchVel += TURN_ACCEL * frames;
    if (held("KeyQ")) {
      axisX.applyAxisAngle(axisY, 0.018 * frames);
      axisZ.applyAxisAngle(axisY, 0.018 * frames);
    }
    if (held("KeyE")) {
      axisX.applyAxisAngle(axisY, -0.018 * frames);
      axisZ.applyAxisAngle(axisY, -0.018 * frames);
    }

    yawVel = THREE.MathUtils.clamp(yawVel, -MAX_TURN, MAX_TURN);
    pitchVel = THREE.MathUtils.clamp(pitchVel, -MAX_TURN, MAX_TURN);

    axisX.applyAxisAngle(axisZ, yawVel);
    axisY.applyAxisAngle(axisZ, yawVel);
    axisY.applyAxisAngle(axisX, pitchVel);
    axisZ.applyAxisAngle(axisX, pitchVel);
    orthonormalize(axisX, axisY, axisZ);

    if (held("ShiftLeft") || held("ShiftRight")) turbo = Math.min(1, turbo + 0.025 * frames);
    else turbo *= Math.pow(0.95, frames);

    const turboSpeed = easeOutQuad(turbo) * 2.6;
    speed = (CRUISE + turboSpeed) * 60;
    planePosition.addScaledVector(axisZ, -(CRUISE + turboSpeed) * frames);

    camera.fov = THREE.MathUtils.lerp(camera.fov, 58 + turbo * 16, 1 - Math.exp(-dt * 6));
    camera.updateProjectionMatrix();

    const ground = heightAt(planePosition.x, planePosition.z);
    if (planePosition.y < ground + 2.2) {
      crash(speed > 140 ? "Impact. You came in too hot." : "Terrain. Keep the yellow ring ahead.");
    } else if (planePosition.y < SEA + 1.6 && ground < 2) {
      crash("Ditched. Stay over the islands.");
    }

    const ring = rings[nextRing];
    if (ring && planePosition.distanceTo(ring.position) < RING_RADIUS * 0.95) {
      ring.taken = true;
      nextRing += 1;
      highlightRing();
      if (nextRing >= rings.length) finish();
    }
  }

  rotMatrix.makeBasis(axisX, axisY, axisZ);
  planeMatrix.makeTranslation(planePosition.x, planePosition.y, planePosition.z).multiply(rotMatrix);
  plane.matrix.copy(planeMatrix);
  plane.matrixWorldNeedsUpdate = true;

  if (foeAlive) {
    const stick = steerFoe(frames);
    foeYaw *= Math.pow(0.95, frames);
    foePitch *= Math.pow(0.95, frames);
    foeYaw += stick.bank * TURN_ACCEL * 1.4 * frames;
    foePitch += stick.pitch * TURN_ACCEL * 1.25 * frames;
    foeYaw = THREE.MathUtils.clamp(foeYaw, -MAX_TURN, MAX_TURN);
    foePitch = THREE.MathUtils.clamp(foePitch, -MAX_TURN, MAX_TURN);
    foeX.applyAxisAngle(foeZ, foeYaw);
    foeY.applyAxisAngle(foeZ, foeYaw);
    foeY.applyAxisAngle(foeX, foePitch);
    foeZ.applyAxisAngle(foeX, foePitch);
    orthonormalize(foeX, foeY, foeZ);
    if (stick.turboOn) foeTurbo = Math.min(1, foeTurbo + 0.025 * frames);
    else foeTurbo *= Math.pow(0.95, frames);
    const chase = sight(foePos, foeFwd.copy(foeZ).negate(), foeX, foeY, planePosition);
    const far = THREE.MathUtils.clamp((chase.range - 90) / 280, 0, 1);
    const foeBoost = easeOutQuad(foeTurbo) * (1.15 + far * 1.15);
    foeSpeed = (CRUISE + foeBoost) * 60;
    foePos.addScaledVector(foeZ, -(CRUISE + foeBoost) * frames);
    const foeGround = heightAt(foePos.x, foePos.z);
    const ceil = fightCeiling(foePos.x, foePos.z);
    const floor = fightFloor(foePos.x, foePos.z);
    if (foePos.y < floor) {
      foePos.y = floor;
      foePitch = Math.max(foePitch, 0.01);
    }
    if (foePos.y > ceil) {
      foePos.y = ceil;
      foePitch = Math.min(foePitch, -0.014);
    }
    if (chase.range > 1600) {
      foePos.copy(planePosition).addScaledVector(forward, 180).addScaledVector(axisX, 70);
      foePos.y = THREE.MathUtils.clamp(foePos.y, fightFloor(foePos.x, foePos.z), fightCeiling(foePos.x, foePos.z));
      foeZ.copy(forward).negate();
      foeY.set(0, 1, 0);
      orthonormalize(foeX, foeY, foeZ);
    }
    foeFwd.copy(foeZ).negate();
    foeRot.makeBasis(foeX, foeY, foeZ);
    foeMat.makeTranslation(foePos.x, foePos.y, foePos.z).multiply(foeRot);
    foeMesh.matrix.copy(foeMat);
    foeMesh.matrixWorldNeedsUpdate = true;
    (foeProp as THREE.Object3D).rotation.z -= (1.4 + foeTurbo * 2.2) * frames;
    const foeDisc = foePropDisc.material as THREE.MeshBasicMaterial;
    foeDisc.opacity = 0.08 + foeTurbo * 0.22;
    foeFireCool = Math.max(0, foeFireCool - dt);
    const jevSight = sight(foePos, foeFwd, foeX, foeY, planePosition);
    const onTarget =
      jevSight.along > 0.2 && Math.abs(jevSight.bearing) < 0.28 && Math.abs(jevSight.elevation) < 0.24;
    const mayFire = !crashed && foeFireCool <= 0 && onTarget && jevManeuver !== "break";
    if (mayFire) {
      foeGunSide = fireFrom("jev", foeMesh.matrix, foeFwd, foeRot, foeGunSide);
      foeFireCool = 0.09;
    }
    foeMissileCool = Math.max(0, foeMissileCool - dt);
    const mayMissile =
      !crashed &&
      foeMissileCool <= 0 &&
      foeMsl > 0 &&
      jevSight.along > 0.42 &&
      jevSight.range > 90 &&
      jevSight.range < 500 &&
      Math.abs(jevSight.bearing) < 0.42 &&
      Math.abs(jevSight.elevation) < 0.36 &&
      jevManeuver !== "break";
    if (mayMissile) {
      fireMissile("jev");
      foeMissileCool = 4.6;
    }
    foeFlareCool = Math.max(0, foeFlareCool - dt);
    if (missileOn("jev")) popFlares("jev");
  }

  quatFrom.copy(delayedQuaternion);
  quatTo.setFromRotationMatrix(rotMatrix);
  delayedQuaternion.copy(quatFrom).slerp(quatTo, 1 - Math.pow(1 - 0.175, frames));
  delayedRotMatrix.makeRotationFromQuaternion(delayedQuaternion);

  const back = closeCam ? 5.2 : 13.5;
  const lift = closeCam ? 1.35 : 2.6;
  camMatrix.makeTranslation(planePosition.x, planePosition.y, planePosition.z);
  camMatrix.multiply(delayedRotMatrix);
  camMatrix.multiply(tiltMatrix.makeRotationX(-0.18));
  camMatrix.multiply(camOffMatrix.makeTranslation(0, lift, back));
  camera.matrix.copy(camMatrix);
  camera.matrixWorldNeedsUpdate = true;

  sun.position.copy(planePosition).add(sunOffset);
  sun.target.position.copy(planePosition);
  sun.target.updateMatrixWorld();

  forward.copy(axisZ).negate();
  up.copy(axisY);

  fireCool = Math.max(0, fireCool - dt);
  flareCool = Math.max(0, flareCool - dt);
  if (!crashed && (held("Space") || mouseDown) && fireCool <= 0) {
    fireGun();
    fireCool = 0.085;
  }
  if (!crashed && held("KeyX")) popFlares("you");

  for (const b of bullets) {
    if (!b.alive) continue;
    b.life -= dt;
    b.mesh.position.addScaledVector(b.vel, dt);
    if (b.life <= 0 || b.mesh.position.y < heightAt(b.mesh.position.x, b.mesh.position.z)) {
      b.alive = false;
      b.mesh.visible = false;
      continue;
    }
    if (b.owner === "you" && foeAlive && foeInvuln <= 0 && b.mesh.position.distanceTo(foePos) < HIT_R) {
      damageFoe();
      b.alive = false;
      b.mesh.visible = false;
      continue;
    }
    if (b.owner === "jev" && playerInvuln <= 0 && b.mesh.position.distanceTo(planePosition) < HIT_R) {
      damagePlayer();
      b.alive = false;
      b.mesh.visible = false;
      continue;
    }
    if (b.owner !== "you") continue;
    for (const t of targets) {
      if (!t.alive) continue;
      if (b.mesh.position.distanceTo(t.pos) < t.radius) {
        hitTarget(t);
        b.alive = false;
        b.mesh.visible = false;
        break;
      }
    }
  }

  for (const f of flares) {
    if (!f.alive) continue;
    f.life -= dt;
    f.heat = Math.max(0, f.life / FLARE_LIFE);
    f.vel.y -= 24 * dt;
    f.vel.multiplyScalar(Math.pow(0.982, dt * 60));
    f.mesh.position.addScaledVector(f.vel, dt);
    if (f.life <= 0 || f.mesh.position.y < heightAt(f.mesh.position.x, f.mesh.position.z) + 0.5) {
      killFlare(f);
      continue;
    }
    const pulse = 0.7 + Math.sin(clock.elapsedTime * 22 + f.life * 8) * 0.3;
    f.mesh.scale.setScalar(0.9 + f.heat * 1.4 + pulse * 0.35);
  }

  for (const m of missiles) {
    if (!m.alive) continue;
    m.life -= dt;
    const tgt = missileTarget(m);
    if (tgt) {
      missileDir.copy(tgt).sub(m.group.position);
      const dist = missileDir.length();
      if (dist > 0.001) missileDir.multiplyScalar(1 / dist);
      const ang = m.vel.angleTo(missileDir);
      if (ang > 0.0008) {
        const t = Math.min(1, (MSL_TURN * dt) / ang);
        m.vel.normalize().lerp(missileDir, t).multiplyScalar(MSL_SPEED);
      } else {
        m.vel.copy(missileDir).multiplyScalar(MSL_SPEED);
      }
    } else {
      m.vel.y -= 18 * dt;
    }
    m.group.position.addScaledVector(m.vel, dt);
    missileLook.copy(m.group.position).add(m.vel);
    m.group.lookAt(missileLook);
    const pos = m.trailPos;
    for (let i = TRAIL_N - 1; i >= 1; i--) {
      pos[i * 3] = pos[(i - 1) * 3]!;
      pos[i * 3 + 1] = pos[(i - 1) * 3 + 1]!;
      pos[i * 3 + 2] = pos[(i - 1) * 3 + 2]!;
    }
    pos[0] = m.group.position.x;
    pos[1] = m.group.position.y;
    pos[2] = m.group.position.z;
    (m.trail.geometry as THREE.BufferGeometry).attributes.position.needsUpdate = true;
    const hitGround = m.group.position.y < heightAt(m.group.position.x, m.group.position.z) + 1.2;
    if (m.life <= 0 || hitGround) {
      if (hitGround) spawnBlast(m.group.position.clone());
      killMissile(m);
      continue;
    }
    if (m.seek === "flare" && m.flare?.alive && m.group.position.distanceTo(m.flare.mesh.position) < FLARE_HIT) {
      spawnBlast(m.flare.mesh.position.clone());
      killFlare(m.flare);
      killMissile(m);
      continue;
    }
    if (m.owner === "you" && foeAlive && m.seek === "foe" && m.group.position.distanceTo(foePos) < MSL_HIT) {
      spawnBlast(foePos.clone());
      damageFoe(2);
      killMissile(m);
      continue;
    }
    if (m.owner === "jev" && m.seek !== "flare" && m.group.position.distanceTo(planePosition) < MSL_HIT) {
      spawnBlast(planePosition.clone());
      damagePlayer(2);
      killMissile(m);
      continue;
    }
    if (m.owner === "you" && m.seek === "balloon" && m.balloon?.alive && m.group.position.distanceTo(m.balloon.pos) < MSL_HIT) {
      hitTarget(m.balloon);
      killMissile(m);
    }
  }

  const lock = !crashed ? lockCandidate() : null;
  if (lock) lockT = Math.min(1, lockT + dt / LOCK_NEED);
  else lockT = Math.max(0, lockT - dt * 1.8);
  crosshair.classList.toggle("is-locking", lockT > 0.1 && lockT < 1);
  crosshair.classList.toggle("is-locked", lockT >= 1);
  if (audio && lock && !crashed) {
    const gap = lockT >= 1 ? 160 : 400;
    if (performance.now() - lastLockBeep > gap) {
      playLockTone(audio, lockT >= 1);
      lastLockBeep = performance.now();
    }
  }

  const tNow = clock.elapsedTime;
  for (const t of targets) {
    if (!t.alive) continue;
    t.pos.y = t.baseY + Math.sin(tNow * 0.7 + t.phase) * 2.4;
    t.group.position.copy(t.pos);
    t.group.rotation.y = tNow * 0.25 + t.phase;
  }

  for (let i = blasts.length - 1; i >= 0; i--) {
    const blast = blasts[i]!;
    blast.age += dt;
    const u = blast.age / 0.55;
    const fireMat = blast.fire.material as THREE.MeshBasicMaterial;
    blast.fire.scale.setScalar(1 + u * 14);
    fireMat.opacity = Math.max(0, 0.95 - u);
    blast.light.intensity = Math.max(0, 18 * (1 - u));
    for (let j = 0; j < blast.bits.length; j++) {
      blast.bits[j]!.position.addScaledVector(blast.bitVel[j]!, dt);
      blast.bitVel[j]!.y -= 28 * dt;
    }
    if (blast.age > 0.55) {
      scene.remove(blast.group);
      blasts.splice(i, 1);
    }
  }

  if (audio && !crashed) {
    const now = audio.ctx.currentTime;
    const rush = THREE.MathUtils.clamp(0.22 + speed / 420 + turbo * 0.45, 0.15, 1);
    audio.master.gain.setTargetAtTime(0.42, now, 0.08);
    audio.airGain.gain.setTargetAtTime(0.35 + rush * 0.5, now, 0.1);
    audio.airFilter.frequency.setTargetAtTime(280 + rush * 720 + turbo * 400, now, 0.12);
    audio.rumbleGain.gain.setTargetAtTime(0.28 + turbo * 0.35, now, 0.1);
    audio.rumbleFilter.frequency.setTargetAtTime(110 + turbo * 90, now, 0.12);
    audio.osc.frequency.setTargetAtTime(42 + turbo * 28 + speed * 0.04, now, 0.1);
    audio.oscGain.gain.setTargetAtTime(0.02 + turbo * 0.04, now, 0.1);

    const rel = toVec.copy(foePos).sub(planePosition);
    const range = Math.max(8, rel.length());
    rel.multiplyScalar(1 / range);
    const radial = foeFwd.dot(rel) * foeSpeed - forward.dot(rel) * speed;
    const approach = -radial;
    const doppler = THREE.MathUtils.clamp((340 + approach * 0.55) / 340, 0.62, 1.65);
    const near = THREE.MathUtils.clamp((140 / range) ** 1.35, 0, 1.35);
    const aliveGain = foeAlive ? 0.08 + near * 0.95 : 0.0001;
    const pan = THREE.MathUtils.clamp((axisX.x * (foePos.x - planePosition.x) + axisX.z * (foePos.z - planePosition.z)) / range, -1, 1);
    audio.foeGain.gain.setTargetAtTime(aliveGain, now, 0.06);
    audio.foePan.pan.setTargetAtTime(pan, now, 0.08);
    audio.foeAir.playbackRate.setTargetAtTime(doppler, now, 0.08);
    audio.foeFilter.frequency.setTargetAtTime((720 + near * 900) * doppler, now, 0.1);
    audio.foeOsc.frequency.setTargetAtTime((58 + foeTurbo * 40) * doppler, now, 0.1);
  }

  (prop as THREE.Object3D).rotation.z -= (1.4 + turbo * 2.2) * frames;
  const discMat = propDisc.material as THREE.MeshBasicMaterial;
  discMat.opacity = 0.08 + turbo * 0.22;

  for (const ring of rings) {
    if (!ring.taken) ring.mesh.rotation.z += dt * 0.45;
  }

  const kts = Math.round(speed * 1.15);
  const ft = Math.max(0, Math.round((planePosition.y - SEA) * 3.28));
  const hdg = Math.round(((Math.atan2(forward.x, -forward.z) * 180) / Math.PI + 360) % 360);
  hudSpd.textContent = String(kts);
  hudAlt.textContent = String(ft);
  hudHdg.textContent = String(hdg).padStart(3, "0");
  hudThr.textContent = String(Math.round(turbo * 100));
  hudRing.textContent = String(nextRing);
  hudKills.textContent = String(kills);
  hudHpYou.textContent = String(Math.max(0, playerHp));
  hudHpJev.textContent = String(Math.max(0, foeHp));
  hudMsl.textContent = String(playerMsl);
  hudFlr.textContent = String(playerFlares);
  drawRadar(clock.elapsedTime);

  if (!crashed && !won && foeAlive) {
    if (performance.now() > bannerUntil) banner.classList.add("is-hidden");
  } else if (!crashed && !won) {
    statusAction.textContent = turbo > 0.4 ? "TURBO" : "AIRBORNE";
    statusMeta.textContent = `Balloons ${kills}/${targets.length}`;
    if (performance.now() > bannerUntil) banner.classList.add("is-hidden");
  }

  renderer.render(scene, camera);
}

tick();
canvas.focus();
initLatencyChart();
