import * as THREE from "three";
import { initLatencyChart, recordLatency } from "./latency.ts";
import type { FlightManeuver, SpacePilotResponse, SpaceSnapshot } from "./types.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const hudSpd = document.querySelector("#hud-spd")!;
const hudBody = document.querySelector("#hud-body")!;
const hudHdg = document.querySelector("#hud-hdg")!;
const hudThr = document.querySelector("#hud-thr")!;
const hudHpYou = document.querySelector("#hud-hp-you")!;
const hudHpJev = document.querySelector("#hud-hp-jev")!;
const radarCanvas = document.querySelector<HTMLCanvasElement>("#radar")!;
const radarRng = document.querySelector("#radar-rng")!;
const radarAlt = document.querySelector("#radar-alt")!;
const radarCtx = radarCanvas.getContext("2d")!;
const huntCanvas = document.querySelector<HTMLCanvasElement>("#hunt-arrows")!;
const huntCtx = huntCanvas.getContext("2d")!;
const feedList = document.querySelector("#decisions");
const banner = document.querySelector("#flight-banner")!;
const bannerText = document.querySelector("#flight-banner-text")!;
const statusAction = document.querySelector("#pilot-action")!;
const statusMeta = document.querySelector("#pilot-meta")!;
const watchMode = new URLSearchParams(location.search).get("mode") === "watch";
document.body.classList.toggle("space-watch", watchMode);
for (const a of document.querySelectorAll<HTMLAnchorElement>(".mode-row a")) {
  a.classList.toggle("is-active", (a.dataset.mode === "watch") === watchMode);
}

/** World units per astronomical unit — inner hops are seconds, Neptune is a few minutes. */
const AU = 420;
const SUN_R = 72;
const MAX_HP = 5;
const HIT_R = 7.4;
const LASER_RANGE = 480;
const CRUISE = 1.55;
const MAX_TURN = 0.042;
const TURN_ACCEL = 0.0026;
const FOE_MAX_TURN = MAX_TURN * 0.4;
const FOE_TURN_ACCEL = TURN_ACCEL * 0.48;
const SHIP_SCALE = 2.4;

type Hunt = {
  pos: THREE.Vector3;
  fwd: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  hp: number;
  speed: number;
  shooting: boolean;
  label: string;
};

type Fighter = {
  id: number;
  name: string;
  color: number;
  mesh: THREE.Group;
  glow: THREE.Mesh;
  pos: THREE.Vector3;
  axisX: THREE.Vector3;
  axisY: THREE.Vector3;
  axisZ: THREE.Vector3;
  rot: THREE.Matrix4;
  mat: THREE.Matrix4;
  fwd: THREE.Vector3;
  yaw: number;
  pitch: number;
  stickBank: number;
  stickPitch: number;
  turbo: number;
  speed: number;
  hp: number;
  alive: boolean;
  fireCool: number;
  invuln: number;
  maneuver: FlightManeuver;
  wantFire: boolean;
  askAt: number;
  breakDir: number;
  spawn: THREE.Vector3;
  lastShot: number;
  bar: THREE.Group;
  barFill: THREE.Mesh;
};

type WorldBody = {
  name: string;
  au: number;
  radius: number;
  mesh: THREE.Object3D;
  angle: number;
  period: number;
  tilt: number;
};

type Beam = { mesh: THREE.Mesh; life: number };

const keys = new Set<string>();
window.addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
function held(code: string): boolean {
  return keys.has(code);
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02040a);
scene.fog = new THREE.FogExp2(0x02040a, 0.000045);

const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.4, 48000);
camera.matrixAutoUpdate = false;

scene.add(new THREE.HemisphereLight(0x6a7aa0, 0x08060c, 0.85));
const sunLight = new THREE.PointLight(0xfff3d0, 8, 22000, 0.45);
scene.add(sunLight);

function makeStars(): void {
  const n = 2200;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 9000 + Math.random() * 14000;
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i * 3 + 2] = r * Math.cos(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xc9dcff, size: 2.1, sizeAttenuation: true })));
}
makeStars();

const sun = new THREE.Mesh(
  new THREE.SphereGeometry(SUN_R, 32, 24),
  new THREE.MeshBasicMaterial({ color: 0xffe7a0 }),
);
scene.add(sun);
const corona = new THREE.Mesh(
  new THREE.SphereGeometry(SUN_R * 1.45, 24, 18),
  new THREE.MeshBasicMaterial({ color: 0xff9a3a, transparent: true, opacity: 0.28, side: THREE.BackSide, depthWrite: false }),
);
scene.add(corona);

function makePlanet(color: number, r: number, rings = false): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.04,
    emissive: color,
    emissiveIntensity: 0.22,
  });
  g.add(new THREE.Mesh(new THREE.SphereGeometry(r, 28, 20), mat));
  if (rings) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.35, r * 2.15, 48),
      new THREE.MeshStandardMaterial({
        color: 0xcbb896,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.82,
        roughness: 0.7,
        emissive: 0x443318,
        emissiveIntensity: 0.2,
      }),
    );
    ring.rotation.x = Math.PI / 2.15;
    g.add(ring);
  }
  return g;
}

const PLANET_DEF = [
  { name: "Mercury", au: 0.387, r: 11, color: 0xb0aaa0, rings: false },
  { name: "Venus", au: 0.723, r: 18, color: 0xe6c07b, rings: false },
  { name: "Earth", au: 1, r: 20, color: 0x3d7ad6, rings: false },
  { name: "Mars", au: 1.524, r: 14, color: 0xc14a1c, rings: false },
  { name: "Jupiter", au: 5.203, r: 52, color: 0xd7b184, rings: false },
  { name: "Saturn", au: 9.537, r: 44, color: 0xe4d2a4, rings: true },
  { name: "Uranus", au: 19.191, r: 28, color: 0x7fe3e6, rings: false },
  { name: "Neptune", au: 30.07, r: 26, color: 0x3d5fff, rings: false },
];

const bodies: WorldBody[] = PLANET_DEF.map((d, i) => {
  const mesh = makePlanet(d.color, d.r, d.rings);
  scene.add(mesh);
  const orbit = new THREE.Mesh(
    new THREE.RingGeometry(d.au * AU - 4, d.au * AU + 4, 128),
    new THREE.MeshBasicMaterial({ color: 0x6a8ec8, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
  );
  orbit.rotation.x = Math.PI / 2;
  scene.add(orbit);
  return {
    name: d.name,
    au: d.au,
    radius: d.r,
    mesh,
    angle: i * 0.51,
    period: 95 * d.au ** 1.15,
    tilt: (i % 3) * 0.012,
  };
});

function placeBodies(): void {
  for (const b of bodies) {
    const r = b.au * AU;
    b.mesh.position.set(Math.cos(b.angle) * r, Math.sin(b.angle) * b.tilt * r, Math.sin(b.angle) * r);
  }
}
placeBodies();

const moon = new THREE.Mesh(
  new THREE.SphereGeometry(5.2, 16, 12),
  new THREE.MeshStandardMaterial({ color: 0xc5c2bb, roughness: 0.85, emissive: 0x33322e, emissiveIntensity: 0.18 }),
);
scene.add(moon);
let moonAngle = 0.4;

const beltDummy = new THREE.Object3D();
const belt = new THREE.InstancedMesh(
  new THREE.IcosahedronGeometry(0.55, 0),
  new THREE.MeshStandardMaterial({ color: 0x8a8174, roughness: 0.9 }),
  140,
);
for (let i = 0; i < 140; i++) {
  const au = 2.2 + Math.random() * 1.0;
  const a = Math.random() * Math.PI * 2;
  const y = (Math.random() - 0.5) * 18;
  beltDummy.position.set(Math.cos(a) * au * AU, y, Math.sin(a) * au * AU);
  beltDummy.rotation.set(Math.random() * 3, Math.random() * 3, 0);
  const s = 0.4 + Math.random() * 1.6;
  beltDummy.scale.setScalar(s);
  beltDummy.updateMatrix();
  belt.setMatrixAt(i, beltDummy.matrix);
}
scene.add(belt);

function makeShip(paint: number): THREE.Group {
  const ship = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: paint, metalness: 0.55, roughness: 0.32, emissive: paint, emissiveIntensity: 0.08 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x141820, metalness: 0.7, roughness: 0.28 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3.6, 6), hull);
  body.rotation.x = -Math.PI / 2;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.32, 1.1), dark);
  cabin.position.set(0, 0.28, 0.15);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.08, 1.05), hull);
  wing.position.z = 0.55;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.85, 0.7), hull);
  fin.position.set(0, 0.45, 1.15);
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0x7ecbff }),
  );
  glow.name = "glow";
  glow.position.z = 1.95;
  ship.add(body, cabin, wing, fin, glow);
  ship.scale.setScalar(SHIP_SCALE);
  return ship;
}

function makeHpBar(paint: number): { bar: THREE.Group; barFill: THREE.Mesh } {
  const bar = new THREE.Group();
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(1.55, 0.16),
    new THREE.MeshBasicMaterial({ color: 0x111318, transparent: true, opacity: 0.72 }),
  );
  const barFill = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 0.1), new THREE.MeshBasicMaterial({ color: paint }));
  barFill.position.z = 0.01;
  bar.add(bg, barFill);
  bar.scale.setScalar(3.2);
  scene.add(bar);
  return { bar, barFill };
}

const FOE_SKINS = [
  { name: "JEV-1", paint: 0xb5121b },
  { name: "JEV-2", paint: 0x1e4fa3 },
  { name: "JEV-3", paint: 0xd45a12 },
];

function earthSpot(extra = 0): THREE.Vector3 {
  const earth = bodies[2]!;
  const r = earth.au * AU;
  const a = earth.angle + extra;
  return new THREE.Vector3(Math.cos(a) * r, 10, Math.sin(a) * r);
}

function lookToward(
  origin: THREE.Vector3,
  target: THREE.Vector3,
  x: THREE.Vector3,
  y: THREE.Vector3,
  z: THREE.Vector3,
): void {
  z.copy(origin).sub(target);
  if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
  z.normalize();
  y.set(0, 1, 0);
  x.crossVectors(y, z).normalize();
  if (x.lengthSq() < 1e-6) {
    y.set(1, 0, 0);
    x.crossVectors(y, z).normalize();
  }
  y.crossVectors(z, x).normalize();
}

function spawnOutboard(extra = 0, along = 56): THREE.Vector3 {
  const on = earthSpot(extra);
  const radial = on.clone().setY(0);
  if (radial.lengthSq() < 1) radial.set(1, 0, 0);
  radial.normalize().multiplyScalar(along);
  return on.add(radial).setY(22);
}

function makeFighter(id: number, spec: (typeof FOE_SKINS)[number]): Fighter {
  const mesh = makeShip(spec.paint);
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  const hp = makeHpBar(spec.paint);
  const spawn = spawnOutboard(0.06 + id * 0.08, 52 + id * 10);
  return {
    id,
    name: spec.name,
    color: spec.paint,
    mesh,
    glow: mesh.getObjectByName("glow") as THREE.Mesh,
    pos: spawn.clone(),
    axisX: new THREE.Vector3(-1, 0, 0),
    axisY: new THREE.Vector3(0, 1, 0),
    axisZ: new THREE.Vector3(0, 0, -1),
    rot: new THREE.Matrix4(),
    mat: new THREE.Matrix4(),
    fwd: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    stickBank: 0,
    stickPitch: 0,
    turbo: 0.15,
    speed: 0,
    hp: MAX_HP,
    alive: true,
    fireCool: 0,
    invuln: 0,
    maneuver: "pursue",
    wantFire: false,
    askAt: performance.now() + 280 + id * 160,
    breakDir: Math.random() < 0.5 ? 1 : -1,
    spawn: spawn.clone(),
    lastShot: -9999,
    bar: hp.bar,
    barFill: hp.barFill,
  };
}

const plane = makeShip(0xe7c14a);
plane.matrixAutoUpdate = false;
scene.add(plane);
const youGlow = plane.getObjectByName("glow") as THREE.Mesh;
const youHp = makeHpBar(0xe7c14a);
const foes = FOE_SKINS.map((s, i) => makeFighter(i, s));
const toVec = new THREE.Vector3();
const aimPoint = new THREE.Vector3();
const huntNdc = new THREE.Vector3();
const huntCamFwd = new THREE.Vector3();
const huntCamPos = new THREE.Vector3();
const laserEnd = new THREE.Vector3();
const hpBillboardQuat = new THREE.Quaternion();

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

let yawVel = 0;
let pitchVel = 0;
let turbo = 0;
let speed = 0;
let crashed = false;
let won = false;
let closeCam = false;
let bannerUntil = 0;
let playerHp = MAX_HP;
let playerInvuln = 0;
let specI = 0;
let specAt = 0;
let fireCool = 0;
let mouseDown = false;
let lastPlayerShot = -9999;
let jevBusy = false;

const jevBarsRoot = document.querySelector("#jev-bars");
function addHpRow(name: string, color: number): { row: HTMLDivElement; fill: HTMLElement } {
  const row = document.createElement("div");
  row.className = "jev-bar";
  const label = document.createElement("span");
  label.textContent = name;
  const track = document.createElement("i");
  const fill = document.createElement("em");
  fill.style.background = `#${color.toString(16).padStart(6, "0")}`;
  track.append(fill);
  row.append(label, track);
  jevBarsRoot?.append(row);
  return { row, fill };
}
const youBarUi = addHpRow("YOU", 0xe7c14a);
const jevBarUi = foes.map((f) => addHpRow(f.name, f.color));

const beamGeo = new THREE.CylinderGeometry(0.07, 0.07, 1, 5);
beamGeo.rotateX(Math.PI / 2);
const youLaserMat = new THREE.MeshBasicMaterial({ color: 0x9bffd8, transparent: true, opacity: 0.95 });
const jevLaserMat = new THREE.MeshBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.95 });
const beams: Beam[] = [];

type SpaceAudio = { ctx: AudioContext; master: GainNode };
let audio: SpaceAudio | null = null;
function ensureAudio(): void {
  if (audio) return;
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.28;
  master.connect(ctx.destination);
  audio = { ctx, master };
}
function playLaser(): void {
  if (!audio) return;
  const { ctx, master } = audio;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(880, ctx.currentTime);
  o.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + 0.09);
  g.gain.setValueAtTime(0.09, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.1);
  o.connect(g);
  g.connect(master);
  o.start();
  o.stop(ctx.currentTime + 0.12);
}
function playBoom(): void {
  if (!audio) return;
  const { ctx, master } = audio;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(90, ctx.currentTime);
  o.frequency.exponentialRampToValueAtTime(28, ctx.currentTime + 0.3);
  g.gain.setValueAtTime(0.35, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  o.connect(g);
  g.connect(master);
  o.start();
  o.stop(ctx.currentTime + 0.36);
}

function headingDeg(fwd: THREE.Vector3): number {
  return Math.round(((Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI + 360) % 360);
}
function clockLabel(bearing: number): string {
  let hour = Math.round((((bearing * 180) / Math.PI + 360) % 360) / 30);
  if (hour === 0) hour = 12;
  return `${hour} o'clock`;
}
function orthonormalize(x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3): void {
  z.normalize();
  x.crossVectors(y, z).normalize();
  y.crossVectors(z, x).normalize();
}
function sight(from: THREE.Vector3, fwd: THREE.Vector3, right: THREE.Vector3, upV: THREE.Vector3, to: THREE.Vector3) {
  toVec.copy(to).sub(from);
  const range = toVec.length();
  if (range < 0.001) return { range: 0, bearing: 0, elevation: 0, along: 1, lined: false };
  toVec.multiplyScalar(1 / range);
  const along = toVec.dot(fwd);
  const bearing = Math.atan2(toVec.dot(right), along);
  const elevation = Math.asin(THREE.MathUtils.clamp(toVec.dot(upV), -1, 1));
  return {
    range,
    bearing,
    elevation,
    along,
    lined: along > 0.35 && Math.abs(bearing) < 0.16 && Math.abs(elevation) < 0.14,
  };
}

function livingFoes(): Fighter[] {
  return foes.filter((f) => f.alive);
}
function playerShooting(): boolean {
  return held("Space") || mouseDown || performance.now() - lastPlayerShot < 280;
}
function asHuntFromPlayer(): Hunt {
  return {
    pos: planePosition,
    fwd: forward,
    right: axisX,
    up: axisY,
    hp: playerHp,
    speed,
    shooting: playerShooting(),
    label: "you",
  };
}
function asHuntFromFoe(o: Fighter): Hunt {
  return {
    pos: o.pos,
    fwd: o.fwd,
    right: o.axisX,
    up: o.axisY,
    hp: o.hp,
    speed: o.speed,
    shooting: performance.now() - o.lastShot < 280,
    label: o.name,
  };
}
function bestHunt(f: Fighter): Hunt | null {
  let best: Hunt | null = null;
  let bestScore = -Infinity;
  const consider = (h: Hunt) => {
    const you = sight(f.pos, f.fwd, f.axisX, f.axisY, h.pos);
    let score = (you.lined ? 52 : 0) + (1 - Math.abs(you.bearing)) * 24 - you.range * 0.06;
    if (h.label === "you") score += 6;
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  };
  if (!crashed && playerHp > 0) consider(asHuntFromPlayer());
  for (const o of livingFoes()) {
    if (o.id !== f.id) consider(asHuntFromFoe(o));
  }
  return best;
}
function gunsOnMe(f: Fighter): Hunt | null {
  let best: Hunt | null = null;
  let bestAlong = 0.28;
  const consider = (h: Hunt) => {
    const them = sight(h.pos, h.fwd, h.right, h.up, f.pos);
    if (them.range > 420 || them.along < bestAlong) return;
    bestAlong = them.along;
    best = h;
  };
  if (!crashed && playerHp > 0) consider(asHuntFromPlayer());
  for (const o of livingFoes()) {
    if (o.id !== f.id) consider(asHuntFromFoe(o));
  }
  return best;
}

function nearestBodyName(p: THREE.Vector3): string {
  let name = "Sun";
  let best = p.length();
  if (best < SUN_R * 3) return "Sun";
  for (const b of bodies) {
    const d = p.distanceTo(b.mesh.position) - b.radius;
    if (d < best) {
      best = d;
      name = b.name;
    }
  }
  return name;
}

function logDecision(kind: string, text: string): void {
  if (!feedList) return;
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = text;
  feedList.prepend(li);
  while (feedList.children.length > 10) feedList.removeChild(feedList.lastChild as Node);
}

function spawnBeam(from: THREE.Vector3, to: THREE.Vector3, yours: boolean): void {
  const mesh = new THREE.Mesh(beamGeo, yours ? youLaserMat : jevLaserMat);
  const len = Math.max(1, from.distanceTo(to));
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.lookAt(to);
  mesh.scale.set(1, 1, len);
  scene.add(mesh);
  beams.push({ mesh, life: 0.11 });
}

function laserHits(from: THREE.Vector3, dir: THREE.Vector3, skipYou: boolean, skipId: number | null): { who: "you" | number; at: THREE.Vector3 } | null {
  laserEnd.copy(from).addScaledVector(dir, LASER_RANGE);
  let bestT = 1;
  let who: "you" | number | null = null;
  const check = (pos: THREE.Vector3, id: "you" | number) => {
    toVec.copy(pos).sub(from);
    const t = toVec.dot(dir) / LASER_RANGE;
    if (t < 0.02 || t > bestT) return;
    const closest = from.clone().addScaledVector(dir, t * LASER_RANGE);
    if (closest.distanceTo(pos) < HIT_R) {
      bestT = t;
      who = id;
    }
  };
  if (!skipYou && !crashed && playerHp > 0) check(planePosition, "you");
  for (const f of livingFoes()) {
    if (skipId === f.id) continue;
    check(f.pos, f.id);
  }
  if (who === null) return null;
  return { who, at: from.clone().addScaledVector(dir, bestT * LASER_RANGE) };
}

function fireLaser(owner: "you" | number, from: THREE.Vector3, dir: THREE.Vector3): void {
  const hit = laserHits(from, dir, owner === "you", owner === "you" ? null : owner);
  const end = hit ? hit.at : from.clone().addScaledVector(dir, LASER_RANGE);
  spawnBeam(from.clone().addScaledVector(dir, 2.2), end, owner === "you");
  if (owner === "you") lastPlayerShot = performance.now();
  else foes[owner]!.lastShot = performance.now();
  playLaser();
  if (!hit) return;
  if (hit.who === "you") damagePlayer();
  else damageFoe(foes[hit.who]!);
}

function maybeLast(): void {
  const live = livingFoes();
  const youLive = !watchMode && !crashed && playerHp > 0;
  if (youLive && live.length === 0) {
    won = true;
    banner.classList.remove("is-hidden");
    bannerText.textContent = "Last ship standing. R to scramble again.";
    statusAction.textContent = "LAST";
    bannerUntil = Infinity;
    return;
  }
  if (!youLive && live.length <= 1) {
    won = true;
    banner.classList.remove("is-hidden");
    bannerText.textContent = live[0] ? `${live[0].name} holds the system. R to scramble.` : "All ships down.";
    statusAction.textContent = "LAST";
    bannerUntil = Infinity;
  }
}

function damagePlayer(): void {
  if (watchMode || playerInvuln > 0 || crashed) return;
  playerHp -= 1;
  playerInvuln = 0.7;
  playBoom();
  if (playerHp <= 0) crash("Hull gone. Spectating — C to cycle.");
}
function damageFoe(f: Fighter): void {
  if (!f.alive || f.invuln > 0) return;
  f.hp -= 1;
  f.invuln = 0.7;
  playBoom();
  if (f.hp <= 0) {
    f.alive = false;
    f.mesh.visible = false;
    f.bar.visible = false;
    logDecision("flap", `${f.name} DOWN`);
    maybeLast();
  }
}

function specFoe(): Fighter | null {
  const live = livingFoes();
  if (!live.length) return null;
  specI = ((specI % live.length) + live.length) % live.length;
  return live[specI]!;
}

function crash(reason: string): void {
  crashed = true;
  turbo = 0;
  plane.visible = false;
  youHp.bar.visible = false;
  banner.classList.remove("is-hidden");
  bannerText.textContent = reason;
  statusAction.textContent = livingFoes().length ? "SPECTATE" : "DOWN";
  statusMeta.textContent = livingFoes().length ? "C to cycle · R restart" : "R to restart";
  bannerUntil = livingFoes().length ? performance.now() + 4000 : Infinity;
  playBoom();
  maybeLast();
}

function bodyHit(p: THREE.Vector3): string | null {
  if (p.length() < SUN_R + 10) return "You flew into the Sun.";
  for (const b of bodies) {
    if (p.distanceTo(b.mesh.position) < b.radius + 8) return `Impact: ${b.name}.`;
  }
  return null;
}

function huntManeuver(lined: boolean, shotAt: boolean, range: number): FlightManeuver {
  if (lined) return "guns";
  if (shotAt) return "break";
  if (range < 180) return "lead";
  return "pursue";
}

function snapshotFlight(f: Fighter, hunt: Hunt): SpaceSnapshot {
  const you = sight(f.pos, f.fwd, f.axisX, f.axisY, hunt.pos);
  const them = sight(hunt.pos, hunt.fwd, hunt.right, hunt.up, f.pos);
  const alt = hunt.pos.y - f.pos.y;
  return {
    rules:
      `You are ${f.name} in a solar-system furball. Laser the ship in foe. Last standing wins. ` +
      "Stay nose-forward. Turn to face threats; never flip in place. Do not run.",
    you: {
      hp: f.hp,
      x: Math.round(f.pos.x),
      y: Math.round(f.pos.y),
      z: Math.round(f.pos.z),
      heading_deg: headingDeg(f.fwd),
      speed: Math.round(f.speed),
    },
    foe: {
      hp: hunt.hp,
      x: Math.round(hunt.pos.x),
      y: Math.round(hunt.pos.y),
      z: Math.round(hunt.pos.z),
      heading_deg: headingDeg(hunt.fwd),
      speed: Math.round(hunt.speed),
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
      they_are_shooting: hunt.shooting,
      they_are_shooting_at_you: hunt.shooting && them.lined,
      closing: you.along > 0.15,
      alt_diff: Math.round(alt),
    },
  };
}

async function askJev(f: Fighter): Promise<void> {
  if (jevBusy || !f.alive) return;
  const hunt = bestHunt(f);
  if (!hunt) return;
  jevBusy = true;
  const t0 = performance.now();
  const you = sight(f.pos, f.fwd, f.axisX, f.axisY, hunt.pos);
  const them = sight(hunt.pos, hunt.fwd, hunt.right, hunt.up, f.pos);
  try {
    const res = await fetch("/api/space", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshotFlight(f, hunt)),
    });
    const ms = Math.round(performance.now() - t0);
    recordLatency(ms);
    const data = (await res.json()) as SpacePilotResponse;
    if (!res.ok) throw new Error(data.detail || data.error || `http ${res.status}`);
    const shotAt = hunt.shooting && them.lined;
    let next = data.maneuver ?? huntManeuver(you.lined, shotAt, you.range);
    if (next === "extend" || next === "reverse") next = "pursue";
    if (next === "break" && !shotAt) next = you.lined ? "guns" : "pursue";
    f.maneuver = next;
    f.wantFire = Number(data.fire ?? 0) >= 0.35 || you.lined;
    statusAction.textContent = `${f.name}  ${f.maneuver.toUpperCase()}`;
    statusMeta.textContent = `${ms}ms · vs ${hunt.label} · ${nearestBodyName(f.pos)}`;
    logDecision(f.wantFire ? "flap" : "wait", `${f.name} ${f.maneuver.toUpperCase()}  ${ms}ms`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Jev call failed";
    statusAction.textContent = "ERROR";
    statusMeta.textContent = message;
    f.maneuver = huntManeuver(you.lined, hunt.shooting && them.lined, you.range);
    f.wantFire = true;
  } finally {
    jevBusy = false;
    f.askAt = performance.now() + (hunt.shooting ? 700 : 1100);
  }
}

function nextJevAsk(): Fighter | null {
  const now = performance.now();
  let pick: Fighter | null = null;
  for (const f of livingFoes()) {
    if (now < f.askAt) continue;
    if (!pick || f.askAt < pick.askAt) pick = f;
  }
  return pick;
}

function steerFoe(f: Fighter, hunt: Hunt): { bank: number; pitch: number; turboOn: boolean } {
  const you = sight(f.pos, f.fwd, f.axisX, f.axisY, hunt.pos);
  const them = sight(hunt.pos, hunt.fwd, hunt.right, hunt.up, f.pos);
  const leadAmt = THREE.MathUtils.clamp(you.range * 0.16, 8, 50);
  aimPoint.copy(hunt.pos).addScaledVector(hunt.fwd, leadAmt);
  const lead = sight(f.pos, f.fwd, f.axisX, f.axisY, aimPoint);
  const look = f.maneuver === "guns" ? you : lead;
  let bank = 0;
  let pitch = 0;
  if (look.bearing > 0.04) bank = -1;
  else if (look.bearing < -0.04) bank = 1;
  if (look.elevation > 0.04) pitch = 1;
  else if (look.elevation < -0.04) pitch = -1;
  if (f.maneuver === "break") bank = f.breakDir * 0.5;
  const sunDist = f.pos.length();
  if (sunDist < SUN_R + 80) {
    pitch = f.pos.y > 0 ? 0.4 : -0.4;
    bank *= 0.4;
  }
  const turboOn = you.range > 160 && Math.abs(look.bearing) < 0.8;
  void them;
  return { bank, pitch, turboOn };
}

function placeHpBar(bar: THREE.Group, fill: THREE.Mesh, pos: THREE.Vector3, upV: THREE.Vector3, hp: number, color: number, show: boolean): void {
  const t = THREE.MathUtils.clamp(hp / MAX_HP, 0, 1);
  bar.visible = show && hp > 0;
  if (!bar.visible) return;
  bar.position.copy(pos).addScaledVector(upV, 8.2);
  bar.quaternion.copy(hpBillboardQuat);
  fill.scale.x = Math.max(0.02, t);
  fill.position.x = -0.725 * (1 - t);
  (fill.material as THREE.MeshBasicMaterial).color.setHex(t > 0.4 ? color : 0xff3b30);
}

function syncHpUi(): void {
  youBarUi.fill.style.transform = `scaleX(${THREE.MathUtils.clamp(playerHp / MAX_HP, 0, 1)})`;
  youBarUi.row.classList.toggle("is-out", playerHp <= 0);
  for (let i = 0; i < foes.length; i++) {
    const f = foes[i]!;
    const ui = jevBarUi[i]!;
    ui.fill.style.transform = `scaleX(${THREE.MathUtils.clamp(f.hp / MAX_HP, 0, 1)})`;
    ui.row.classList.toggle("is-out", !f.alive);
  }
}

function reset(): void {
  placeBodies();
  axisX.set(1, 0, 0);
  axisY.set(0, 1, 0);
  axisZ.set(0, 0, 1);
  planePosition.copy(spawnOutboard(0, 70));
  lookToward(planePosition, new THREE.Vector3(0, 0, 0), axisX, axisY, axisZ);
  yawVel = 0;
  pitchVel = 0;
  turbo = 0;
  speed = CRUISE;
  crashed = false;
  won = false;
  fireCool = 0;
  playerHp = MAX_HP;
  playerInvuln = 0;
  plane.visible = true;
  if (watchMode) {
    crashed = true;
    playerHp = 0;
    plane.visible = false;
    youHp.bar.visible = false;
  }
  youBarUi.row.style.display = watchMode ? "none" : "";
  specI = 0;
  specAt = performance.now();
  jevBusy = false;
  for (const f of foes) {
    f.hp = MAX_HP;
    f.alive = true;
    f.mesh.visible = true;
    f.invuln = 0;
    f.yaw = 0;
    f.pitch = 0;
    f.stickBank = 0;
    f.stickPitch = 0;
    f.turbo = 0.12;
    f.fireCool = 0;
    f.maneuver = "pursue";
    f.wantFire = false;
    f.askAt = performance.now() + 300 + f.id * 150;
    f.pos.copy(spawnOutboard(0.05 + f.id * 0.07, 58 + f.id * 12));
    lookToward(f.pos, new THREE.Vector3(0, 0, 0), f.axisX, f.axisY, f.axisZ);
    f.fwd.copy(f.axisZ).negate();
  }
  for (const b of beams) scene.remove(b.mesh);
  beams.length = 0;
  delayedQuaternion.identity();
  camera.fov = 62;
  camera.updateProjectionMatrix();
  banner.classList.remove("is-hidden");
  if (watchMode) {
    bannerText.textContent = "Watching Jevs. C cycles cameras. Last ship standing.";
    bannerUntil = performance.now() + 3800;
    statusAction.textContent = "WATCH";
    statusMeta.textContent = "Jev vs Jev near Earth";
  } else {
    bannerText.textContent = "Solar furball. Lasers only. Last ship standing.";
    bannerUntil = performance.now() + 4200;
    statusAction.textContent = "SCRAMBLE";
    statusMeta.textContent = "near Earth";
  }
  feedList?.replaceChildren();
}

function drawRadar(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const css = 176;
  if (radarCanvas.width !== css * dpr) {
    radarCanvas.width = css * dpr;
    radarCanvas.height = css * dpr;
  }
  const ctx = radarCtx;
  const w = radarCanvas.width;
  const cx = w / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, w);
  ctx.fillStyle = "rgba(4, 10, 22, 0.82)";
  ctx.beginPath();
  ctx.arc(cx, cx, w * 0.48, 0, Math.PI * 2);
  ctx.fill();
  const span = NEPTUNE_MAP;
  const scale = (w * 0.44) / span;
  const plot = (x: number, z: number, col: string, r: number) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(cx + x * scale, cx + z * scale, r, 0, Math.PI * 2);
    ctx.fill();
  };
  ctx.fillStyle = "#ffe08a";
  ctx.beginPath();
  ctx.arc(cx, cx, 4, 0, Math.PI * 2);
  ctx.fill();
  for (const b of bodies) {
    plot(b.mesh.position.x, b.mesh.position.z, "#8ab4ff", b.au < 2 ? 2.4 : 3.2);
  }
  if (!crashed) plot(planePosition.x, planePosition.z, "#ffe566", 3.4);
  for (const f of livingFoes()) plot(f.pos.x, f.pos.z, `#${f.color.toString(16).padStart(6, "0")}`, 3);
  const near = livingFoes()
    .map((f) => f.pos.distanceTo(planePosition))
    .sort((a, b) => a - b)[0];
  radarRng.textContent = near != null ? near.toFixed(0) : "—";
  radarAlt.textContent = nearestBodyName(crashed ? specFoe()?.pos ?? planePosition : planePosition);
}

const NEPTUNE_MAP = 30.07 * AU;

function drawHuntArrows(): void {
  const cssW = huntCanvas.clientWidth || canvas.clientWidth || 1280;
  const cssH = huntCanvas.clientHeight || canvas.clientHeight || 720;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(cssH * dpr));
  if (huntCanvas.width !== bw || huntCanvas.height !== bh) {
    huntCanvas.width = bw;
    huntCanvas.height = bh;
  }
  const ctx = huntCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  camera.updateMatrixWorld(true);
  camera.getWorldPosition(huntCamPos);
  camera.getWorldDirection(huntCamFwd);
  const viewFoe = crashed ? specFoe() : null;
  const hw = cssW * 0.5 - 22;
  const hh = cssH * 0.5 - 54;
  for (const f of livingFoes()) {
    if (viewFoe && f.id === viewFoe.id) continue;
    huntNdc.copy(f.pos).project(camera);
    let nx = huntNdc.x;
    let ny = huntNdc.y;
    const toX = f.pos.x - huntCamPos.x;
    const toY = f.pos.y - huntCamPos.y;
    const toZ = f.pos.z - huntCamPos.z;
    if (toX * huntCamFwd.x + toY * huntCamFwd.y + toZ * huntCamFwd.z < 0) {
      nx = -nx;
      ny = -ny;
    }
    let dx = nx;
    let dy = -ny;
    if (Math.hypot(dx, dy) < 1e-4) dy = -1;
    const t = Math.min(Math.abs(dx) < 1e-5 ? Infinity : hw / Math.abs(dx), Math.abs(dy) < 1e-5 ? Infinity : hh / Math.abs(dy));
    const x = cssW * 0.5 + dx * t;
    const y = cssH * 0.5 + dy * t;
    const col = `#${f.color.toString(16).padStart(6, "0")}`;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-11, 11);
    ctx.lineTo(-5, 0);
    ctx.lineTo(-11, -11);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.strokeStyle = "rgba(8,12,16,0.75)";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
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
    if (!crashed && fireCool <= 0) {
      fireLaser("you", planePosition.clone().addScaledVector(forward, 4), forward.clone());
      fireCool = 0.16;
    }
  }
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("pointerup", () => {
  mouseDown = false;
});
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyR") reset();
  if (e.code === "KeyC") {
    if (watchMode || crashed) {
      specI += 1;
      specAt = performance.now();
    } else closeCam = !closeCam;
  }
  if (e.code === "Space") ensureAudio();
});

reset();
resize();
const clock = new THREE.Clock();

function tick(): void {
  const dt = Math.min(clock.getDelta(), 0.05);
  const frames = dt * 60;
  requestAnimationFrame(tick);
  playerInvuln = Math.max(0, playerInvuln - dt);
  for (const f of foes) f.invuln = Math.max(0, f.invuln - dt);
  const ask = nextJevAsk();
  if (ask) void askJev(ask);

  for (const b of bodies) {
    b.angle += (dt * Math.PI * 2) / b.period;
    const r = b.au * AU;
    b.mesh.position.set(Math.cos(b.angle) * r, Math.sin(b.angle) * b.tilt * r, Math.sin(b.angle) * r);
    b.mesh.rotation.y += dt * 0.15;
  }
  const earth = bodies[2]!;
  moonAngle += dt * 0.55;
  moon.position.copy(earth.mesh.position).add(new THREE.Vector3(Math.cos(moonAngle) * 38, 4, Math.sin(moonAngle) * 38));

  if (!crashed && !won) {
    yawVel *= Math.pow(0.95, frames);
    pitchVel *= Math.pow(0.95, frames);
    if (held("KeyA") || held("ArrowLeft")) yawVel += TURN_ACCEL * frames;
    if (held("KeyD") || held("ArrowRight")) yawVel -= TURN_ACCEL * frames;
    if (held("KeyW") || held("ArrowUp")) pitchVel -= TURN_ACCEL * frames;
    if (held("KeyS") || held("ArrowDown")) pitchVel += TURN_ACCEL * frames;
    if (held("KeyQ")) {
      axisX.applyAxisAngle(axisY, 0.016 * frames);
      axisZ.applyAxisAngle(axisY, 0.016 * frames);
    }
    if (held("KeyE")) {
      axisX.applyAxisAngle(axisY, -0.016 * frames);
      axisZ.applyAxisAngle(axisY, -0.016 * frames);
    }
    yawVel = THREE.MathUtils.clamp(yawVel, -MAX_TURN, MAX_TURN);
    pitchVel = THREE.MathUtils.clamp(pitchVel, -MAX_TURN, MAX_TURN);
    axisX.applyAxisAngle(axisZ, yawVel);
    axisY.applyAxisAngle(axisZ, yawVel);
    axisY.applyAxisAngle(axisX, pitchVel);
    axisZ.applyAxisAngle(axisX, pitchVel);
    orthonormalize(axisX, axisY, axisZ);
    if (held("ShiftLeft") || held("ShiftRight")) turbo = Math.min(1, turbo + 0.02 * frames);
    else turbo *= Math.pow(0.95, frames);
    const boost = easeOut(turbo) * 3.4;
    speed = (CRUISE + boost) * 60;
    planePosition.addScaledVector(axisZ, -(CRUISE + boost) * frames);
    camera.fov = THREE.MathUtils.lerp(camera.fov, 62 + turbo * 14, 1 - Math.exp(-dt * 6));
    camera.updateProjectionMatrix();
    const smash = bodyHit(planePosition);
    if (smash) crash(smash);
  }

  rotMatrix.makeBasis(axisX, axisY, axisZ);
  planeMatrix.makeTranslation(planePosition.x, planePosition.y, planePosition.z).multiply(rotMatrix);
  plane.matrix.copy(planeMatrix);
  plane.matrixWorldNeedsUpdate = true;
  (youGlow.material as THREE.MeshBasicMaterial).color.setHex(turbo > 0.3 ? 0xb4fff0 : 0x6aa8ff);

  for (const f of livingFoes()) {
    const hunt = gunsOnMe(f) ?? bestHunt(f);
    const stick = hunt ? steerFoe(f, hunt) : { bank: 0, pitch: 0, turboOn: false };
    f.stickBank += (stick.bank - f.stickBank) * Math.min(1, 0.035 * frames);
    f.stickPitch += (stick.pitch - f.stickPitch) * Math.min(1, 0.035 * frames);
    const load = Math.hypot(f.stickBank, f.stickPitch);
    if (load > 1) {
      f.stickBank /= load;
      f.stickPitch /= load;
    }
    f.yaw *= Math.pow(0.95, frames);
    f.pitch *= Math.pow(0.95, frames);
    f.yaw += f.stickBank * FOE_TURN_ACCEL * frames;
    f.pitch += f.stickPitch * FOE_TURN_ACCEL * frames;
    f.yaw = THREE.MathUtils.clamp(f.yaw, -FOE_MAX_TURN, FOE_MAX_TURN);
    f.pitch = THREE.MathUtils.clamp(f.pitch, -FOE_MAX_TURN, FOE_MAX_TURN);
    f.axisX.applyAxisAngle(f.axisZ, f.yaw);
    f.axisY.applyAxisAngle(f.axisZ, f.yaw);
    f.axisY.applyAxisAngle(f.axisX, f.pitch);
    f.axisZ.applyAxisAngle(f.axisX, f.pitch);
    orthonormalize(f.axisX, f.axisY, f.axisZ);
    if (stick.turboOn) f.turbo = Math.min(1, f.turbo + 0.02 * frames);
    else f.turbo *= Math.pow(0.95, frames);
    const chase = hunt
      ? sight(f.pos, f.fwd.copy(f.axisZ).negate(), f.axisX, f.axisY, hunt.pos)
      : { range: 200, bearing: 0, elevation: 0, along: 1, lined: false };
    const foeBoost = easeOut(f.turbo) * 2.6;
    f.speed = (CRUISE + foeBoost) * 60;
    const step = (CRUISE + foeBoost) * frames;
    f.pos.addScaledVector(f.axisZ, -step);
    if (f.pos.length() < SUN_R + 90) f.pos.setLength(SUN_R + 90);
    f.fwd.copy(f.axisZ).negate();
    f.rot.makeBasis(f.axisX, f.axisY, f.axisZ);
    f.mat.makeTranslation(f.pos.x, f.pos.y, f.pos.z).multiply(f.rot);
    f.mesh.matrix.copy(f.mat);
    f.mesh.matrixWorldNeedsUpdate = true;
    f.fireCool = Math.max(0, f.fireCool - dt);
    const onTarget = hunt != null && chase.along > 0.25 && Math.abs(chase.bearing) < 0.22 && Math.abs(chase.elevation) < 0.2;
    if (f.fireCool <= 0 && onTarget && (f.wantFire || onTarget)) {
      fireLaser(f.id, f.pos.clone().addScaledVector(f.fwd, 4), f.fwd.clone());
      f.fireCool = 0.18;
    }
  }

  if (crashed && livingFoes().length && performance.now() - specAt > 7500) {
    specI += 1;
    specAt = performance.now();
  }

  const viewFoe = crashed ? specFoe() : null;
  const camPos = viewFoe ? viewFoe.pos : planePosition;
  const camRotSrc = viewFoe ? viewFoe.rot : rotMatrix;
  quatFrom.copy(delayedQuaternion);
  quatTo.setFromRotationMatrix(camRotSrc);
  delayedQuaternion.copy(quatFrom).slerp(quatTo, 1 - Math.pow(1 - 0.16, frames));
  delayedRotMatrix.makeRotationFromQuaternion(delayedQuaternion);
  const back = closeCam ? 9 : 22;
  const lift = closeCam ? 1.6 : 3.2;
  camMatrix.makeTranslation(camPos.x, camPos.y, camPos.z);
  camMatrix.multiply(delayedRotMatrix);
  camMatrix.multiply(tiltMatrix.makeRotationX(-0.16));
  camMatrix.multiply(camOffMatrix.makeTranslation(0, lift, back));
  camera.matrix.copy(camMatrix);
  camera.matrixWorldNeedsUpdate = true;
  camera.updateMatrixWorld(true);
  hpBillboardQuat.setFromRotationMatrix(camera.matrixWorld);

  sunLight.position.set(0, 0, 0);
  forward.copy(axisZ).negate();
  up.copy(axisY);

  placeHpBar(youHp.bar, youHp.barFill, planePosition, axisY, playerHp, 0xe7c14a, !crashed && playerHp > 0);
  for (const f of foes) placeHpBar(f.bar, f.barFill, f.pos, f.axisY, f.hp, f.color, f.alive);

  fireCool = Math.max(0, fireCool - dt);
  if (!crashed && (held("Space") || mouseDown) && fireCool <= 0) {
    fireLaser("you", planePosition.clone().addScaledVector(forward, 4), forward.clone());
    fireCool = 0.16;
  }

  for (let i = beams.length - 1; i >= 0; i--) {
    const b = beams[i]!;
    b.life -= dt;
    const mat = b.mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = Math.max(0, b.life / 0.11);
    if (b.life <= 0) {
      scene.remove(b.mesh);
      beams.splice(i, 1);
    }
  }

  const kts = Math.round(speed * 1.15);
  hudSpd.textContent = String(kts);
  hudBody.textContent = nearestBodyName(camPos);
  hudHdg.textContent = String(headingDeg(viewFoe ? viewFoe.fwd : forward)).padStart(3, "0");
  hudThr.textContent = String(Math.round((viewFoe ? viewFoe.turbo : turbo) * 100));
  hudHpYou.textContent = String(Math.max(0, playerHp));
  hudHpJev.textContent = String(livingFoes().length);
  syncHpUi();
  drawRadar();
  drawHuntArrows();
  if (!won && performance.now() > bannerUntil) banner.classList.add("is-hidden");
  renderer.render(scene, camera);
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

tick();
canvas.focus();
initLatencyChart();
