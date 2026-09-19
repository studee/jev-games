import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { initLatencyChart, recordLatency } from "./latency.ts";
import type { DriveManeuver, DrivePilotResponse, DriveSnapshot } from "./types.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const hudSpd = document.querySelector("#hud-spd")!;
const hudRpm = document.querySelector("#hud-rpm")!;
const hudGear = document.querySelector("#hud-gear")!;
const hudHpYou = document.querySelector("#hud-hp-you")!;
const hudHpJev = document.querySelector("#hud-hp-jev")!;
const hudLap = document.querySelector("#hud-lap")!;
const hudPos = document.querySelector("#hud-pos")!;
const mapCanvas = document.querySelector<HTMLCanvasElement>("#drive-map")!;
const mapCtx = mapCanvas.getContext("2d")!;
const banner = document.querySelector("#drive-banner")!;
const bannerText = document.querySelector("#drive-banner-text")!;
const statusAction = document.querySelector("#pilot-action")!;
const statusMeta = document.querySelector("#pilot-meta")!;
const feedList = document.querySelector("#decisions");
const crosshair = document.querySelector(".flight-crosshair");
const gunsOnBtn = document.querySelector("#guns-on");
const gunsOffBtn = document.querySelector("#guns-off");
const keyGuns = document.querySelector("#key-guns");

const MASS = 798;
const IZ = 1650;
const A = 1.82;
const B = 1.48;
const CA_F = 11800;
const CA_R = 13200;
const ENGINE = 26800;
const BRAKE_F = 14500;
const DRAG = 0.22;
const ROLL = 140;
const VMAX = 86;
const GRASS_VMAX = 24;
const MAX_STEER = 0.24;
const G = 9.81;
const HIT_R = 1.85;
const MAX_HP = 5;
const STEP = 1 / 120;
const HALF_W = 7.4;
const BARRIER = 10.5;
const LAPS = 3;
const OVAL_W = 70;
const OVAL_L = 108;

type Car = {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  yawRate: number;
  steer: number;
  rpm: number;
  ax: number;
  ay: number;
  pitch: number;
  roll: number;
  wheelSpin: number;
  hp: number;
  invuln: number;
  fireCool: number;
  gunSide: number;
  lap: number;
  lastS: number;
  cp: number;
  group: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Object3D[];
  color: number;
  lineLat: number;
  pace: number;
  name: string;
  wantFire: boolean;
  maneuver: DriveManeuver;
  bar: THREE.Group;
  barFill: THREE.Mesh;
};

type Bullet = {
  mesh: THREE.Mesh;
  vx: number;
  vz: number;
  life: number;
  alive: boolean;
  owner: "you" | "jev";
  shooter: Car | null;
};

const keys = new Set<string>();
function codeFrom(e: KeyboardEvent): string {
  if (e.code) return e.code;
  const k = e.key.toLowerCase();
  if (k === "w") return "KeyW";
  if (k === "a") return "KeyA";
  if (k === "s") return "KeyS";
  if (k === "d") return "KeyD";
  if (k === " ") return "Space";
  if (k === "shift") return "ShiftLeft";
  if (k === "r") return "KeyR";
  return "";
}
window.addEventListener("keydown", (e) => {
  const code = codeFrom(e);
  if (code) keys.add(code);
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(code || e.code)) e.preventDefault();
});
window.addEventListener("keyup", (e) => keys.delete(codeFrom(e) || e.code));

function held(code: string): boolean {
  return keys.has(code);
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

function makeGunShot(ctx: AudioContext): AudioBuffer {
  const dur = 0.22;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / ctx.sampleRate;
    const white = Math.random() * 2 - 1;
    lp = lp * 0.72 + white * 0.28;
    const crack = white * Math.exp(-t * 220) * (t < 0.011 ? 1.35 : 0.12);
    const body = lp * Math.exp(-t * 22) * 0.85 * Math.sin(Math.PI * 2 * (70 + t * 40) * t);
    const shell = t > 0.012 && t < 0.05 ? white * 0.22 * Math.exp(-(t - 0.012) * 90) : 0;
    const air = white * 0.08 * Math.exp(-t * 14);
    let s = crack + body + shell + air;
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    d[i] = s;
  }
  return buf;
}

type CarAudio = {
  ctx: AudioContext;
  master: GainNode;
  rumble: OscillatorNode;
  rumbleGain: GainNode;
  eng: OscillatorNode;
  eng2: OscillatorNode;
  eng3: OscillatorNode;
  scream: OscillatorNode;
  screamGain: GainNode;
  engGain: GainNode;
  engFilt: BiquadFilterNode;
  exhaust: GainNode;
  exhaustFilter: BiquadFilterNode;
  intakeGain: GainNode;
  intakeFilter: BiquadFilterNode;
  skidGain: GainNode;
  skidFilter: BiquadFilterNode;
  crowdGain: GainNode;
  crowdFilter: BiquadFilterNode;
  foeEng: OscillatorNode;
  foeEng2: OscillatorNode;
  foeGain: GainNode;
  sampleGain: GainNode;
  sampleSrc: AudioBufferSourceNode | null;
  gunBuf: AudioBuffer;
};

function loopNoise(ctx: AudioContext, dest: AudioNode, pink: boolean): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 1.8, pink);
  src.loop = true;
  src.connect(dest);
  src.start();
  return src;
}

function createAudio(): CarAudio {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.52;
  master.connect(ctx.destination);

  const sampleGain = ctx.createGain();
  sampleGain.gain.value = 0.0001;
  sampleGain.connect(master);

  const rumble = ctx.createOscillator();
  rumble.type = "sine";
  rumble.frequency.value = 55;
  const rumbleGain = ctx.createGain();
  rumbleGain.gain.value = 0.0001;
  rumble.connect(rumbleGain);
  rumbleGain.connect(master);

  const engGain = ctx.createGain();
  engGain.gain.value = 0.0001;
  const engFilt = ctx.createBiquadFilter();
  engFilt.type = "bandpass";
  engFilt.frequency.value = 420;
  engFilt.Q.value = 2.4;
  const eng = ctx.createOscillator();
  eng.type = "sawtooth";
  eng.frequency.value = 220;
  const eng2 = ctx.createOscillator();
  eng2.type = "sawtooth";
  eng2.frequency.value = 440;
  const eng2g = ctx.createGain();
  eng2g.gain.value = 0.35;
  const eng3 = ctx.createOscillator();
  eng3.type = "square";
  eng3.frequency.value = 110;
  const eng3g = ctx.createGain();
  eng3g.gain.value = 0.08;
  eng.connect(engFilt);
  eng2.connect(eng2g);
  eng2g.connect(engFilt);
  eng3.connect(eng3g);
  eng3g.connect(engFilt);
  engFilt.connect(engGain);
  engGain.connect(master);

  const scream = ctx.createOscillator();
  scream.type = "triangle";
  scream.frequency.value = 880;
  const screamHp = ctx.createBiquadFilter();
  screamHp.type = "highpass";
  screamHp.frequency.value = 700;
  const screamGain = ctx.createGain();
  screamGain.gain.value = 0.0001;
  scream.connect(screamHp);
  screamHp.connect(screamGain);
  screamGain.connect(master);

  const exhaustFilter = ctx.createBiquadFilter();
  exhaustFilter.type = "bandpass";
  exhaustFilter.frequency.value = 520;
  exhaustFilter.Q.value = 1.15;
  const exhaust = ctx.createGain();
  exhaust.gain.value = 0.0001;
  loopNoise(ctx, exhaustFilter, true);
  exhaustFilter.connect(exhaust);
  exhaust.connect(master);

  const intakeFilter = ctx.createBiquadFilter();
  intakeFilter.type = "highpass";
  intakeFilter.frequency.value = 1400;
  const intakeGain = ctx.createGain();
  intakeGain.gain.value = 0.0001;
  loopNoise(ctx, intakeFilter, false);
  intakeFilter.connect(intakeGain);
  intakeGain.connect(master);

  const skidFilter = ctx.createBiquadFilter();
  skidFilter.type = "bandpass";
  skidFilter.frequency.value = 1600;
  skidFilter.Q.value = 1.2;
  const skidGain = ctx.createGain();
  skidGain.gain.value = 0.0001;
  loopNoise(ctx, skidFilter, true);
  skidFilter.connect(skidGain);
  skidGain.connect(master);

  const crowdFilter = ctx.createBiquadFilter();
  crowdFilter.type = "bandpass";
  crowdFilter.frequency.value = 780;
  crowdFilter.Q.value = 0.55;
  const crowdGain = ctx.createGain();
  crowdGain.gain.value = 0.055;
  loopNoise(ctx, crowdFilter, true);
  crowdFilter.connect(crowdGain);
  crowdGain.connect(master);

  const foeFilt = ctx.createBiquadFilter();
  foeFilt.type = "bandpass";
  foeFilt.frequency.value = 700;
  foeFilt.Q.value = 2;
  const foeEng = ctx.createOscillator();
  foeEng.type = "sawtooth";
  foeEng.frequency.value = 280;
  const foeEng2 = ctx.createOscillator();
  foeEng2.type = "triangle";
  foeEng2.frequency.value = 560;
  const foe2g = ctx.createGain();
  foe2g.gain.value = 0.28;
  const foeGain = ctx.createGain();
  foeGain.gain.value = 0.0001;
  foeEng.connect(foeFilt);
  foeEng2.connect(foe2g);
  foe2g.connect(foeFilt);
  foeFilt.connect(foeGain);
  foeGain.connect(master);

  rumble.start();
  eng.start();
  eng2.start();
  eng3.start();
  scream.start();
  foeEng.start();
  foeEng2.start();
  return {
    ctx,
    master,
    rumble,
    rumbleGain,
    eng,
    eng2,
    eng3,
    scream,
    screamGain,
    engGain,
    engFilt,
    exhaust,
    exhaustFilter,
    intakeGain,
    intakeFilter,
    skidGain,
    skidFilter,
    crowdGain,
    crowdFilter,
    foeEng,
    foeEng2,
    foeGain,
    sampleGain,
    sampleSrc: null,
    gunBuf: makeGunShot(ctx),
  };
}

function playGun(audio: CarAudio, shooter?: Car): void {
  const { ctx, master, gunBuf } = audio;
  const now = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = gunBuf;
  src.playbackRate.value = 0.92 + Math.random() * 0.16;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 280 + Math.random() * 120;
  const bp = ctx.createBiquadFilter();
  bp.type = "peaking";
  bp.frequency.value = 1400;
  bp.Q.value = 0.9;
  bp.gain.value = 4.5;
  const g = ctx.createGain();
  let vol = 0.72;
  if (shooter && shooter !== you) {
    const view = you.hp > 0 ? you : livingFoes()[0] ?? you;
    const dist = Math.hypot(shooter.x - view.x, shooter.z - view.z);
    vol = 0.22 / (1 + dist * 0.035);
  }
  g.gain.setValueAtTime(vol, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  src.connect(hp);
  hp.connect(bp);
  bp.connect(g);
  g.connect(master);

  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(118, now);
  thump.frequency.exponentialRampToValueAtTime(38, now + 0.06);
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(vol * 0.45, now);
  tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
  thump.connect(tg);
  tg.connect(master);
  src.start(now);
  thump.start(now);
  src.stop(now + 0.2);
  thump.stop(now + 0.08);
}

function playBoom(audio: CarAudio): void {
  const { ctx, master } = audio;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.35, true);
  const lo = ctx.createBiquadFilter();
  lo.type = "lowpass";
  lo.frequency.value = 500;
  const g = ctx.createGain();
  const now = ctx.currentTime;
  g.gain.setValueAtTime(0.7, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
  src.connect(lo);
  lo.connect(g);
  g.connect(master);
  src.start(now);
  src.stop(now + 0.34);
}

function playHit(audio: CarAudio): void {
  const { ctx, master } = audio;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.16, true);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 680;
  bp.Q.value = 0.8;
  const g = ctx.createGain();
  const now = ctx.currentTime;
  g.gain.setValueAtTime(0.55, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  src.start(now);
  src.stop(now + 0.16);
}

function playCheer(a: CarAudio, amount = 0.55): void {
  const { ctx, master } = a;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 1.4, true);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 920;
  bp.Q.value = 0.45;
  const g = ctx.createGain();
  const now = ctx.currentTime;
  g.gain.setValueAtTime(amount, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  src.start(now);
  src.stop(now + 1.3);
}

let audio: CarAudio | null = null;
async function attachEngineClip(a: CarAudio): Promise<void> {
  const res = await fetch("/sounds.mp3");
  if (!res.ok) return;
  const buf = await a.ctx.decodeAudioData(await res.arrayBuffer());
  const src = a.ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.loopStart = 3;
  src.loopEnd = Math.min(buf.duration, 16);
  src.connect(a.sampleGain);
  src.start();
  a.sampleSrc = src;
}

function ensureAudio(): void {
  if (audio) {
    if (audio.ctx.state === "suspended") void audio.ctx.resume();
    return;
  }
  audio = createAudio();
  void attachEngineClip(audio);
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.98;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8aa8c4);
scene.fog = new THREE.FogExp2(0x8aa8c4, 0.00072);

const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.2, 2400);
camera.matrixAutoUpdate = true;

const sky = new Sky();
sky.scale.setScalar(1400);
scene.add(sky);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 3.4;
skyU.rayleigh.value = 2.35;
skyU.mieCoefficient.value = 0.0032;
skyU.mieDirectionalG.value = 0.86;
const sunSpherical = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(72), THREE.MathUtils.degToRad(210));
skyU.sunPosition.value.copy(sunSpherical);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(sky as unknown as THREE.Scene).texture;
scene.environmentIntensity = 0.62;

const hemi = new THREE.HemisphereLight(0xd7e8f8, 0x3a4a28, 0.78);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe8c4, 2.05);
sun.position.copy(sunSpherical).multiplyScalar(160);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 8;
sun.shadow.camera.far = 520;
sun.shadow.camera.left = -160;
sun.shadow.camera.right = 160;
sun.shadow.camera.top = 160;
sun.shadow.camera.bottom = -160;
sun.shadow.bias = -0.00025;
scene.add(sun, sun.target);

function makeAsphalt(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(512, 512);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    img.data[i] = 42 + n;
    img.data[i + 1] = 44 + n;
    img.data[i + 2] = 48 + n;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.repeat.set(1, 18);
  return tex;
}

function makeGrassTex(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = Math.random();
    img.data[i] = 48 + n * 46;
    img.data[i + 1] = 92 + n * 58;
    img.data[i + 2] = 28 + n * 24;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(72, 72);
  return tex;
}

function makeCrowdTex(): THREE.CanvasTexture {
  const W = 1024;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#2a3038";
  ctx.fillRect(0, 0, W, H);
  const skins = ["#f3d5b5", "#e8c4a0", "#c68642", "#8d5524", "#ffdeb4", "#d1a37a", "#6b3f24", "#f0c8b0"];
  const hair = ["#1a1410", "#3b2a1a", "#6b4a2a", "#111111", "#c4c4c8", "#4a3020", "#2c1a12"];
  const shirts = [
    "#c62828", "#b71c1c", "#1565c0", "#0d47a1", "#2e7d32", "#1b5e20", "#f5f5f0", "#eceff1", "#212121",
    "#37474f", "#ef6c00", "#6a1b9a", "#00838f", "#ad1457", "#5d4037", "#455a64", "#f9a825", "#263238",
    "#880e4f", "#1a237e", "#33691e", "#bf360c", "#4e342e", "#78909c",
  ];
  const rows = 28;
  const cols = 42;
  const rh = H / rows;
  const cw = W / cols;
  for (let r = 0; r < rows; r++) {
    ctx.fillStyle = r % 2 ? "#323844" : "#2c323c";
    ctx.fillRect(0, r * rh, W, rh);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(0, r * rh, W, 3);
    for (let k = 0; k < cols; k++) {
      if (Math.random() < 0.04) continue;
      const x = k * cw + cw * 0.5 + (Math.random() - 0.5) * cw * 0.35;
      const y = r * rh + rh * 0.62 + (Math.random() - 0.5) * rh * 0.12;
      ctx.fillStyle = shirts[(Math.random() * shirts.length) | 0]!;
      ctx.beginPath();
      ctx.ellipse(x, y + 4, cw * 0.28, rh * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = skins[(Math.random() * skins.length) | 0]!;
      ctx.beginPath();
      ctx.ellipse(x, y - rh * 0.18, cw * 0.16, rh * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hair[(Math.random() * hair.length) | 0]!;
      ctx.beginPath();
      ctx.ellipse(x, y - rh * 0.26, cw * 0.17, rh * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

const asphalt = makeAsphalt();
type Sample = {
  x: number;
  z: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  s: number;
  kappa: number;
};

function buildStadium(): Sample[] {
  const W = OVAL_W;
  const L = OVAL_L;
  const step = 2.4;
  const raw: { x: number; z: number; tx: number; tz: number; kappa: number }[] = [];
  for (let z = -L; z < L; z += step) raw.push({ x: W, z, tx: 0, tz: 1, kappa: 0 });
  const arcN = Math.max(20, Math.round((Math.PI * W) / step));
  for (let i = 0; i <= arcN; i++) {
    const t = (i / arcN) * Math.PI;
    raw.push({ x: W * Math.cos(t), z: L + W * Math.sin(t), tx: -Math.sin(t), tz: Math.cos(t), kappa: 1 / W });
  }
  for (let z = L; z > -L; z -= step) raw.push({ x: -W, z, tx: 0, tz: -1, kappa: 0 });
  for (let i = 0; i <= arcN; i++) {
    const t = Math.PI + (i / arcN) * Math.PI;
    raw.push({ x: W * Math.cos(t), z: -L + W * Math.sin(t), tx: -Math.sin(t), tz: Math.cos(t), kappa: 1 / W });
  }
  const out: Sample[] = [];
  let sAcc = 0;
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i]!;
    out.push({ x: p.x, z: p.z, tx: p.tx, tz: p.tz, nx: p.tz, nz: -p.tx, s: sAcc, kappa: p.kappa });
    const q = raw[(i + 1) % raw.length]!;
    sAcc += Math.hypot(q.x - p.x, q.z - p.z);
  }
  return out;
}

const samples = buildStadium();
const TRACK_LEN = samples[samples.length - 1]!.s + Math.hypot(samples[0]!.x - samples[samples.length - 1]!.x, samples[0]!.z - samples[samples.length - 1]!.z);

function nearest(x: number, z: number): Sample & { i: number; lat: number } {
  let best = 0;
  let bestD = 1e12;
  for (let i = 0; i < samples.length; i += 2) {
    const p = samples[i]!;
    const d = (x - p.x) ** 2 + (z - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  for (let k = -5; k <= 5; k++) {
    const i = (best + k + samples.length) % samples.length;
    const p = samples[i]!;
    const d = (x - p.x) ** 2 + (z - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const p = samples[best]!;
  return { ...p, i: best, lat: (x - p.x) * p.nx + (z - p.z) * p.nz };
}

function poseAt(s: number, lat: number): { x: number; z: number; yaw: number; s: number } {
  let u = s % TRACK_LEN;
  if (u < 0) u += TRACK_LEN;
  let best = 0;
  let bd = 1e12;
  for (let i = 0; i < samples.length; i += 2) {
    const d = Math.abs(samples[i]!.s - u);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  const p = samples[best]!;
  return { x: p.x + p.nx * lat, z: p.z + p.nz * lat, yaw: Math.atan2(p.tx, p.tz), s: p.s };
}

function lookAhead(fromS: number, dist: number, lat: number): { x: number; z: number } {
  return poseAt(fromS + dist, lat);
}

const FINISH_S = nearest(OVAL_W, 0).s;

function ribbon(half: number, y: number, mat: THREE.Material): void {
  const n = samples.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = samples[i]!;
    pos.push(p.x + p.nx * half, y, p.z + p.nz * half, p.x - p.nx * half, y, p.z - p.nz * half);
    uv.push(0, p.s * 0.08, 1, p.s * 0.08);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
}

asphalt.repeat.set(1, 36);
const grass = new THREE.Mesh(
  new THREE.PlaneGeometry(700, 700),
  new THREE.MeshStandardMaterial({ color: 0x4f7a38, map: makeGrassTex(), roughness: 1 }),
);
grass.rotation.x = -Math.PI / 2;
grass.position.y = -0.08;
grass.receiveShadow = true;
scene.add(grass);

ribbon(HALF_W + 0.2, 0.02, new THREE.MeshStandardMaterial({ color: 0x4a4e55, map: asphalt, roughness: 0.82, metalness: 0.08 }));
const lineMat = new THREE.MeshBasicMaterial({ color: 0xf4f4f0, side: THREE.DoubleSide });
function edgeLine(side: number): void {
  const n = samples.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = samples[i]!;
    const ox = p.nx * side * (HALF_W - 0.28);
    const oz = p.nz * side * (HALF_W - 0.28);
    pos.push(p.x + ox + p.nx * 0.09, 0.04, p.z + oz + p.nz * 0.09, p.x + ox - p.nx * 0.09, 0.04, p.z + oz - p.nz * 0.09);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  scene.add(new THREE.Mesh(g, lineMat));
}
edgeLine(1);
edgeLine(-1);

const wallMat = new THREE.MeshStandardMaterial({ color: 0x5c646c, roughness: 0.55, metalness: 0.35 });
for (let i = 0; i < samples.length; i += 2) {
  const p = samples[i]!;
  for (const side of [-1, 1] as const) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.15, 5.2), wallMat);
    m.position.set(p.x + p.nx * side * BARRIER, 0.58, p.z + p.nz * side * BARRIER);
    m.rotation.y = Math.atan2(p.tx, p.tz);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }
}

const finish = nearest(OVAL_W, 0);
const gantry = new THREE.Group();
gantry.position.set(finish.x, 0, finish.z);
gantry.rotation.y = Math.atan2(finish.tx, finish.tz);
const poleL = new THREE.Mesh(new THREE.BoxGeometry(0.35, 9, 0.35), wallMat);
poleL.position.set(-10, 4.5, 0);
const poleR = poleL.clone();
poleR.position.x = 10;
const beam = new THREE.Mesh(new THREE.BoxGeometry(21, 0.45, 0.55), new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.4, roughness: 0.4 }));
beam.position.y = 8.4;
gantry.add(poleL, poleR, beam);
const lights: THREE.Mesh[] = [];
for (let i = 0; i < 5; i++) {
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), new THREE.MeshBasicMaterial({ color: 0x2a1010 }));
  lamp.position.set(-4 + i * 2, 7.85, 0.4);
  gantry.add(lamp);
  lights.push(lamp);
}
scene.add(gantry);

const checkW = new THREE.MeshBasicMaterial({ color: 0xf4f4f0 });
const checkK = new THREE.MeshBasicMaterial({ color: 0x121214 });
for (let k = 0; k < 14; k++) {
  const stripe = new THREE.Mesh(new THREE.BoxGeometry((HALF_W * 2) / 14, 0.03, 1.15), k % 2 ? checkW : checkK);
  const lat = (k + 0.5) * ((HALF_W * 2) / 14) - HALF_W;
  stripe.position.set(finish.x + finish.nx * lat, 0.045, finish.z + finish.nz * lat);
  stripe.rotation.y = Math.atan2(finish.tx, finish.tz);
  scene.add(stripe);
}

function standDeck(latA: number, latB: number, yA: number, yB: number, mat: THREE.Material): void {
  const n = samples.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const span = Math.max(8, Math.abs(latB - latA) * 0.55);
  for (let i = 0; i < n; i++) {
    const p = samples[i]!;
    pos.push(p.x + p.nx * latA, yA, p.z + p.nz * latA, p.x + p.nx * latB, yB, p.z + p.nz * latB);
    uv.push(p.s * 0.22, 0, p.s * 0.22, span);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  scene.add(mesh);
}

const STAD_IN = BARRIER + 2.4;
const STAD_MID = STAD_IN + 16;
const STAD_OUT = STAD_IN + 32;
const concrete = new THREE.MeshStandardMaterial({ color: 0x6d7380, roughness: 0.92, metalness: 0.08 });
const concreteDark = new THREE.MeshStandardMaterial({ color: 0x3e4550, roughness: 0.88, metalness: 0.12 });
const crowdTex = makeCrowdTex();
const seatMat = new THREE.MeshStandardMaterial({
  color: 0xc8c4be,
  map: crowdTex,
  roughness: 0.92,
  metalness: 0.02,
  side: THREE.DoubleSide,
});
standDeck(STAD_IN, STAD_MID, 1.15, 12.4, seatMat);
standDeck(STAD_MID, STAD_OUT, 12.4, 24.2, seatMat);
standDeck(STAD_IN, STAD_IN + 0.55, 0.02, 1.15, concrete);
standDeck(STAD_OUT, STAD_OUT + 1.1, 0.02, 26.4, concreteDark);
standDeck(STAD_OUT - 2.2, STAD_OUT + 6.5, 26.2, 27.1, new THREE.MeshStandardMaterial({ color: 0x2a3038, metalness: 0.45, roughness: 0.4, side: THREE.DoubleSide }));
standDeck(-STAD_MID, -STAD_IN, 12.4, 1.15, seatMat);
standDeck(-STAD_OUT, -STAD_MID, 24.2, 12.4, seatMat);
standDeck(-STAD_IN, -STAD_IN - 0.55, 0.02, 1.15, concrete);
standDeck(-STAD_OUT, -STAD_OUT - 1.1, 0.02, 26.4, concreteDark);
standDeck(-STAD_OUT + 2.2, -STAD_OUT - 6.5, 26.2, 27.1, new THREE.MeshStandardMaterial({ color: 0x2a3038, metalness: 0.45, roughness: 0.4, side: THREE.DoubleSide }));

const floodMat = new THREE.MeshStandardMaterial({ color: 0xdde6f0, emissive: 0xf4f0d8, emissiveIntensity: 0.85, metalness: 0.4, roughness: 0.3 });
const mastMat = new THREE.MeshStandardMaterial({ color: 0x2c323a, metalness: 0.5, roughness: 0.4 });
for (const [sx, sz] of [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
] as const) {
  const x = sx * (OVAL_W + 22);
  const z = sz * (OVAL_L + 8);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.7, 38, 8), mastMat);
  mast.position.set(x, 19, z);
  mast.castShadow = true;
  scene.add(mast);
  const head = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.8, 2.2), floodMat);
  head.position.set(x, 38.2, z);
  head.lookAt(0, 8, 0);
  scene.add(head);
  const spot = new THREE.SpotLight(0xfff3d0, 38, 220, 0.55, 0.45, 1.1);
  spot.position.set(x, 37.5, z);
  spot.target.position.set(sx * OVAL_W * 0.4, 0, sz * OVAL_L * 0.35);
  scene.add(spot, spot.target);
}

const board = document.createElement("canvas");
board.width = 512;
board.height = 160;
const bctx = board.getContext("2d")!;
bctx.fillStyle = "#0b0d12";
bctx.fillRect(0, 0, 512, 160);
bctx.fillStyle = "#7cff6b";
bctx.font = "bold 54px sans-serif";
bctx.fillText("DRIVE GP", 48, 70);
bctx.fillStyle = "#f2f2f0";
bctx.font = "28px sans-serif";
bctx.fillText("3 LAPS  •  LIGHTS OUT", 48, 118);
const boardTex = new THREE.CanvasTexture(board);
boardTex.colorSpace = THREE.SRGBColorSpace;
const jumbo = new THREE.Mesh(
  new THREE.PlaneGeometry(28, 9),
  new THREE.MeshBasicMaterial({ map: boardTex }),
);
jumbo.position.set(-OVAL_W - 18, 18, 0);
jumbo.lookAt(0, 14, 0);
scene.add(jumbo);

function makeCar(paint: number): { group: THREE.Group; body: THREE.Group; wheels: THREE.Object3D[] } {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const paintMat = new THREE.MeshPhysicalMaterial({
    color: paint,
    metalness: 0.42,
    roughness: 0.28,
    clearcoat: 0.85,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.1,
  });
  const white = new THREE.MeshPhysicalMaterial({
    color: 0xf3efe6,
    metalness: 0.15,
    roughness: 0.35,
    clearcoat: 0.4,
  });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.42, metalness: 0.35 });
  const wing = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.38, metalness: 0.4 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xc9b44a, roughness: 0.45, metalness: 0.25 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xb08a3c, metalness: 0.85, roughness: 0.28 });

  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.05, 3.55), carbon);
  floor.position.set(0, 0.2, 0.08);
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.04, 0.55), yellow);
  splitter.position.set(0, 0.18, 2.55);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.22, 1.55), paintMat);
  nose.position.set(0, 0.48, 1.72);
  nose.rotation.x = 0.12;
  const noseWhite = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.14, 0.85), white);
  noseWhite.position.set(0, 0.52, 1.55);
  const noseTip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.42), carbon);
  noseTip.position.set(0, 0.36, 2.48);

  const fw = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.045, 0.52), wing);
  fw.position.set(0, 0.22, 2.72);
  const fw2 = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.035, 0.22), wing);
  fw2.position.set(0, 0.28, 2.58);
  const fwEndL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 0.55), wing);
  fwEndL.position.set(-1.02, 0.32, 2.7);
  const fwEndR = fwEndL.clone();
  fwEndR.position.x = 1.02;

  const tub = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.42, 1.55), paintMat);
  tub.position.set(0, 0.52, 0.28);
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.16, 0.7), carbon);
  cockpit.position.set(0, 0.74, 0.42);
  const roll = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.38, 0.16), paintMat);
  roll.position.set(0, 0.92, 0.12);
  const cam = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.18), carbon);
  cam.position.set(0, 1.08, 0.14);

  const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.38, 1.55), paintMat);
  sideL.position.set(-0.62, 0.42, -0.15);
  const sideR = sideL.clone();
  sideR.position.x = 0.62;
  const podTopL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 1.2), paintMat);
  podTopL.position.set(-0.58, 0.64, -0.2);
  const podTopR = podTopL.clone();
  podTopR.position.x = 0.58;

  const cover = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.32, 1.65), paintMat);
  cover.position.set(0, 0.62, -0.72);
  const airbox = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.28, 0.55), paintMat);
  airbox.position.set(0, 0.88, -0.55);

  const helm = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.28, metalness: 0.15 }),
  );
  helm.position.set(0, 0.86, 0.48);
  helm.scale.set(1, 1.08, 1.15);
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 10, 8, 0, Math.PI * 2, 0.4, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x1c242c, roughness: 0.15, metalness: 0.7 }),
  );
  visor.position.set(0, 0.86, 0.52);
  visor.scale.set(0.95, 0.7, 1.05);

  const rw = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.055, 0.38), wing);
  rw.position.set(0, 1.18, -1.72);
  const rw2 = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.04, 0.28), wing);
  rw2.position.set(0, 1.08, -1.68);
  const rwStripe = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.12, 0.04), white);
  rwStripe.position.set(0, 1.22, -1.54);
  const rwEndL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.85, 0.42), wing);
  rwEndL.position.set(-0.58, 0.82, -1.72);
  const rwEndR = rwEndL.clone();
  rwEndR.position.x = 0.58;
  const beamR = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.62, 0.07), carbon);
  beamR.position.set(0, 0.72, -1.62);
  const beamL = beamR.clone();
  beamL.position.x = -0.22;
  const beamC = beamR.clone();
  beamC.position.x = 0.22;

  const bargeL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.7), carbon);
  bargeL.position.set(-0.72, 0.34, 1.05);
  const bargeR = bargeL.clone();
  bargeR.position.x = 0.72;

  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.22, 8), gold);
  exhaust.rotation.x = Math.PI / 2;
  exhaust.position.set(0.18, 0.38, -1.85);
  const exhaust2 = exhaust.clone();
  exhaust2.position.x = -0.18;

  const parts = [
    floor,
    splitter,
    nose,
    noseWhite,
    noseTip,
    fw,
    fw2,
    fwEndL,
    fwEndR,
    tub,
    cockpit,
    roll,
    cam,
    sideL,
    sideR,
    podTopL,
    podTopR,
    cover,
    airbox,
    helm,
    visor,
    rw,
    rw2,
    rwStripe,
    rwEndL,
    rwEndR,
    beamR,
    beamL,
    beamC,
    bargeL,
    bargeR,
    exhaust,
    exhaust2,
  ];
  for (const o of parts) {
    o.castShadow = true;
    o.receiveShadow = true;
    body.add(o);
  }

  const wheels: THREE.Object3D[] = [];
  const dark = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.62 });
  const offsets: [number, number, number, number, number][] = [
    [-0.92, 0.36, 1.62, 0.36, 0.42],
    [0.92, 0.36, 1.62, 0.36, 0.42],
    [-0.95, 0.38, -1.38, 0.38, 0.52],
    [0.95, 0.38, -1.38, 0.38, 0.52],
  ];
  for (const [x, y, z, r, w] of offsets) {
    const tire = new THREE.CylinderGeometry(r, r, w, 22);
    tire.rotateZ(Math.PI / 2);
    const wheel = new THREE.Mesh(tire, dark);
    wheel.castShadow = true;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.42, r * 0.42, w + 0.04, 14), gold);
    hub.rotation.z = Math.PI / 2;
    wheel.add(hub);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(r * 0.78, 0.025, 6, 16), gold);
    lip.rotation.y = Math.PI / 2;
    wheel.add(lip);
    const hubArm = new THREE.Group();
    hubArm.position.set(x, y, z);
    hubArm.add(wheel);
    group.add(hubArm);
    wheels.push(wheel);
  }
  scene.add(group);
  return { group, body, wheels };
}

function makeHpBar(paint: number): { bar: THREE.Group; barFill: THREE.Mesh } {
  const bar = new THREE.Group();
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(1.55, 0.16),
    new THREE.MeshBasicMaterial({ color: 0x111318, depthTest: false, transparent: true, opacity: 0.72 }),
  );
  const barFill = new THREE.Mesh(
    new THREE.PlaneGeometry(1.45, 0.1),
    new THREE.MeshBasicMaterial({ color: paint, depthTest: false }),
  );
  barFill.position.z = 0.01;
  const rim = new THREE.Mesh(
    new THREE.PlaneGeometry(1.57, 0.18),
    new THREE.MeshBasicMaterial({ color: 0xf4f4f0, depthTest: false, transparent: true, opacity: 0.35 }),
  );
  rim.position.z = -0.01;
  bar.add(rim, bg, barFill);
  bar.renderOrder = 20;
  scene.add(bar);
  return { bar, barFill };
}

function createCar(
  paint: number,
  x: number,
  z: number,
  yaw: number,
  extra: { name: string; lineLat: number; pace: number },
): Car {
  const vis = makeCar(paint);
  const hp = makeHpBar(paint);
  hp.bar.visible = extra.name !== "YOU";
  return {
    x,
    z,
    yaw,
    vx: 0,
    vz: 0,
    yawRate: 0,
    steer: 0,
    rpm: 4200,
    ax: 0,
    ay: 0,
    pitch: 0,
    roll: 0,
    wheelSpin: 0,
    hp: MAX_HP,
    invuln: 0,
    fireCool: 0,
    gunSide: 0,
    lap: 0,
    lastS: 0,
    cp: 0,
    group: vis.group,
    body: vis.body,
    wheels: vis.wheels,
    color: paint,
    lineLat: extra.lineLat,
    pace: extra.pace,
    name: extra.name,
    wantFire: false,
    maneuver: "chase",
    bar: hp.bar,
    barFill: hp.barFill,
  };
}

const gridYou = poseAt(FINISH_S + 14, -2.2);
const you = createCar(0xc9a227, gridYou.x, gridYou.z, gridYou.yaw, { name: "YOU", lineLat: -2.2, pace: 1 });
you.lastS = gridYou.s;
const FOE_GRID = [
  { ds: 10, lat: 2.3, paint: 0xb5121b, name: "JEV-1", lineLat: 2.1, pace: 1.02 },
  { ds: 5, lat: -3.5, paint: 0x1e4fa3, name: "JEV-2", lineLat: -2.15, pace: 1 },
  { ds: 1, lat: 3.7, paint: 0xd45a12, name: "JEV-3", lineLat: 3.45, pace: 0.98 },
  { ds: -3, lat: -1.2, paint: 0x2f8a3a, name: "JEV-4", lineLat: -3.5, pace: 1.04 },
] as const;
const foes = FOE_GRID.map((g) => {
  const p = poseAt(FINISH_S + g.ds, g.lat);
  const c = createCar(g.paint, p.x, p.z, p.yaw, { name: g.name, lineLat: g.lineLat, pace: g.pace });
  c.lastS = p.s;
  return c;
});
function field(): Car[] {
  return [you, ...foes];
}
function livingFoes(): Car[] {
  return foes.filter((f) => f.hp > 0);
}
function closestFoe(): Car {
  const live = livingFoes();
  if (!live.length) return foes[0]!;
  return live.reduce((a, b) => (Math.hypot(a.x - you.x, a.z - you.z) < Math.hypot(b.x - you.x, b.z - you.z) ? a : b));
}

const jevBarsRoot = document.querySelector("#jev-bars");
const jevBarUi = foes.map((f) => {
  const row = document.createElement("div");
  row.className = "jev-bar";
  const label = document.createElement("span");
  label.textContent = f.name;
  const track = document.createElement("i");
  const fill = document.createElement("em");
  fill.style.background = `#${f.color.toString(16).padStart(6, "0")}`;
  track.append(fill);
  row.append(label, track);
  jevBarsRoot?.append(row);
  return { row, fill };
});

function syncHpUi(c: Car): void {
  const t = THREE.MathUtils.clamp(c.hp / MAX_HP, 0, 1);
  c.bar.visible = c !== you && c.hp > 0;
  if (c.bar.visible) {
    c.bar.position.set(c.x, 2.05, c.z);
    c.bar.quaternion.copy(camera.quaternion);
    c.barFill.scale.x = Math.max(0.02, t);
    c.barFill.position.x = -0.725 * (1 - t);
    (c.barFill.material as THREE.MeshBasicMaterial).color.setHex(t > 0.4 ? c.color : 0xff3b30);
  }
  const i = foes.indexOf(c);
  const ui = jevBarUi[i];
  if (!ui) return;
  ui.fill.style.transform = `scaleX(${t})`;
  ui.row.classList.toggle("is-out", c.hp <= 0);
}

const bulletGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.65, 5);
bulletGeo.rotateX(Math.PI / 2);
const youBulletMat = new THREE.MeshBasicMaterial({ color: 0xfff1a8 });
const jevBulletMat = new THREE.MeshBasicMaterial({ color: 0xff5a3a });
const bullets: Bullet[] = [];
for (let i = 0; i < 48; i++) {
  const mesh = new THREE.Mesh(bulletGeo, youBulletMat);
  mesh.visible = false;
  scene.add(mesh);
  bullets.push({ mesh, vx: 0, vz: 0, life: 0, alive: false, owner: "you", shooter: null });
}

type Spark = {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  alive: boolean;
};
const sparkGeo = new THREE.SphereGeometry(0.11, 6, 5);
const sparks: Spark[] = [];
for (let i = 0; i < 80; i++) {
  const mesh = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 1, depthWrite: false }));
  mesh.visible = false;
  scene.add(mesh);
  sparks.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0, max: 0.3, alive: false });
}

function explodeAt(x: number, y: number, z: number): void {
  let n = 0;
  for (const p of sparks) {
    if (p.alive) continue;
    p.alive = true;
    p.max = 0.22 + Math.random() * 0.16;
    p.life = p.max;
    const a = Math.random() * Math.PI * 2;
    const u = 3 + Math.random() * 9;
    p.vx = Math.cos(a) * u;
    p.vz = Math.sin(a) * u;
    p.vy = 3 + Math.random() * 8;
    p.mesh.position.set(x, y, z);
    p.mesh.scale.setScalar(0.7 + Math.random() * 1.4);
    p.mesh.visible = true;
    (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(Math.random() > 0.45 ? 0xffe066 : 0xff4a1a);
    (p.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    n += 1;
    if (n >= 12) break;
  }
  camShake = Math.min(0.55, camShake + 0.16);
  if (audio) playHit(audio);
}

function stepSparks(dt: number): void {
  for (const p of sparks) {
    if (!p.alive) continue;
    p.life -= dt;
    p.vy -= 22 * dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    const t = Math.max(0, p.life / p.max);
    (p.mesh.material as THREE.MeshBasicMaterial).opacity = t;
    p.mesh.scale.setScalar(0.4 + (1 - t) * 1.6);
    if (p.life <= 0 || p.mesh.position.y < 0) {
      p.alive = false;
      p.mesh.visible = false;
    }
  }
}

function segmentHitsCar(ox: number, oz: number, nx: number, nz: number, car: Car): { x: number; z: number } | null {
  const dx = nx - ox;
  const dz = nz - oz;
  const len2 = dx * dx + dz * dz || 0.0001;
  let t = ((car.x - ox) * dx + (car.z - oz) * dz) / len2;
  t = THREE.MathUtils.clamp(t, 0, 1);
  const hx = ox + dx * t;
  const hz = oz + dz * t;
  if (Math.hypot(hx - car.x, hz - car.z) > HIT_R) return null;
  return { x: hx, z: hz };
}

const SKID_N = 180;
const skidGeo = new THREE.PlaneGeometry(0.16, 0.42);
const skidMat = new THREE.MeshBasicMaterial({ color: 0x121212, transparent: true, opacity: 0.38, depthWrite: false });
const skids = new THREE.InstancedMesh(skidGeo, skidMat, SKID_N);
skids.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(skids);
const skidDummy = new THREE.Object3D();
let skidI = 0;
let skidAcc = 0;
for (let i = 0; i < SKID_N; i++) {
  skidDummy.position.set(0, -4, 0);
  skidDummy.rotation.set(-Math.PI / 2, 0, 0);
  skidDummy.updateMatrix();
  skids.setMatrixAt(i, skidDummy.matrix);
}
skids.instanceMatrix.needsUpdate = true;

function headingDeg(yaw: number): number {
  return Math.round((((yaw * 180) / Math.PI + 360) % 360));
}

function angDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function trackFaceYaw(c: Car, n: Sample): number {
  const ty = Math.atan2(n.tx, n.tz);
  return Math.abs(angDiff(ty, c.yaw)) > Math.PI * 0.55 ? ty + Math.PI : ty;
}

function trackDir(c: Car, n: Sample): number {
  const along = c.vx * n.tx + c.vz * n.tz;
  if (Math.abs(along) > 0.4) return Math.sign(along);
  const face = Math.sin(c.yaw) * n.tx + Math.cos(c.yaw) * n.tz;
  return face >= 0 ? 1 : -1;
}

function railToRoad(c: Car, dt: number): void {
  const n = nearest(c.x, c.z);
  const limit = BARRIER - 0.9;
  if (Math.abs(n.lat) <= limit) return;

  const clamped = THREE.MathUtils.clamp(n.lat, -limit, limit);
  c.x = n.x + n.nx * clamped;
  c.z = n.z + n.nz * clamped;

  const across = c.vx * n.nx + c.vz * n.nz;
  const into = n.lat > 0 ? across : -across;
  const onCurve = n.kappa > 0.002 && into > 0.15;

  if (onCurve) {
    const spd = Math.hypot(c.vx, c.vz);
    const dir = trackDir(c, n);
    const err = angDiff(trackFaceYaw(c, n), c.yaw);
    const blend = 1 - Math.exp(-26 * dt);
    c.yaw += err * blend;
    c.yawRate *= 0.55;
    const keep = spd * (1 - Math.min(0.1, Math.max(0, into) / Math.max(10, spd) * 0.16));
    c.vx = n.tx * dir * keep;
    c.vz = n.tz * dir * keep;
    camShake = Math.min(0.16, camShake + 0.025);
    return;
  }

  if (into > 0) {
    c.vx -= n.nx * across;
    c.vz -= n.nz * across;
  }
}

function longLat(c: Car): { long: number; lat: number; s: number; cs: number } {
  const s = Math.sin(c.yaw);
  const cs = Math.cos(c.yaw);
  return { long: c.vx * s + c.vz * cs, lat: c.vx * cs - c.vz * s, s, cs };
}

function pacejka(slip: number, peak: number): number {
  const a = THREE.MathUtils.clamp(slip, -1.05, 1.05);
  return peak * Math.sin(1.22 * Math.atan(6.1 * a));
}

function onPavement(x: number, z: number): boolean {
  return Math.abs(nearest(x, z).lat) < HALF_W + 0.2;
}

function wallDist(c: Car): number {
  return Math.max(0.05, BARRIER - Math.abs(nearest(c.x, c.z).lat));
}

function raceProgress(c: Car): number {
  const s = nearest(c.x, c.z).s;
  let u = s - FINISH_S;
  if (u < 0) u += TRACK_LEN;
  return c.lap * TRACK_LEN + u;
}

function cornerKind(c: Car): "straight" | "entry" | "apex" | "exit" {
  return nearest(c.x, c.z).kappa > 0.004 ? "apex" : "straight";
}

function racePlace(c: Car): number {
  const mine = raceProgress(c);
  let place = 1;
  for (const o of field()) {
    if (o !== c && o.hp > 0 && raceProgress(o) > mine) place += 1;
  }
  return place;
}

function drawMap(): void {
  const w = mapCanvas.width;
  const h = mapCanvas.height;
  mapCtx.clearRect(0, 0, w, h);
  mapCtx.fillStyle = "rgba(10, 16, 22, 0.55)";
  mapCtx.fillRect(0, 0, w, h);
  const maxX = OVAL_W + 16;
  const maxZ = OVAL_L + OVAL_W + 8;
  const s = Math.min((w - 22) / (maxX * 2), (h - 22) / (maxZ * 2));
  const px = (x: number) => w / 2 + x * s;
  const py = (z: number) => h / 2 + z * s;
  mapCtx.strokeStyle = "#5c646c";
  mapCtx.lineWidth = 9;
  mapCtx.lineJoin = "round";
  mapCtx.beginPath();
  for (let i = 0; i < samples.length; i += 2) {
    const p = samples[i]!;
    if (i === 0) mapCtx.moveTo(px(p.x), py(p.z));
    else mapCtx.lineTo(px(p.x), py(p.z));
  }
  mapCtx.closePath();
  mapCtx.stroke();
  mapCtx.strokeStyle = "#8a9098";
  mapCtx.lineWidth = 5;
  mapCtx.stroke();
  const fin = nearest(OVAL_W, 0);
  mapCtx.strokeStyle = "#f4f4f0";
  mapCtx.lineWidth = 2;
  mapCtx.beginPath();
  mapCtx.moveTo(px(fin.x + fin.nx * 8), py(fin.z + fin.nz * 8));
  mapCtx.lineTo(px(fin.x - fin.nx * 8), py(fin.z - fin.nz * 8));
  mapCtx.stroke();
  const dots: { c: Car; r: number }[] = [...livingFoes().map((c) => ({ c, r: 3.2 })), { c: you, r: 4.2 }];
  for (const { c, r } of dots) {
    mapCtx.beginPath();
    mapCtx.fillStyle = c.hp <= 0 ? "#555" : `#${c.color.toString(16).padStart(6, "0")}`;
    mapCtx.arc(px(c.x), py(c.z), r, 0, Math.PI * 2);
    mapCtx.fill();
    if (c === you) {
      mapCtx.strokeStyle = "#fff8d6";
      mapCtx.lineWidth = 1.4;
      mapCtx.stroke();
    }
  }
}

function advanceLap(c: Car): void {
  if (c.hp <= 0) return;
  const s = nearest(c.x, c.z).s;
  const prev = c.lastS;
  c.lastS = s;
  let ds = s - prev;
  if (ds > TRACK_LEN * 0.5) ds -= TRACK_LEN;
  if (ds < -TRACK_LEN * 0.5) ds += TRACK_LEN;
  if (ds > 0 && ds < 50 && prev < FINISH_S && s >= FINISH_S) c.lap += 1;
}

type DriveIn = { throttle: number; brake: number; steer: number; ebrake: boolean };

function stepCar(c: Car, dt: number, input: DriveIn): void {
  const speed = Math.hypot(c.vx, c.vz);
  const pre = nearest(c.x, c.z);
  const curve = pre.kappa > 0.0025;
  const steerCap = MAX_STEER / (1 + speed * speed * (curve ? 0.00038 : 0.00115));
  c.steer += (input.steer * steerCap - c.steer) * Math.min(1, 6.2 * dt);
  const { long, lat } = longLat(c);
  const down = 1 + 0.00055 * speed * speed;
  const paved = onPavement(c.x, c.z);
  const vmax = paved ? VMAX : GRASS_VMAX;
  const eng = input.throttle * ENGINE * (1 - THREE.MathUtils.clamp(Math.abs(long) / vmax, 0, 0.94));
  const drag = (DRAG + 0.0011 * speed) * long * Math.abs(long) + ROLL * Math.sign(long) * (speed > 0.2 ? 1 : 0);
  let Fx = eng - drag;
  const stopCap = (Math.abs(long) * MASS) / Math.max(dt, 1 / 240);
  if (input.brake > 0 && Math.abs(long) > 0.12) {
    Fx -= Math.sign(long) * Math.min(input.brake * BRAKE_F, stopCap * 0.92);
  }
  if (input.ebrake && Math.abs(long) > 0.12) {
    Fx -= Math.sign(long) * Math.min(4200 * Math.min(1, speed), stopCap * 0.35);
  }
  if (!paved) Fx *= 0.22;
  const axBody = Fx / MASS;
  let Fzf = MASS * G * (B / (A + B)) * down - MASS * axBody * 0.16;
  let Fzr = MASS * G * (A / (A + B)) * down + MASS * axBody * 0.16;
  Fzf = Math.max(400, Fzf);
  Fzr = Math.max(380, Fzr);
  const vf = Math.max(0.55, Math.abs(long));
  const slipF = c.steer - Math.atan2(lat + c.yawRate * A, vf);
  const slipR = -Math.atan2(lat - c.yawRate * B, vf);
  const grip = paved ? 1 : 0.28;
  const rearMul = input.ebrake ? 0.55 : 1;
  const Fyf = pacejka(slipF, CA_F * (Fzf / (MASS * G * 0.5))) * grip;
  const Fyr = pacejka(slipR, CA_R * (Fzr / (MASS * G * 0.5))) * rearMul * grip;
  const ayBody = (Fyf + Fyr) / MASS;
  const yawAcc = (A * Fyf - B * Fyr) / IZ;
  c.ax = axBody;
  c.ay = ayBody;
  let long2 = long + axBody * dt;
  if (input.brake > 0 && input.throttle >= 0 && long * long2 < 0) long2 = 0;
  let lat2 = lat + ayBody * dt;
  if (!paved) lat2 *= 0.88;
  c.yawRate += yawAcc * dt;
  const yawDamp = input.brake > 0.2 ? 3.4 : 0.85;
  c.yawRate *= Math.exp(-yawDamp * dt);
  if (long2 === 0 && input.brake > 0) {
    c.yawRate *= 0.5;
    lat2 *= 0.7;
  }
  c.yaw += c.yawRate * dt;
  const s2 = Math.sin(c.yaw);
  const c2 = Math.cos(c.yaw);
  c.vx = long2 * s2 + lat2 * c2;
  c.vz = long2 * c2 - lat2 * s2;
  c.x += c.vx * dt;
  c.z += c.vz * dt;

  if (!onPavement(c.x, c.z)) {
    const gSpd = Math.hypot(c.vx, c.vz);
    if (gSpd > GRASS_VMAX) {
      const drop = Math.max(GRASS_VMAX, gSpd * Math.exp(-2.4 * dt));
      c.vx *= drop / gSpd;
      c.vz *= drop / gSpd;
    }
  }

  railToRoad(c, dt);
  advanceLap(c);

  const spdNow = Math.hypot(c.vx, c.vz);
  const targetRpm = 3800 + spdNow * 95 + Math.max(0, input.throttle) * 5200;
  c.rpm += (targetRpm - c.rpm) * Math.min(1, 8 * dt);
  c.rpm = THREE.MathUtils.clamp(c.rpm, 3500, 15200);
  c.wheelSpin += (long2 / 0.33) * dt;
  c.pitch += (0 - c.pitch) * Math.min(1, 14 * dt);
  c.roll += (THREE.MathUtils.clamp(ayBody * 0.006, -0.03, 0.03) - c.roll) * Math.min(1, 12 * dt);
  c.invuln = Math.max(0, c.invuln - dt);
  c.fireCool = Math.max(0, c.fireCool - dt);
}

function collidePair(a: Car, b: Car): void {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = Math.hypot(dx, dz);
  const min = 3.15;
  if (dist >= min || dist < 0.001) return;
  const nx = dx / dist;
  const nz = dz / dist;
  const overlap = min - dist;
  a.x -= nx * overlap * 0.5;
  a.z -= nz * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.z += nz * overlap * 0.5;
  const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  const j = rel * 0.58;
  a.vx += nx * j;
  a.vz += nz * j;
  b.vx -= nx * j;
  b.vz -= nz * j;
  a.yawRate += (Math.random() - 0.5) * 0.7;
  b.yawRate += (Math.random() - 0.5) * 0.7;
  if (a === you || b === you) camShake = Math.min(0.7, camShake + Math.abs(rel) * 0.07);
}

function collideCars(): void {
  const cars = field().filter((c) => c.hp > 0);
  for (let i = 0; i < cars.length; i++) {
    for (let k = i + 1; k < cars.length; k++) collidePair(cars[i]!, cars[k]!);
  }
}

function syncCar(c: Car): void {
  c.group.position.set(c.x, 0, c.z);
  c.group.rotation.set(0, c.yaw, 0);
  c.body.rotation.x = c.pitch;
  c.body.rotation.z = c.roll;
  c.body.position.y = 0;
  for (let i = 0; i < 4; i++) {
    const w = c.wheels[i]!;
    w.rotation.x = c.wheelSpin;
    w.rotation.y = 0;
    if (w.parent) w.parent.rotation.y = i < 2 ? c.steer * 0.72 : 0;
  }
}

function dropSkids(dt: number): void {
  skidAcc += dt;
  if (skidAcc < 0.028) return;
  skidAcc = 0;
  for (const c of field()) {
    if (c.hp <= 0) continue;
    const { lat, long } = longLat(c);
    const slip = Math.abs(lat) > 4.2 || (Math.abs(long) > 8 && Math.abs(c.steer) > 0.22 && Math.abs(lat) > 2.2);
    if (!slip) continue;
    const s = Math.sin(c.yaw);
    const cs = Math.cos(c.yaw);
    for (const side of [-0.78, 0.78]) {
      skidDummy.position.set(c.x + cs * side, 0.03, c.z - s * side);
      skidDummy.rotation.set(-Math.PI / 2, 0, -c.yaw);
      skidDummy.updateMatrix();
      skids.setMatrixAt(skidI % SKID_N, skidDummy.matrix);
      skidI += 1;
    }
  }
  skids.instanceMatrix.needsUpdate = true;
}

const muzzle = new THREE.Vector3();
function fireCar(c: Car, owner: "you" | "jev"): void {
  if (!gunsOn) return;
  if (c.fireCool > 0) return;
  const slot = bullets.find((b) => !b.alive);
  if (!slot) return;
  const s = Math.sin(c.yaw);
  const cs = Math.cos(c.yaw);
  const side = c.gunSide === 0 ? -0.42 : 0.42;
  muzzle.set(c.x + cs * side + s * 2.35, 0.48, c.z - s * side + cs * 2.35);
  slot.mesh.position.copy(muzzle);
  slot.mesh.rotation.y = c.yaw;
  slot.vx = s * 58 + c.vx;
  slot.vz = cs * 58 + c.vz;
  slot.alive = true;
  slot.life = 1.15;
  slot.owner = owner;
  slot.shooter = c;
  slot.mesh.visible = true;
  slot.mesh.material = owner === "you" ? youBulletMat : jevBulletMat;
  c.gunSide = 1 - c.gunSide;
  c.fireCool = 0.14;
  if (audio) playGun(audio, c);
}

let specI = 0;
let specAt = 0;
let crashed = false;

function camCar(): Car {
  if (you.hp > 0) return you;
  const live = livingFoes().slice().sort((a, b) => raceProgress(b) - raceProgress(a));
  if (!live.length) return you;
  if (specI >= live.length) specI = 0;
  return live[specI]!;
}
let camShake = 0;
let bannerUntil = 0;
let mouseDown = false;
let jevBusy = false;
let jevAskAt = 0;
let lightsOut = false;
let lightsAt = 0;
let audioLoad = 0;
let gunsOn = false;

function gunsFromUrl(): boolean {
  const g = new URLSearchParams(location.search).get("guns");
  return g === "1" || g === "on" || g === "true";
}

function writeSearch(patch: Record<string, string | null>): void {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (!v) u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  const next = `${u.pathname}${u.search}${u.hash}`;
  if (next !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, "", next);
}

function setGuns(on: boolean, writeUrl = true): void {
  gunsOn = on;
  gunsOnBtn?.classList.toggle("is-active", on);
  gunsOffBtn?.classList.toggle("is-active", !on);
  document.body.classList.toggle("drive-noguns", !on);
  if (crosshair instanceof HTMLElement) crosshair.hidden = !on;
  if (keyGuns instanceof HTMLElement) keyGuns.hidden = !on;
  if (writeUrl) writeSearch({ guns: on ? "1" : null });
}

function clockLabel(bearing: number): string {
  let hour = Math.round((((bearing * 180) / Math.PI + 360) % 360) / 30);
  if (hour === 0) hour = 12;
  return `${hour} o'clock`;
}

function geometryFrom(from: Car, to: Car) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const range = Math.hypot(dx, dz);
  const s = Math.sin(from.yaw);
  const cs = Math.cos(from.yaw);
  const along = (dx * s + dz * cs) / Math.max(0.001, range);
  const right = (dx * cs - dz * s) / Math.max(0.001, range);
  const bearing = Math.atan2(right, along);
  return {
    range,
    bearing,
    along,
    lined: along > 0.78 && Math.abs(bearing) < 0.14 && range < 48,
  };
}

function playerShooting(): boolean {
  return gunsOn && (held("Space") || mouseDown);
}

function livingRacers(): Car[] {
  return field().filter((c) => c.hp > 0);
}

function rivalsOf(c: Car): Car[] {
  return livingRacers().filter((o) => o !== c);
}

function bestGunTarget(c: Car): { t: Car; g: ReturnType<typeof geometryFrom> } | null {
  let best: { t: Car; g: ReturnType<typeof geometryFrom>; score: number } | null = null;
  for (const o of rivalsOf(c)) {
    const g = geometryFrom(c, o);
    if (g.along < 0.4 || g.range > 44 || g.range < 3.2) continue;
    const score = (g.lined ? 50 : 0) + (1 - Math.abs(g.bearing)) * 24 - g.range * 0.12 + (o === you ? 4 : 0);
    if (!best || score > best.score) best = { t: o, g, score };
  }
  return best;
}

function aimedAt(c: Car): boolean {
  if (!gunsOn) return false;
  for (const o of rivalsOf(c)) {
    const g = geometryFrom(o, c);
    if (g.along < 0.68 || Math.abs(g.bearing) > 0.17 || g.range > 40) continue;
    if (o === you && !playerShooting() && !g.lined) continue;
    return true;
  }
  return false;
}

function jevUnderFire(c: Car): boolean {
  const t = geometryFrom(you, c);
  return playerShooting() && t.along > 0.48 && Math.abs(t.bearing) < 0.34 && t.range < 34;
}

function inPlayerCrosshair(c: Car): boolean {
  const t = geometryFrom(you, c);
  return t.along > 0.74 && Math.abs(t.bearing) < 0.15 && t.range < 42;
}

function huntDrive(c: Car): DriveManeuver {
  if (aimedAt(c)) return "circle";
  const mark = bestGunTarget(c);
  if (mark?.g.lined) return "guns";
  if (wallDist(c) < 1.05) return "brake";
  return "chase";
}

function snapshotDrive(c: Car): DriveSnapshot {
  const youG = geometryFrom(c, you);
  const them = geometryFrom(you, c);
  return {
    rules:
      "Free-for-all oval: 4 Jevs plus the gold car. Race 3 laps AND shoot anyone ahead. Weave only if they_have_guns_on_you.",
    you: {
      hp: c.hp,
      x: Math.round(c.x * 10) / 10,
      z: Math.round(c.z * 10) / 10,
      heading_deg: headingDeg(c.yaw),
      speed: Math.round(Math.hypot(c.vx, c.vz) * 3.6),
      lap: c.lap,
      checkpoint: c.cp,
    },
    foe: {
      hp: you.hp,
      x: Math.round(you.x * 10) / 10,
      z: Math.round(you.z * 10) / 10,
      heading_deg: headingDeg(you.yaw),
      speed: Math.round(Math.hypot(you.vx, you.vz) * 3.6),
      lap: you.lap,
      checkpoint: you.cp,
    },
    geometry: {
      range: Math.round(youG.range * 10) / 10,
      bearing_deg: Math.round((youG.bearing * 180) / Math.PI),
      aspect_deg: Math.round((them.bearing * 180) / Math.PI),
      clock: clockLabel(youG.bearing),
      lined_up: youG.lined,
      they_have_guns_on_you: them.lined,
      they_are_shooting: playerShooting(),
      they_are_shooting_at_you: aimedAt(c),
      closing: youG.along > 0.2,
      wall_close: wallDist(c) < 1.8,
      race_pos: racePlace(c),
      laps_to_go: Math.max(0, LAPS - c.lap),
      corner: cornerKind(c),
    },
  };
}

function logDecision(kind: string, text: string): void {
  if (!feedList) return;
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = text;
  feedList.prepend(li);
  while (feedList.children.length > 10) feedList.removeChild(feedList.lastChild as Node);
}

async function askJev(): Promise<void> {
  const c = closestFoe();
  if (jevBusy || crashed || !lightsOut) return;
  jevBusy = true;
  const t0 = performance.now();
  const g = geometryFrom(c, you);
  try {
    const res = await fetch("/api/drive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshotDrive(c)),
    });
    const ms = Math.round(performance.now() - t0);
    recordLatency(ms);
    const data = (await res.json()) as DrivePilotResponse;
    if (!res.ok) throw new Error(data.detail || data.error || `http ${res.status}`);
    const mark = bestGunTarget(c);
    c.maneuver = data.maneuver ?? huntDrive(c);
    if (!aimedAt(c) && c.maneuver !== "guns") c.maneuver = "chase";
    c.wantFire = !!mark?.g.lined;
    statusAction.textContent = `${c.name}  ${c.maneuver.toUpperCase()}`;
    statusMeta.textContent = `${ms}ms · P${racePlace(c)} · ${clockLabel(g.bearing)}`;
    logDecision(c.wantFire ? "flap" : "wait", `${c.name} ${c.maneuver.toUpperCase()}  lap ${c.lap + 1}  ${ms}ms`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Jev call failed";
    statusAction.textContent = "ERROR";
    statusMeta.textContent = message;
    logDecision("error", message);
    c.maneuver = huntDrive(c);
    if (!aimedAt(c) && c.maneuver !== "guns") c.maneuver = "chase";
    c.wantFire = !!bestGunTarget(c)?.g.lined;
  } finally {
    jevBusy = false;
    jevAskAt = performance.now() + (aimedAt(c) ? 280 : 900);
  }
}

function jevInput(c: Car): DriveIn {
  const sighted = aimedAt(c);
  const n = nearest(c.x, c.z);
  const wantLat = sighted ? (n.lat > 0 ? -4.6 : 4.6) : c.lineLat;
  const tgt = lookAhead(n.s, sighted ? 18 : 28, wantLat);
  const s = Math.sin(c.yaw);
  const cs = Math.cos(c.yaw);
  const right = (tgt.x - c.x) * cs - (tgt.z - c.z) * s;
  const steer = THREE.MathUtils.clamp(right * 0.12, -1, 1);
  let throttle = Math.min(1, c.pace);
  let brake = 0;
  if (wallDist(c) < 0.85) {
    brake = 0.12;
    throttle = 0.85;
  }
  return { throttle, brake, steer, ebrake: false };
}

function finishRace(youWon: boolean, lastCar = false): void {
  crashed = true;
  banner.classList.remove("is-hidden");
  bannerText.textContent = youWon
    ? lastCar
      ? "Last car standing. You win. R to restart."
      : "Chequered flag. You win the Grand Prix. R to restart."
    : lastCar
      ? "Last car standing — a Jev takes it. R to restart."
      : "A Jev takes the flag. R to run it back.";
  statusAction.textContent = youWon ? "P1" : `P${Math.max(1, racePlace(you))}`;
  bannerUntil = Infinity;
  if (audio) audio.master.gain.setTargetAtTime(0.0001, audio.ctx.currentTime, 0.2);
}

function maybeLastCar(): void {
  if (crashed || !lightsOut) return;
  const live = livingRacers();
  if (live.length === 1) finishRace(live[0] === you, true);
}

function wreckCar(c: Car): void {
  c.hp = 0;
  c.vx = 0;
  c.vz = 0;
  c.yawRate = 0;
  c.group.visible = false;
  c.bar.visible = false;
  explodeAt(c.x, 0.55, c.z);
  explodeAt(c.x + 0.9, 0.85, c.z + 0.4);
  explodeAt(c.x - 0.7, 1.05, c.z - 0.6);
  if (audio) playBoom(audio);
  maybeLastCar();
  if (crashed) return;
  if (c === you) {
    specI = 0;
    specAt = performance.now();
    banner.classList.remove("is-hidden");
    bannerText.textContent = "You're out. Watching the pack. C to swap cameras.";
    bannerUntil = performance.now() + 4200;
  }
}

function damage(c: Car, _fromJev: boolean): void {
  if (c.invuln > 0 || c.hp <= 0) return;
  c.hp -= 1;
  c.invuln = 0.65;
  if (c.hp <= 0) wreckCar(c);
}

function reset(): void {
  audioLoad = 0;
  const gy = poseAt(FINISH_S + 14, -2.2);
  Object.assign(you, {
    x: gy.x,
    z: gy.z,
    yaw: gy.yaw,
    vx: 0,
    vz: 0,
    yawRate: 0,
    steer: 0,
    rpm: 4200,
    ax: 0,
    ay: 0,
    pitch: 0,
    roll: 0,
    hp: MAX_HP,
    invuln: 1.6,
    fireCool: 0,
    lap: 0,
    lastS: gy.s,
    cp: 0,
    wantFire: false,
    maneuver: "chase",
  });
  you.group.visible = true;
  specI = 0;
  for (let i = 0; i < foes.length; i++) {
    const g = FOE_GRID[i]!;
    const p = poseAt(FINISH_S + g.ds, g.lat);
    Object.assign(foes[i]!, {
      x: p.x,
      z: p.z,
      yaw: p.yaw,
      vx: 0,
      vz: 0,
      yawRate: 0,
      steer: 0,
      rpm: 4200,
      ax: 0,
      ay: 0,
      pitch: 0,
      roll: 0,
      hp: MAX_HP,
      invuln: 0.5,
      fireCool: 1.6,
      lap: 0,
      lastS: p.s,
      cp: 0,
      wantFire: false,
      maneuver: "chase",
    });
    const car = foes[i]!;
    car.group.visible = true;
    car.bar.visible = true;
    syncHpUi(car);
  }
  crashed = false;
  lightsOut = false;
  lightsAt = performance.now() + 2400;
  jevBusy = false;
  jevAskAt = performance.now() + 2600;
  for (const b of bullets) {
    b.alive = false;
    b.mesh.visible = false;
  }
  for (const p of sparks) {
    p.alive = false;
    p.mesh.visible = false;
  }
  for (const lamp of lights) (lamp.material as THREE.MeshBasicMaterial).color.setHex(0x2a1010);
  banner.classList.remove("is-hidden");
  bannerText.textContent = "Lights going out. 3 laps. Guns live.";
  bannerUntil = performance.now() + 5200;
  statusAction.textContent = "GRID";
  statusMeta.textContent = "waiting for lights";
  feedList?.replaceChildren();
  if (audio) audio.master.gain.setTargetAtTime(0.52, audio.ctx.currentTime, 0.08);
}

function playerInput(): DriveIn {
  const { long } = longLat(you);
  const speed = Math.hypot(you.vx, you.vz);
  const stopped = speed < 0.7 && Math.abs(long) < 0.4;
  let throttle = 0;
  let brake = 0;
  if (held("KeyW") || held("ArrowUp")) throttle = 1;
  if (held("KeyS") || held("ArrowDown")) {
    if (throttle > 0) brake = 1;
    else if (stopped || long < 0) throttle = -0.62;
    else brake = 1;
  }
  let steer = 0;
  if (held("KeyA") || held("ArrowLeft")) steer = 1;
  if (held("KeyD") || held("ArrowRight")) steer = -1;
  if (long < -0.35 || throttle < 0) steer = -steer;
  const ebrake = held("ShiftLeft") || held("ShiftRight");
  if (!lightsOut) {
    throttle = 0;
    brake = 1;
  }
  return { throttle, brake, steer, ebrake };
}

let acc = 0;
const camPos = new THREE.Vector3(gridYou.x, 6, gridYou.z);
const camLook = new THREE.Vector3();
const camDesired = new THREE.Vector3();
const clock = new THREE.Clock();

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
  }
});
window.addEventListener("pointerup", () => {
  mouseDown = false;
});
gunsOnBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  setGuns(true);
});
gunsOffBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  setGuns(false);
});
setGuns(gunsFromUrl());
window.addEventListener("popstate", () => setGuns(gunsFromUrl(), false));

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyR") reset();
  if (e.code === "KeyG") setGuns(!gunsOn);
  if (e.code === "KeyC" && you.hp <= 0) {
    specI += 1;
    specAt = performance.now();
  }
  if (e.code === "Space") ensureAudio();
});

reset();
resize();

function tick(): void {
  const dt = Math.min(clock.getDelta(), 0.05);
  requestAnimationFrame(tick);
  acc += dt;
  const nowMs = performance.now();
  if (!lightsOut) {
    const left = lightsAt - nowMs;
    const stage = left > 1800 ? 0 : left > 1200 ? 1 : left > 600 ? 2 : left > 0 ? 3 : 5;
    for (let i = 0; i < lights.length; i++) {
      (lights[i]!.material as THREE.MeshBasicMaterial).color.setHex(i < stage ? 0xff2a22 : 0x2a1010);
    }
    if (left <= 0) {
      lightsOut = true;
      for (const lamp of lights) (lamp.material as THREE.MeshBasicMaterial).color.setHex(0x2ee86a);
      if (audio) playCheer(audio, 0.72);
      bannerText.textContent = "LIGHTS OUT. Three laps. Shoot if you must.";
      bannerUntil = nowMs + 2200;
      statusAction.textContent = "GREEN";
    }
  }
  const pin = playerInput();
  const hold = { throttle: 0.2, brake: 1, steer: 0, ebrake: false };
  while (acc >= STEP) {
    if (!crashed) {
      if (you.hp > 0) stepCar(you, STEP, pin);
      for (const f of livingFoes()) stepCar(f, STEP, lightsOut ? jevInput(f) : hold);
      collideCars();
    }
    acc -= STEP;
  }

  if (!crashed && lightsOut && you.hp > 0 && you.lap >= LAPS) finishRace(true);
  else if (!crashed && lightsOut && livingFoes().some((f) => f.lap >= LAPS)) finishRace(false);
  if (!crashed && lightsOut) maybeLastCar();

  if (!crashed && lightsOut && livingFoes().length && nowMs >= jevAskAt) void askJev();

  for (const c of field()) {
    syncCar(c);
    syncHpUi(c);
  }
  dropSkids(dt);

  if (!crashed && lightsOut && you.hp > 0 && (held("Space") || mouseDown) && you.fireCool <= 0) fireCar(you, "you");
  for (const f of livingFoes()) {
    const mark = bestGunTarget(f);
    const g = mark?.g;
    if (
      !crashed &&
      lightsOut &&
      g &&
      (f.wantFire || g.lined) &&
      f.fireCool <= 0 &&
      g.along > 0.62 &&
      Math.abs(g.bearing) < 0.16 &&
      g.range < 38 &&
      g.range > 3.5
    ) {
      fireCar(f, "jev");
    }
  }

  for (const b of bullets) {
    if (!b.alive) continue;
    const ox = b.mesh.position.x;
    const oz = b.mesh.position.z;
    b.life -= dt;
    b.mesh.position.x += b.vx * dt;
    b.mesh.position.z += b.vz * dt;
    const nx = b.mesh.position.x;
    const nz = b.mesh.position.z;
    const targets = livingRacers().filter((t) => t !== b.shooter);
    let struck = false;
    for (const target of targets) {
      const hit = segmentHitsCar(ox, oz, nx, nz, target);
      if (!hit) continue;
      explodeAt(hit.x, 0.55, hit.z);
      damage(target, b.owner === "jev");
      b.alive = false;
      b.mesh.visible = false;
      struck = true;
      break;
    }
    if (struck) continue;
    if (b.life <= 0 || Math.abs(nearest(nx, nz).lat) > 36) {
      b.alive = false;
      b.mesh.visible = false;
    }
  }
  stepSparks(dt);

  if (you.hp <= 0 && livingFoes().length && nowMs - specAt > 8000) {
    specI += 1;
    specAt = nowMs;
  }
  const view = camCar();
  const s = Math.sin(view.yaw);
  const cs = Math.cos(view.yaw);
  const spd = Math.hypot(view.vx, view.vz);
  camDesired.set(view.x - s * (14.8 + spd * 0.1), 4.05 + spd * 0.014, view.z - cs * (14.8 + spd * 0.1));
  camPos.lerp(camDesired, 1 - Math.exp(-dt * 4.2));
  camShake *= Math.exp(-dt * 7);
  camLook.set(view.x + s * (8 + spd * 0.06), 0.45, view.z + cs * (8 + spd * 0.06));
  camera.position.set(camPos.x + (Math.random() - 0.5) * camShake, camPos.y + camShake * 0.35, camPos.z);
  camera.lookAt(camLook);
  const wantFov = 58 + Math.min(14, spd * 0.16);
  camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 3);
  camera.updateProjectionMatrix();
  sun.position.set(view.x + 70, 110, view.z + 40);
  sun.target.position.set(view.x, 0, view.z);
  sun.target.updateMatrixWorld();

  if (audio && !crashed) {
    const now = audio.ctx.currentTime;
    const { lat, long } = longLat(you);
    const slip = THREE.MathUtils.clamp(Math.abs(lat) / 12, 0, 1);
    const thrust = you.hp > 0 ? THREE.MathUtils.clamp(Math.max(0, pin.throttle), 0, 1) : 0.72;
    audioLoad += (thrust - audioLoad) * Math.min(1, dt * 2.8);
    const load = 0.28 + audioLoad * 0.72;
    const coast = THREE.MathUtils.clamp(Math.abs(long) / VMAX, 0, 1);
    const rpmSound = 3800 + coast * 8200 + audioLoad * 2800;
    const fire = rpmSound / 12;
    audio.master.gain.setTargetAtTime(0.52, now, 0.1);
    const usingClip = !!audio.sampleSrc;
    if (audio.sampleSrc) {
      audio.sampleSrc.playbackRate.setTargetAtTime(0.96 + audioLoad * 0.1 + coast * 0.04, now, 0.08);
      audio.sampleGain.gain.setTargetAtTime(0.16 + audioLoad * 0.42, now, 0.1);
    }
    audio.rumble.frequency.setTargetAtTime(48 + audioLoad * 22, now, 0.08);
    audio.rumbleGain.gain.setTargetAtTime(usingClip ? 0.0001 : 0.02 + load * 0.04, now, 0.1);
    audio.eng.frequency.setTargetAtTime(fire, now, 0.055);
    audio.eng2.frequency.setTargetAtTime(fire * 2, now, 0.055);
    audio.eng3.frequency.setTargetAtTime(fire * 0.5, now, 0.07);
    audio.engFilt.frequency.setTargetAtTime(fire * 1.15, now, 0.08);
    audio.engGain.gain.setTargetAtTime(usingClip ? 0.0001 : 0.07 * load, now, 0.09);
    audio.scream.frequency.setTargetAtTime(fire * 2.7, now, 0.06);
    audio.screamGain.gain.setTargetAtTime(usingClip ? 0.0001 : 0.015 + audioLoad * 0.07 + coast * 0.02, now, 0.1);
    audio.exhaust.gain.setTargetAtTime(usingClip ? 0.0001 : 0.04 + audioLoad * 0.12, now, 0.1);
    audio.exhaustFilter.frequency.setTargetAtTime(fire * 0.85, now, 0.1);
    audio.intakeGain.gain.setTargetAtTime(usingClip ? 0.0001 : audioLoad * 0.08, now, 0.1);
    audio.intakeFilter.frequency.setTargetAtTime(900 + audioLoad * 1100, now, 0.12);
    audio.skidGain.gain.setTargetAtTime(slip > 0.18 || pin.ebrake ? 0.04 + slip * 0.12 : 0.0001, now, 0.05);
    const near = closestFoe();
    const dFoe = Math.hypot(near.x - you.x, near.z - you.z);
    const foeFire = (3800 + THREE.MathUtils.clamp(Math.hypot(near.vx, near.vz) / VMAX, 0, 1) * 9000) / 12;
    audio.foeEng.frequency.setTargetAtTime(foeFire, now, 0.08);
    audio.foeEng2.frequency.setTargetAtTime(foeFire * 2, now, 0.08);
    audio.foeGain.gain.setTargetAtTime((usingClip ? 0.0001 : lightsOut ? 0.055 : 0.012) / (1 + dFoe * 0.05), now, 0.12);
    const nearLine = Math.abs(((you.lastS - FINISH_S + TRACK_LEN) % TRACK_LEN)) < 28 ? 0.03 : 0;
    audio.crowdGain.gain.setTargetAtTime(0.05 + nearLine, now, 0.25);
    audio.crowdFilter.frequency.setTargetAtTime(720 + Math.sin(nowMs * 0.0015) * 80, now, 0.3);
  } else if (audio && crashed) {
    audioLoad = 0;
    const now = audio.ctx.currentTime;
    audio.engGain.gain.setTargetAtTime(0.0001, now, 0.18);
    audio.exhaust.gain.setTargetAtTime(0.0001, now, 0.18);
    audio.rumbleGain.gain.setTargetAtTime(0.0001, now, 0.18);
    audio.intakeGain.gain.setTargetAtTime(0.0001, now, 0.18);
    audio.screamGain.gain.setTargetAtTime(0.0001, now, 0.18);
    audio.foeGain.gain.setTargetAtTime(0.0001, now, 0.18);
    audio.sampleGain.gain.setTargetAtTime(0.0001, now, 0.18);
  }

  const watch = camCar();
  const kph = Math.round(Math.hypot(watch.vx, watch.vz) * 3.6);
  const { long } = longLat(watch);
  const absV = Math.abs(long);
  hudSpd.textContent = String(kph);
  hudRpm.textContent = String(Math.round(watch.rpm));
  hudGear.textContent = String(absV < 12 ? 1 : absV < 22 ? 2 : absV < 34 ? 3 : absV < 46 ? 4 : absV < 58 ? 5 : absV < 70 ? 6 : absV < 80 ? 7 : 8);
  hudHpYou.textContent = String(Math.max(0, you.hp));
  hudHpJev.textContent = String(livingFoes().length);
  hudLap.textContent = String(Math.min(LAPS, watch.lap + 1));
  hudPos.textContent = String(racePlace(watch));
  drawMap();
  if (!crashed && performance.now() > bannerUntil) banner.classList.add("is-hidden");

  renderer.render(scene, camera);
}

tick();
canvas.focus();
initLatencyChart();
