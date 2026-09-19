import { initLatencyChart, recordLatency } from "./latency.ts";
import type {
  WormsFoeView,
  WormsPilotResponse,
  WormsShotLog,
  WormsSnapshot,
  WormsWeapon,
} from "./types.ts";

type Mode = "you-vs-jev" | "you-vs-you" | "jev-vs-jev";

function writeSearch(patch: Record<string, string | null>): void {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (!v) u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  const next = `${u.pathname}${u.search}${u.hash}`;
  if (next !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, "", next);
}

function syncChoiceLinks(): void {
  for (const a of modeButtons) {
    if (!(a instanceof HTMLAnchorElement) || !a.dataset.mode) continue;
    const u = new URL(location.href);
    if (a.dataset.mode === "you-vs-jev") u.searchParams.delete("mode");
    else u.searchParams.set("mode", a.dataset.mode);
    a.href = `${u.pathname}${u.search}`;
  }
  for (const a of weaponButtons) {
    if (!(a instanceof HTMLAnchorElement) || !a.dataset.weapon) continue;
    const u = new URL(location.href);
    if (a.dataset.weapon === "bazooka") u.searchParams.delete("weapon");
    else u.searchParams.set("weapon", a.dataset.weapon);
    a.href = `${u.pathname}${u.search}`;
  }
}
type Team = "you" | "jev";
type Phase = "turn" | "charge" | "fly" | "settle" | "over";
type Worm = {
  id: number;
  name: string;
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  facing: 1 | -1;
  alive: boolean;
  crawl: number;
  crawling: boolean;
  tilt: number;
  spin: number;
};
type Shot = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: WormsWeapon | "bomblet";
  fuse: number;
  windK: number;
  grav: number;
  drag: number;
  thrust: number;
  burn: number;
  turn: number;
  radius: number;
  dmg: number;
  blast: number;
  color: string;
  size: number;
  homing: boolean;
  targetId: number;
  life: number;
  age: number;
  spin: number;
  smoke: number;
};
type Spark = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  kind: "spark" | "smoke" | "dirt" | "flash" | "ring";
  size: number;
  color: string;
};
type PendingShot = {
  team: Team;
  shooter: string;
  target_id: number;
  target_name: string;
  intended_x: number;
  intended_y: number;
  loft: boolean;
  elev: number;
  power: number;
  wind: number;
  weapon: WormsWeapon;
  hit: boolean;
  impact_x: number;
  impact_y: number;
};
type WeaponSpec = {
  id: WormsWeapon;
  label: string;
  windK: number;
  grav: number;
  maxPower: number;
  radius: number;
  dmg: number;
  blast: number;
  color: string;
  size: number;
  split: number;
  homing: boolean;
  drag: number;
  thrust: number;
  burn: number;
  turn: number;
};

const CELL = 2;
const TW = 480;
const TH = 270;
const W = TW * CELL;
const H = TH * CELL;
const WATER = H - 28;
const R = 8;
const GRAVITY = 0.2;
const WALK = 1.25;
const MOVE_BUDGET = 220;
const ELEV_MIN = -1.2;
const ELEV_MAX = 1.45;
const WEAPON_IDS: WormsWeapon[] = ["bazooka", "cluster", "mortar"];
const WEAPON: Record<WormsWeapon, WeaponSpec> = {
  bazooka: {
    id: "bazooka",
    label: "BAZOOKA",
    windK: 0.03,
    grav: 0.175,
    maxPower: 16.8,
    radius: 36,
    dmg: 58,
    blast: 54,
    color: "#f4f0e4",
    size: 4.2,
    split: 0,
    homing: false,
    drag: 0.0028,
    thrust: 0.22,
    burn: 34,
    turn: 0,
  },
  cluster: {
    id: "cluster",
    label: "CLUSTER",
    windK: 0.024,
    grav: 0.185,
    maxPower: 16.4,
    radius: 16,
    dmg: 24,
    blast: 32,
    color: "#e8c14a",
    size: 5,
    split: 1,
    homing: false,
    drag: 0.0036,
    thrust: 0.12,
    burn: 22,
    turn: 0,
  },
  mortar: {
    id: "mortar",
    label: "MORTAR",
    windK: 0.005,
    grav: 0.185,
    maxPower: 21.5,
    radius: 52,
    dmg: 82,
    blast: 74,
    color: "#c4a06a",
    size: 5.6,
    split: 0,
    homing: false,
    drag: 0.0018,
    thrust: 0,
    burn: 0,
    turn: 0,
  },
};

const SHOT_SOUNDS = Array.from(
  { length: 46 },
  (_, i) => `/sounds/shot-${String(i + 1).padStart(2, "0")}.mp3`,
);
const shotPool = SHOT_SOUNDS.map((src) => {
  const audio = new Audio(src);
  audio.preload = "auto";
  return audio;
});
let lastShotIndex = -1;

function unlockAudio(): void {
  const first = shotPool[0];
  if (!first) return;
  void first
    .play()
    .then(() => {
      first.pause();
      first.currentTime = 0;
    })
    .catch(() => undefined);
}

function playIncoming(): void {
  if (!shotPool.length) return;
  let i = Math.floor(Math.random() * shotPool.length);
  if (shotPool.length > 1 && i === lastShotIndex) i = (i + 1) % shotPool.length;
  lastShotIndex = i;
  const src = shotPool[i]!;
  const shot = src.cloneNode(true);
  if (shot instanceof HTMLAudioElement) {
    shot.volume = 0.9;
    void shot.play().catch(() => undefined);
  }
}
const canvasEl = document.getElementById("game");
if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error("Missing #game canvas");
const canvas: HTMLCanvasElement = canvasEl;
const context = canvas.getContext("2d");
if (!context) throw new Error("2D canvas is not available");
const ctx: CanvasRenderingContext2D = context;

const land = document.createElement("canvas");
land.width = W;
land.height = H;
const landContext = land.getContext("2d");
if (!landContext) throw new Error("terrain canvas failed");
const landCtx: CanvasRenderingContext2D = landContext;

const feedAction = document.getElementById("pilot-action");
const feedMeta = document.getElementById("pilot-meta");
const feedList = document.getElementById("decisions");
const modeButtons = document.querySelectorAll<HTMLButtonElement>("[data-mode]");
const weaponButtons = document.querySelectorAll<HTMLButtonElement>("[data-weapon]");

const solid = new Uint8Array(TW * TH);

const state = {
  mode: "you-vs-jev" as Mode,
  phase: "turn" as Phase,
  worms: [] as Worm[],
  turn: 0,
  order: [] as number[],
  elev: 0.7,
  power: 0.62,
  charge: 0,
  moveLeft: MOVE_BUDGET,
  wind: 0,
  weapon: "bazooka" as WormsWeapon,
  shots: [] as Shot[],
  sparks: [] as Spark[],
  boomWait: 0,
  dirty: true,
  keys: { left: false, right: false, up: false, down: false, fire: false },
  fireHeld: false,
  busy: false,
  asked: false,
  jevAim: null as {
    destX: number;
    targetId: number;
    loft: boolean;
    elev: number;
    power: number;
    weapon: WormsWeapon;
    charge: boolean;
    walking: boolean;
    stuck: number;
  } | null,
  pending: null as PendingShot | null,
  shotLog: [] as WormsShotLog[],
};

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function parseMode(raw: string | null): Mode {
  if (raw === "jev-vs-jev" || raw === "you-vs-you") return raw;
  return "you-vs-jev";
}

function teamTag(team: Team): string {
  if (state.mode === "you-vs-you") return team === "you" ? "P1" : "P2";
  if (team === "you" && state.mode === "you-vs-jev") return "YOU";
  return "JEV";
}

function parseWeapon(raw: string | undefined): WormsWeapon | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase().trim();
  if (s === "bazooka" || s === "cluster" || s === "mortar") return s;
  return WEAPON_IDS.find((id) => s.includes(id));
}

function setWeapon(id: WormsWeapon): void {
  state.weapon = id;
  for (const btn of weaponButtons) btn.classList.toggle("is-active", btn.dataset.weapon === id);
  writeSearch({ weapon: id === "bazooka" ? null : id });
  syncChoiceLinks();
  const w = current();
  if (w && (state.phase === "turn" || state.phase === "charge")) {
    setStatus(
      `${teamTag(w.team)} · ${w.name}`,
      `wind ${state.wind >= 0 ? "+" : ""}${state.wind} · ${WEAPON[id].label}`,
    );
  }
}

function addFx(
  x: number,
  y: number,
  vx: number,
  vy: number,
  life: number,
  kind: Spark["kind"],
  size: number,
  color: string,
): void {
  state.sparks.push({ x, y, vx, vy, life, max: life, kind, size, color });
}

function burst(px: number, py: number, n: number, color: string, power = 3.2): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 0.6 + Math.random() * power;
    addFx(px, py, Math.cos(a) * s, Math.sin(a) * s - 0.8, 14 + Math.random() * 16, "spark", 2 + Math.random() * 2, color);
  }
}

function flightStep(
  x: number,
  y: number,
  vx: number,
  vy: number,
  f: {
    windK: number;
    grav: number;
    drag: number;
    thrust: number;
    homing: boolean;
    turn: number;
    target: { x: number; y: number } | null;
  },
  dt: number,
): { x: number; y: number; vx: number; vy: number } {
  if (f.homing && f.target) {
    const dx = f.target.x - x;
    const dy = f.target.y - 8 - y;
    const desired = Math.atan2(dy, dx);
    const heading = Math.atan2(vy, vx);
    let diff = desired - heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    diff = clamp(diff, -f.turn * dt, f.turn * dt);
    const speed = Math.max(3.4, Math.hypot(vx, vy));
    const h = heading + diff;
    vx = Math.cos(h) * speed;
    vy = Math.sin(h) * speed;
    vx += Math.cos(h) * f.thrust * dt;
    vy += Math.sin(h) * f.thrust * dt;
  } else if (f.thrust > 0) {
    const speed = Math.hypot(vx, vy) || 1;
    vx += (vx / speed) * f.thrust * dt;
    vy += (vy / speed) * f.thrust * dt;
  }
  const spd = Math.hypot(vx, vy);
  const drag = f.drag * spd;
  vx -= vx * drag * dt;
  vy -= vy * drag * dt;
  vx += state.wind * f.windK * dt;
  vy += f.grav * dt;
  x += vx * dt;
  y += vy * dt;
  return { x, y, vx, vy };
}

function shotTarget(id: number): { x: number; y: number } | null {
  const foe = living().find((w) => w.id === id);
  return foe ? { x: foe.x, y: foe.y } : null;
}

function shotFromSpec(
  spec: WeaponSpec,
  x: number,
  y: number,
  vx: number,
  vy: number,
  kind: Shot["kind"],
  targetId: number,
  fuse = spec.split,
): Shot {
  const bomblet = kind === "bomblet";
  return {
    x,
    y,
    vx,
    vy,
    kind,
    fuse,
    windK: bomblet ? spec.windK + 0.014 : spec.windK,
    grav: bomblet ? spec.grav + 0.03 : spec.grav,
    drag: bomblet ? 0.012 : spec.drag,
    thrust: bomblet ? 0 : spec.thrust,
    burn: bomblet ? 0 : spec.burn,
    turn: spec.turn,
    radius: bomblet ? 14 : spec.radius,
    dmg: bomblet ? 22 : spec.dmg,
    blast: bomblet ? 30 : spec.blast,
    color: spec.color,
    size: bomblet ? 2.5 : spec.size,
    homing: spec.homing && !bomblet,
    targetId,
    life: bomblet ? 110 : 320,
    age: 0,
    spin: bomblet ? (Math.random() - 0.5) * 0.4 : 0,
    smoke: 0,
  };
}

function splitCluster(s: Shot): Shot[] {
  const spec = WEAPON.cluster;
  const heading = Math.atan2(s.vy, s.vx);
  const speed = Math.hypot(s.vx, s.vy);
  addFx(s.x, s.y, 0, 0, 10, "flash", 18, "#fff4c8");
  burst(s.x, s.y, 14, "#ffd36b", 2.8);
  const bits: Shot[] = [];
  for (let k = -2; k <= 2; k++) {
    const a = heading + k * 0.32 + (Math.random() - 0.5) * 0.1;
    const spd = speed * (0.68 + Math.abs(k) * 0.07) + 1.8;
    bits.push(
      shotFromSpec(
        spec,
        s.x,
        s.y,
        Math.cos(a) * spd,
        Math.sin(a) * spd + 0.55,
        "bomblet",
        s.targetId,
        0,
      ),
    );
  }
  return bits;
}

function idx(cx: number, cy: number): number {
  return cy * TW + cx;
}

function inGrid(cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx < TW && cy < TH;
}

function isSolid(px: number, py: number): boolean {
  const cx = Math.floor(px / CELL);
  const cy = Math.floor(py / CELL);
  if (!inGrid(cx, cy)) return false;
  if (py >= WATER) return false;
  return solid[idx(cx, cy)] === 1;
}

function setCell(cx: number, cy: number, v: 0 | 1): void {
  if (inGrid(cx, cy) && cy < TH - 14) solid[idx(cx, cy)] = v;
}

function carve(px: number, py: number, radius: number): void {
  const r = radius / CELL;
  const ccx = px / CELL;
  const ccy = py / CELL;
  const r2 = r * r;
  for (let y = Math.floor(ccy - r); y <= ccy + r; y++) {
    for (let x = Math.floor(ccx - r); x <= ccx + r; x++) {
      const dx = x + 0.5 - ccx;
      const dy = y + 0.5 - ccy;
      if (dx * dx + dy * dy <= r2) setCell(x, y, 0);
    }
  }
  state.dirty = true;
}

function fillDisk(cx: number, cy: number, rx: number, ry: number, v: 0 | 1): void {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) setCell(x, y, v);
    }
  }
}

function buildLand(): void {
  solid.fill(0);
  for (let x = 0; x < TW; x++) {
    const t = x / TW;
    let top = TH;
    if (t < 0.46) top = (0.1 + t * 0.82 + 0.035 * Math.sin(x / 9)) * TH;
    if (t > 0.5) top = Math.min(top, (0.38 + (t - 0.5) * 0.28 + 0.03 * Math.sin(x / 11)) * TH);
    for (let y = Math.floor(top); y < TH - 14; y++) setCell(x, y, 1);
  }
  fillDisk(TW * 0.4, TH * 0.52, 92, 64, 0);
  for (let x = Math.floor(TW * 0.46); x < TW * 0.71; x++) {
    const dip = 6 * Math.sin((x - TW * 0.46) / 14);
    for (let y = Math.floor(TH * 0.45 + dip); y < TH * 0.53 + dip; y++) setCell(x, y, 1);
  }
  fillDisk(TW * 0.78, TH * 0.7, 28, 22, 0);
  state.dirty = true;
}

function paintLand(): void {
  if (!state.dirty) return;
  landCtx.clearRect(0, 0, W, H);
  for (let cy = 0; cy < TH - 14; cy++) {
    for (let cx = 0; cx < TW; cx++) {
      if (solid[idx(cx, cy)] !== 1) continue;
      const surface = cy === 0 || solid[idx(cx, cy - 1)] !== 1;
      const n = (cx * 17 + cy * 31) & 7;
      if (surface) landCtx.fillStyle = n > 5 ? "#d7b07a" : "#c4a06a";
      else landCtx.fillStyle = n > 5 ? "#7a1830" : n > 2 ? "#9a2240" : "#861c36";
      landCtx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
    }
  }
  state.dirty = false;
}

function surfaceY(px: number): number {
  const cx = clamp(Math.floor(px / CELL), 0, TW - 1);
  for (let cy = 0; cy < TH - 14; cy++) {
    if (solid[idx(cx, cy)] === 1) return cy * CELL;
  }
  return WATER + 8;
}

function blocked(x: number, y: number): boolean {
  return isSolid(x, y - 7) || isSolid(x, y - 2);
}

function onGround(x: number, y: number): boolean {
  const foot = y + R;
  return isSolid(x, foot) || isSolid(x - 3, foot) || isSolid(x + 3, foot);
}

function placeAt(x: number, y: number): number | null {
  for (let climb = 0; climb <= 16; climb++) {
    const ny = y - climb;
    if (!blocked(x, ny) && onGround(x, ny)) return ny;
  }
  for (let drop = 1; drop <= 18; drop++) {
    const ny = y + drop;
    if (ny + R >= WATER - 4) break;
    if (!blocked(x, ny) && onGround(x, ny)) return ny;
  }
  return null;
}

function settleWorm(w: Worm, dt: number): void {
  if (!w.alive) return;
  if (w.y + R >= WATER - 2) {
    w.hp = 0;
    w.alive = false;
    return;
  }
  const airborne = !onGround(w.x, w.y);
  const rolling = Math.abs(w.vx) > 0.5 || Math.abs(w.spin) > 0.07;

  if (airborne) {
    w.vy += GRAVITY * 1.35 * dt;
    w.y += w.vy * dt;
    w.x += w.vx * dt;
    w.vx *= 0.992;
    w.spin *= 0.97;
    w.tilt = clamp(w.tilt + w.spin * dt, -0.55, 0.55);
    if (w.x < 16 || w.x > W - 16) {
      w.x = clamp(w.x, 16, W - 16);
      w.vx *= -0.45;
      w.spin *= -0.4;
    }
    if (onGround(w.x, w.y)) {
      const snapped = placeAt(w.x, w.y);
      if (snapped != null) w.y = snapped;
      w.spin += clamp(w.vx * 0.03, -0.08, 0.08);
      if (Math.abs(w.vy) > 1.6) w.vy *= -0.18;
      else w.vy = 0;
    }
    if (w.y + R >= WATER - 2) {
      w.hp = 0;
      w.alive = false;
    }
    return;
  }

  if (rolling) {
    w.spin += w.vx * 0.018 * dt;
    w.tilt = clamp(w.tilt + w.spin * dt, -0.45, 0.45);
    w.tilt += (0 - w.tilt) * Math.min(1, 0.08 * dt);
    w.x += w.vx * dt;
    w.vx *= 0.94;
    w.spin *= 0.9;
    if (w.x < 16 || w.x > W - 16) {
      w.x = clamp(w.x, 16, W - 16);
      w.vx *= -0.4;
      w.spin *= -0.55;
    }
    const stood = placeAt(w.x, w.y);
    if (stood != null) {
      w.y = stood;
      w.vy = 0;
    } else if (!blocked(w.x, w.y)) {
      w.vy = Math.max(w.vy, 0.4);
    } else {
      w.vx *= -0.35;
      w.spin *= -0.45;
    }
    return;
  }

  w.vy = 0;
  w.vx *= 0.35;
  w.spin *= 0.55;
  w.tilt += (0 - w.tilt) * Math.min(1, 0.38 * dt);
  if (Math.abs(w.tilt) < 0.025) w.tilt = 0;
  let climb = 0;
  while (climb < 20 && isSolid(w.x, w.y + R - 1) && !isSolid(w.x, w.y - 6)) {
    w.y -= 1;
    climb += 1;
  }
}

function living(team?: Team): Worm[] {
  return state.worms.filter((w) => w.alive && (team == null || w.team === team));
}

function current(): Worm | null {
  const id = state.order[state.turn];
  return state.worms.find((w) => w.id === id && w.alive) ?? null;
}

function rebuildOrder(): void {
  const ids: number[] = [];
  const max = Math.max(living("you").length, living("jev").length, 1);
  for (let i = 0; i < max; i++) {
    const you = living("you")[i];
    const jev = living("jev")[i];
    if (you) ids.push(you.id);
    if (jev) ids.push(jev.id);
  }
  state.order = ids;
  if (!ids.length) return;
  if (state.turn >= ids.length) state.turn = 0;
  if (!ids.includes(state.order[state.turn] ?? -1)) state.turn = 0;
}

function spawnWorms(): void {
  const spots: { name: string; team: Team; x: number }[] = [
    { name: "DOS", team: "you", x: 92 },
    { name: "RIFLE", team: "you", x: 228 },
    { name: "WINTER", team: "jev", x: 560 },
    { name: "BART", team: "jev", x: 808 },
  ];
  state.worms = spots.map((s, id) => ({
    id,
    name: s.name,
    team: s.team,
    x: s.x,
    y: surfaceY(s.x) - R,
    vx: 0,
    vy: 0,
    hp: 100,
    facing: s.team === "you" ? (1 as const) : (-1 as const),
    alive: true,
    crawl: id * 1.7,
    crawling: false,
    tilt: 0,
    spin: 0,
  }));
}

function rollWind(): void {
  state.wind = Math.round((Math.random() * 2 - 1) * 18) / 10;
}

function setStatus(action: string, meta: string): void {
  if (feedAction) feedAction.textContent = action;
  if (feedMeta) feedMeta.textContent = meta;
}

function logDecision(kind: string, text: string): void {
  if (!feedList) return;
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = text;
  feedList.prepend(li);
  while (feedList.children.length > 10) feedList.removeChild(feedList.lastChild as Node);
}

function activeIsJev(): boolean {
  if (state.mode === "you-vs-you") return false;
  const w = current();
  if (!w) return false;
  if (state.mode === "jev-vs-jev") return true;
  return w.team === "jev";
}

function beginTurn(): void {
  rebuildOrder();
  const youLeft = living("you").length;
  const jevLeft = living("jev").length;
  if (!youLeft || !jevLeft) {
    state.phase = "over";
    const winner = youLeft ? teamTag("you") : teamTag("jev");
    setStatus(`${winner} WINS`, "space to rematch");
    return;
  }
  if (!current()) {
    state.turn = 0;
  }
  const w = current();
  if (!w) return;
  state.phase = "turn";
  state.charge = 0;
  state.power = 0.62;
  state.moveLeft = MOVE_BUDGET;
  state.asked = false;
  state.jevAim = null;
  state.fireHeld = false;
  rollWind();
  const nearest = living(w.team === "you" ? "jev" : "you")[0];
  if (nearest) w.facing = nearest.x >= w.x ? 1 : -1;
  setStatus(
    `${teamTag(w.team)} · ${w.name}`,
    `wind ${state.wind >= 0 ? "+" : ""}${state.wind} · ${WEAPON[state.weapon].label}`,
  );
}

function simulateShot(
  ox: number,
  oy: number,
  elev: number,
  power: number,
  facing: number,
  weapon: WormsWeapon = state.weapon,
  target: Worm | null = null,
): { x: number; y: number } {
  const spec = WEAPON[weapon];
  let x = ox + facing * 12;
  let y = oy - 6;
  let vx = Math.cos(elev) * facing * power * spec.maxPower;
  let vy = -Math.sin(elev) * power * spec.maxPower;
  let burn = spec.burn;
  let peaked = false;
  for (let i = 0; i < 480; i++) {
    const thrust = burn > 0 ? spec.thrust : 0;
    burn -= 1;
    const next = flightStep(x, y, vx, vy, {
      windK: spec.windK,
      grav: spec.grav,
      drag: spec.drag,
      thrust,
      homing: spec.homing,
      turn: spec.turn,
      target,
    }, 1);
    x = next.x;
    y = next.y;
    vx = next.vx;
    vy = next.vy;
    if (vy > 0) peaked = true;
    if (spec.split && peaked && vy > 0.35 && i > 16) {
      let best = { x, y };
      let bestErr = 9999;
      const tx = target?.x ?? x;
      const ty = target?.y ?? y;
      const heading = Math.atan2(vy, vx);
      const speed = Math.hypot(vx, vy);
      for (let k = -2; k <= 2; k++) {
        const a = heading + k * 0.32;
        const spd = speed * (0.68 + Math.abs(k) * 0.07) + 1.8;
        let bx = x;
        let by = y;
        let bvx = Math.cos(a) * spd;
        let bvy = Math.sin(a) * spd + 0.55;
        for (let j = 0; j < 110; j++) {
          const b = flightStep(bx, by, bvx, bvy, {
            windK: spec.windK + 0.014,
            grav: spec.grav + 0.03,
            drag: 0.012,
            thrust: 0,
            homing: false,
            turn: 0,
            target: null,
          }, 1);
          bx = b.x;
          by = b.y;
          bvx = b.vx;
          bvy = b.vy;
          if (bx < 4 || bx > W - 4 || by > WATER || (by > 4 && isSolid(bx, by))) break;
        }
        const err = Math.hypot(bx - tx, by - ty);
        if (err < bestErr) {
          bestErr = err;
          best = { x: bx, y: by };
        }
      }
      return best;
    }
    if (x < 4 || x > W - 4 || y > WATER) return { x, y };
    if (y > 4 && isSolid(x, y)) return { x, y };
  }
  return { x, y };
}

function teamLogs(team: Team): WormsShotLog[] {
  return state.shotLog.filter((s) => s.team === team).slice(0, 2);
}

function aimBias(team: Team): { x: number; y: number } {
  const logs = teamLogs(team);
  if (!logs.length) return { x: 0, y: 0 };
  let wx = 0;
  let wy = 0;
  let wsum = 0;
  logs.forEach((log, i) => {
    const windShift = Math.abs(log.wind - state.wind);
    const weight = (i === 0 ? 1.25 : 0.75) * (windShift > 1.2 ? 0.45 : 1);
    wx += log.miss_x * weight;
    wy += log.miss_y * weight;
    wsum += weight;
  });
  return { x: clamp(wx / wsum, -80, 80), y: clamp(wy / wsum, -70, 70) };
}

function bestShot(
  from: Worm,
  target: Worm,
  loft: boolean,
  weapon: WormsWeapon = state.weapon,
): { elev: number; power: number; error: number; hx: number; hy: number } {
  const bias = aimBias(from.team);
  let best = { elev: 0.6, power: 0.7, error: 9999, hx: from.x, hy: from.y };
  const elevMin = loft ? 0.75 : ELEV_MIN;
  const elevMax = loft ? ELEV_MAX : 0.72;
  for (let e = elevMin; e <= elevMax; e += 0.07) {
    for (let p = 0.42; p <= 1; p += 0.08) {
      const hit = simulateShot(from.x, from.y, e, p, from.facing, weapon, target);
      const tx = target.x - bias.x;
      const ty = target.y - bias.y;
      let err = Math.hypot(hit.x - tx, hit.y - ty);
      for (const ally of living(from.team)) {
        if (ally.id === from.id) continue;
        if (Math.hypot(hit.x - ally.x, hit.y - ally.y) < 44) err += 80;
      }
      if (err < best.error) best = { elev: e, power: p, error: err, hx: hit.x, hy: hit.y };
    }
  }
  return best;
}

function reachableStances(from: Worm): { x: number; y: number }[] {
  const spots = [{ x: from.x, y: from.y }];
  for (const dir of [-1, 1] as const) {
    let x = from.x;
    let y = from.y;
    let walked = 0;
    while (walked < MOVE_BUDGET - 6) {
      const nx = x + dir * 8;
      if (nx < 22 || nx > W - 22) break;
      const stood = placeAt(nx, y);
      if (stood == null || blocked(nx, stood) || stood + R >= WATER - 6) break;
      x = nx;
      y = stood;
      walked += 8;
      if (walked % 16 === 0 || walked >= MOVE_BUDGET - 8) spots.push({ x, y });
    }
  }
  return spots;
}

function planFrom(shooter: Worm, target: Worm, loft: boolean, weapon: WormsWeapon = state.weapon) {
  const facing0: 1 | -1 = target.x >= shooter.x ? 1 : -1;
  let best = {
    destX: shooter.x,
    destY: shooter.y,
    facing: facing0,
    ...bestShot({ ...shooter, facing: facing0 }, target, loft, weapon),
  };
  for (const spot of reachableStances(shooter)) {
    const facing: 1 | -1 = target.x >= spot.x ? 1 : -1;
    const ghost: Worm = { ...shooter, x: spot.x, y: spot.y, facing };
    const shot = bestShot(ghost, target, loft, weapon);
    if (shot.error < best.error - 2) {
      best = { destX: spot.x, destY: spot.y, facing, ...shot };
    }
  }
  return best;
}

function foeViews(shooter: Worm): WormsFoeView[] {
  return living(shooter.team === "you" ? "jev" : "you").map((foe) => {
    const facing = foe.x >= shooter.x ? 1 : -1;
    shooter.facing = facing;
    const flat = bestShot(shooter, foe, false, "bazooka");
    const loft = bestShot(shooter, foe, true, "bazooka");
    return {
      id: foe.id,
      name: foe.name,
      hp: foe.hp,
      x: Math.round(foe.x),
      y: Math.round(foe.y),
      loft_error_px: Math.round(loft.error),
      flat_error_px: Math.round(flat.error),
      loft_angle_deg: Math.round((loft.elev * 180) / Math.PI),
      flat_angle_deg: Math.round((flat.elev * 180) / Math.PI),
      loft_power: Math.round(loft.power * 100) / 100,
      flat_power: Math.round(flat.power * 100) / 100,
    };
  });
}

function weaponScores(shooter: Worm): {
  id: WormsWeapon;
  error_px: number;
  target_id: number;
  target_name: string;
}[] {
  const foes = living(shooter.team === "you" ? "jev" : "you");
  return WEAPON_IDS.map((id) => {
    let best = { error_px: 9999, target_id: foes[0]?.id ?? -1, target_name: foes[0]?.name ?? "none" };
    for (const foe of foes) {
      const flat = bestShot(shooter, foe, false, id);
      const loft = bestShot(shooter, foe, true, id);
      const error_px = Math.round(Math.min(flat.error, loft.error));
      if (error_px < best.error_px) best = { error_px, target_id: foe.id, target_name: foe.name };
    }
    return { id, ...best };
  });
}

function snapshot(): WormsSnapshot {
  const w = current();
  if (!w) {
    return {
      rules: "no shooter",
      wind: state.wind,
      shooter: { id: -1, name: "none", x: 0, y: 0, facing: 1 },
      foes: [],
      weapons: [],
      recent_shots: [],
    };
  }
  return {
    rules: [
      "Pick a weapon using the weapons table. Smaller error_px is better. Do not default to bazooka.",
      "cluster splits into 5 bomblets, mortar is heavy artillery with little wind, bazooka is a single wind rocket.",
      "y grows downward. Wind is added to projectile vx each step (positive wind blows right).",
      "If recent_shots exist, correct from those misses: miss_x/miss_y is impact minus intended target.",
    ].join(" "),
    wind: state.wind,
    shooter: { id: w.id, name: w.name, x: Math.round(w.x), y: Math.round(w.y), facing: w.facing },
    foes: foeViews(w),
    weapons: weaponScores(w),
    recent_shots: teamLogs(w.team),
  };
}

function fire(power: number): void {
  const w = current();
  if (!w || state.phase === "over") return;
  const aim = state.jevAim;
  const weapon = aim?.weapon ?? state.weapon;
  const spec = WEAPON[weapon];
  setWeapon(weapon);
  const foe = aim ? living().find((x) => x.id === aim.targetId) : null;
  const targetId = foe?.id ?? living().find((x) => x.team !== w.team)?.id ?? -1;
  state.pending = {
    team: w.team,
    shooter: w.name,
    target_id: targetId,
    target_name: foe?.name ?? "none",
    intended_x: foe?.x ?? w.x + w.facing * 180,
    intended_y: foe?.y ?? w.y,
    loft: aim?.loft ?? false,
    elev: state.elev,
    power,
    wind: state.wind,
    weapon,
    hit: false,
    impact_x: w.x,
    impact_y: w.y,
  };
  const vx = Math.cos(state.elev) * w.facing * power * spec.maxPower;
  const vy = -Math.sin(state.elev) * power * spec.maxPower;
  const mx = w.x + w.facing * 16;
  const my = w.y - 8;
  state.shots = [shotFromSpec(spec, mx, my, vx, vy, weapon, targetId)];
  addFx(mx, my, 0, 0, 7, "flash", 16, "#fff2c0");
  burst(mx, my, 8, "#ffb36b", 2.2);
  state.phase = "fly";
  state.charge = 0;
  state.jevAim = null;
  playIncoming();
}

function finishShot(): void {
  state.phase = "settle";
  state.boomWait = 36;
  const pending = state.pending;
  state.pending = null;
  if (!pending || pending.target_id < 0) return;
  const log: WormsShotLog = {
    team: pending.team,
    shooter: pending.shooter,
    target_name: pending.target_name,
    weapon: pending.weapon,
    wind: pending.wind,
    loft: pending.loft,
    hit: pending.hit,
    miss_x: Math.round(pending.impact_x - pending.intended_x),
    miss_y: Math.round(pending.impact_y - pending.intended_y),
    impact_x: Math.round(pending.impact_x),
    impact_y: Math.round(pending.impact_y),
    intended_x: Math.round(pending.intended_x),
    intended_y: Math.round(pending.intended_y),
  };
  const mine = [log, ...state.shotLog.filter((s) => s.team === pending.team)].slice(0, 2);
  const other = state.shotLog.filter((s) => s.team !== pending.team).slice(0, 2);
  state.shotLog = [...mine, ...other];
}

function explode(px: number, py: number, shot: Shot): void {
  const water = py >= WATER - 6;
  carve(px, py, shot.radius);
  addFx(px, py, 0, 0, 8, "flash", shot.radius * 0.7, water ? "#c8e4ff" : "#fff4d0");
  addFx(px, py, 0, 0, 16, "ring", shot.radius * 0.55, water ? "#9cc4ff" : "#ffc878");
  const n = 10 + Math.round(shot.radius / 4);
  burst(px, py, n, water ? "#b8d4ff" : "#ffb36b", 2.4 + shot.radius / 18);
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 0.3 + Math.random() * 1.4;
    addFx(px, py, Math.cos(a) * s, Math.sin(a) * s - 1.1, 22 + Math.random() * 18, "smoke", 7 + Math.random() * 8, "rgba(40,36,48,0.55)");
  }
  if (!water) {
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI + Math.random() * Math.PI;
      const s = 1.2 + Math.random() * 3.4;
      addFx(px, py, Math.cos(a) * s, Math.sin(a) * s - 2.2, 18 + Math.random() * 12, "dirt", 2.5 + Math.random() * 2, "#8a4a32");
    }
  }
  for (const w of living()) {
    const d = Math.hypot(w.x - px, w.y - py);
    if (d < shot.blast) {
      if (state.pending && w.id === state.pending.target_id) state.pending.hit = true;
      const falloff = 1 - d / shot.blast;
      w.hp = Math.max(0, Math.round(w.hp - shot.dmg * falloff));
      w.vx += ((w.x - px) / Math.max(8, d)) * (5.8 + shot.radius / 12) * falloff;
      w.vy -= (3.2 + shot.radius / 18) * falloff;
      w.spin += clamp(-Math.sign(w.x - px || 1) * 0.12 * falloff, -0.18, 0.18);
      if (w.hp <= 0) w.alive = false;
    }
  }
  if (state.pending) {
    state.pending.impact_x = px;
    state.pending.impact_y = py;
  }
}

async function askJev(): Promise<void> {
  const w = current();
  if (!w || state.busy || state.asked) return;
  state.busy = true;
  state.asked = true;
  const snap = snapshot();
  const t0 = performance.now();
  try {
    const res = await fetch("/api/worms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snap),
    });
    const ms = Math.round(performance.now() - t0);
    recordLatency(ms);
    const data = (await res.json()) as WormsPilotResponse;
    if (!res.ok) throw new Error(data.detail || data.error || `http ${res.status}`);
    const foes = snap.foes;
    let foe = foes.find((f) => f.id === data.target_id) ?? foes[0];
    if (!foe) throw new Error("no foe");
    const useLoft = (data.loft ?? 0) >= 0.5;
    const live = living().find((x) => x.id === foe.id);
    if (!live) throw new Error("no foe");
    const weapon = pickBestWeapon(w, live, useLoft, parseWeapon(data.weapon));
    setWeapon(weapon);
    const plan = planFrom(w, live, useLoft, weapon);
    w.facing = plan.facing;
    const walking = Math.abs(plan.destX - w.x) > 8;
    const nudge = ((data.power_adjust ?? 0.5) - 0.5) * 0.3;
    const bias = aimBias(w.team);
    state.jevAim = {
      destX: plan.destX,
      targetId: live.id,
      loft: useLoft,
      elev: plan.elev,
      power: clamp(plan.power + nudge, 0.4, 1),
      weapon,
      charge: false,
      walking,
      stuck: 0,
    };
    const label = `${foe.name} ${WEAPON[weapon].label} ${useLoft ? "LOFT" : "FLAT"}`;
    const move = walking ? `move ${Math.round(plan.destX - w.x)}px · ` : "";
    const corr = teamLogs(w.team).length
      ? ` · corr ${Math.round(bias.x)},${Math.round(bias.y)}`
      : "";
    setStatus(`JEV  ${label}`, `${ms}ms · ${move}err ${Math.round(plan.error)}px${corr}`);
    logDecision("flap", `${walking ? "WALK · " : ""}${label}${corr}  ${ms}ms`);
  } catch (err) {
    const foes = snap.foes;
    const foe = foes.slice().sort((a, b) => a.flat_error_px - b.flat_error_px)[0];
    if (foe) {
      const live = living().find((x) => x.id === foe.id);
      if (live) {
        w.facing = live.x >= w.x ? 1 : -1;
        const loft = foe.loft_error_px < foe.flat_error_px;
        const weapon = pickBestWeapon(w, live, loft);
        setWeapon(weapon);
        const shot = planFrom(w, live, loft, weapon);
        w.facing = shot.facing;
        state.jevAim = {
          destX: shot.destX,
          targetId: live.id,
          loft,
          elev: shot.elev,
          power: shot.power,
          weapon,
          charge: false,
          walking: Math.abs(shot.destX - w.x) > 8,
          stuck: 0,
        };
      }
    }
    const message = err instanceof Error ? err.message : "Jev call failed";
    setStatus("ERROR", message);
    logDecision("error", message);
  } finally {
    state.busy = false;
  }
}

function pickBestWeapon(
  from: Worm,
  target: Worm,
  loft: boolean,
  preferred?: WormsWeapon,
): WormsWeapon {
  let best: WormsWeapon = preferred ?? "bazooka";
  let bestErr = Infinity;
  const grouped = living(target.team).some(
    (w) => w.id !== target.id && Math.hypot(w.x - target.x, w.y - target.y) < 70,
  );
  for (const id of WEAPON_IDS) {
    const shot = bestShot(from, target, id === "mortar" ? true : loft, id);
    let err = shot.error;
    if (id === "cluster" && grouped) err -= 20;
    if (id === preferred) err -= 10;
    if (err < bestErr) {
      bestErr = err;
      best = id;
    }
  }
  return best;
}

function walk(w: Worm, dir: 1 | -1, dt: number): void {
  if (state.moveLeft <= 0) return;
  if (Math.abs(w.tilt) > 0.25 || Math.abs(w.spin) > 0.08) return;
  if (!onGround(w.x, w.y)) return;
  w.crawling = true;
  w.crawl += dt * 0.3;
  const scoot = 0.2 + 0.8 * Math.max(0, Math.sin(w.crawl));
  const step = dir * WALK * dt * scoot;
  const nx = w.x + step;
  if (nx < 16 || nx > W - 16) return;
  const stood = placeAt(nx, w.y);
  if (stood != null) {
    w.x = nx;
    w.y = stood;
  } else if (!blocked(nx, w.y)) {
    w.x = nx;
  } else {
    return;
  }
  w.facing = dir;
  state.moveLeft -= Math.abs(step);
}

function update(dt: number): void {
  for (const spark of state.sparks) {
    spark.x += spark.vx * dt;
    spark.y += spark.vy * dt;
    if (spark.kind === "smoke") {
      spark.vy -= 0.04 * dt;
      spark.vx *= 0.96;
      spark.size += 0.18 * dt;
    } else if (spark.kind === "ring") {
      spark.size += 1.6 * dt;
    } else if (spark.kind === "dirt") {
      spark.vy += 0.28 * dt;
    } else if (spark.kind !== "flash") {
      spark.vy += 0.18 * dt;
    }
    spark.life -= dt;
  }
  state.sparks = state.sparks.filter((s) => s.life > 0);

  if (state.phase === "over") return;

  for (const worm of state.worms) {
    if (!worm.alive) continue;
    if (!worm.crawling) worm.crawl += dt * 0.045;
    worm.crawling = false;
    settleWorm(worm, dt);
  }

  if (state.phase === "settle") {
    state.boomWait -= dt;
    const settled = state.worms.every(
      (w) =>
        !w.alive || (Math.abs(w.vy) < 0.22 && Math.abs(w.vx) < 0.5 && Math.abs(w.spin) < 0.08),
    );
    if (state.boomWait <= 0 && (settled || state.boomWait < -90)) {
      for (const w of state.worms) {
        if (!w.alive) continue;
        w.vx = 0;
        w.vy = 0;
        w.spin = 0;
        w.tilt = 0;
      }
      state.turn = (state.turn + 1) % Math.max(1, state.order.length);
      beginTurn();
    }
    return;
  }

  if (state.phase === "fly" && state.shots.length) {
    const next: Shot[] = [];
    for (const s of state.shots) {
      const dist = Math.hypot(s.vx, s.vy) * dt;
      const steps = Math.max(1, Math.ceil(dist / 2.4));
      const h = dt / steps;
      let boom: { x: number; y: number } | null = null;
      let split = false;
      for (let i = 0; i < steps; i++) {
        s.age += h;
        s.burn -= h;
        s.fuse -= h;
        s.life -= h;
        s.spin += (s.kind === "bomblet" || s.kind === "mortar" ? 0.18 : 0.02) * h;
        const moved = flightStep(s.x, s.y, s.vx, s.vy, {
          windK: s.windK,
          grav: s.grav,
          drag: s.drag,
          thrust: s.burn > 0 ? s.thrust : 0,
          homing: s.homing,
          turn: s.turn,
          target: s.homing ? shotTarget(s.targetId) : null,
        }, h);
        s.x = moved.x;
        s.y = moved.y;
        s.vx = moved.vx;
        s.vy = moved.vy;
        if (s.kind === "cluster" && s.age > 18 && s.vy > 0.28) {
          split = true;
          break;
        }
        const armed = s.age > 8;
        if (s.life <= 0 || s.x < 2 || s.x > W - 2 || s.y > WATER) {
          boom = { x: clamp(s.x, 8, W - 8), y: Math.min(s.y, WATER - 4) };
          break;
        }
        if (armed && s.y > 6 && isSolid(s.x, s.y)) {
          boom = { x: s.x, y: s.y };
          break;
        }
        if (armed) {
          for (const w of living()) {
            if (w.id === current()?.id) continue;
            if (Math.hypot(w.x - s.x, w.y - 4 - s.y) < 11 + s.size) {
              boom = { x: s.x, y: s.y };
              break;
            }
          }
          if (boom) break;
        }
      }
      s.smoke -= dt;
      if (s.smoke <= 0 && !boom && !split) {
        s.smoke = s.kind === "mortar" ? 2.4 : 1.1;
        const spd = Math.hypot(s.vx, s.vy) || 1;
        addFx(
          s.x - (s.vx / spd) * 8,
          s.y - (s.vy / spd) * 8,
          -s.vx * 0.08 + (Math.random() - 0.5) * 0.3,
          -s.vy * 0.08 - 0.2,
          16 + Math.random() * 10,
          "smoke",
          s.kind === "bomblet" ? 4 : 6,
          "rgba(48,44,56,0.5)",
        );
        if (s.burn > 0) {
          addFx(s.x, s.y, -s.vx * 0.12, -s.vy * 0.12, 6, "spark", 2.2, "#ffb060");
        }
      }
      if (split) {
        next.push(...splitCluster(s));
        continue;
      }
      if (boom) explode(boom.x, boom.y, s);
      else next.push(s);
    }
    state.shots = next;
    if (!state.shots.length && state.phase === "fly") finishShot();
    return;
  }

  const w = current();
  if (!w) {
    beginTurn();
    return;
  }

  if (state.phase === "charge") {
    state.charge = clamp(state.charge + 0.018 * dt, 0.28, 1);
    if (activeIsJev()) {
      if (state.charge >= (state.jevAim?.power ?? 0.7) - 0.02) fire(state.charge);
    } else if (!state.keys.fire) {
      fire(state.charge);
    }
    return;
  }

  if (activeIsJev()) {
    if (!state.asked) void askJev();
    const aim = state.jevAim;
    if (aim) {
      if (aim.walking) {
        if (!onGround(w.x, w.y)) return;
        const before = w.x;
        const dir: 1 | -1 = aim.destX >= w.x ? 1 : -1;
        walk(w, dir, dt);
        if (Math.abs(w.x - aim.destX) <= 6 || state.moveLeft <= 0) {
          aim.walking = false;
          const foe = living().find((x) => x.id === aim.targetId);
          if (foe) {
            w.facing = foe.x >= w.x ? 1 : -1;
            const shot = bestShot(w, foe, aim.loft, aim.weapon);
            aim.elev = shot.elev;
            aim.power = clamp(shot.power, 0.4, 1);
          }
        } else if (Math.abs(w.x - before) < 0.08) {
          aim.stuck += 1;
          if (aim.stuck > 24) aim.walking = false;
        } else {
          aim.stuck = 0;
        }
        return;
      }
      state.elev += (aim.elev - state.elev) * Math.min(1, 0.12 * dt);
      if (!aim.charge && Math.abs(state.elev - aim.elev) < 0.04) {
        aim.charge = true;
        state.phase = "charge";
        state.charge = 0.28;
      }
    }
    return;
  }

  if (state.keys.left) walk(w, -1, dt);
  if (state.keys.right) walk(w, 1, dt);
  if (state.keys.up) state.elev = clamp(state.elev + 0.03 * dt, ELEV_MIN, ELEV_MAX);
  if (state.keys.down) state.elev = clamp(state.elev - 0.03 * dt, ELEV_MIN, ELEV_MAX);
  if (state.keys.fire && !state.fireHeld) {
    state.phase = "charge";
    state.charge = 0.28;
  }
  state.fireHeld = state.keys.fire;
}

function drawSky(): void {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#6b3aaa");
  g.addColorStop(0.45, "#4a4cb8");
  g.addColorStop(1, "#6a8ad4");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#4d6fb8";
  ctx.beginPath();
  ctx.moveTo(0, 310);
  ctx.lineTo(140, 210);
  ctx.lineTo(260, 250);
  ctx.lineTo(420, 160);
  ctx.lineTo(560, 230);
  ctx.lineTo(720, 140);
  ctx.lineTo(960, 240);
  ctx.lineTo(960, 400);
  ctx.lineTo(0, 400);
  ctx.fill();
  ctx.fillStyle = "#3d5fa6";
  ctx.beginPath();
  ctx.moveTo(0, 360);
  ctx.lineTo(180, 250);
  ctx.lineTo(340, 300);
  ctx.lineTo(500, 210);
  ctx.lineTo(680, 280);
  ctx.lineTo(960, 200);
  ctx.lineTo(960, 420);
  ctx.lineTo(0, 420);
  ctx.fill();
}

function drawWater(): void {
  ctx.fillStyle = "#1b3a6e";
  ctx.fillRect(0, WATER, W, H - WATER);
  ctx.fillStyle = "rgba(120,180,255,0.25)";
  ctx.fillRect(0, WATER, W, 4);
}

function drawWorm(w: Worm): void {
  const f = w.facing;
  const wave = Math.sin(w.crawl);
  const tumbling = Math.abs(w.tilt) > 0.14 || Math.abs(w.spin) > 0.08;
  const bob = tumbling ? 0 : w.crawling ? (wave > 0 ? -2 : 0) : Math.sin(w.crawl * 0.8) * 0.6;
  const lean = tumbling ? 0 : w.crawling ? f * (0.08 + 0.12 * Math.max(0, wave)) : 0;
  const nameColor = w.team === "you" ? "#ff7ad9" : "#ffe566";

  ctx.save();
  ctx.translate(w.x, w.y - 4);
  ctx.rotate(lean + w.tilt);
  ctx.translate(0, 12 + bob);
  ctx.scale(f, 1);

  ctx.fillStyle = "rgba(10,8,20,0.28)";
  ctx.beginPath();
  ctx.ellipse(0, 1, 7, 2.2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-7, -2, -8, -12, -6, -18);
  ctx.bezierCurveTo(-9, -28, 2, -32, 7, -26);
  ctx.bezierCurveTo(12, -22, 8, -12, 5, -6);
  ctx.bezierCurveTo(3, -1, 2, 0, 0, 0);
  ctx.closePath();
  ctx.fillStyle = "#f4a0c0";
  ctx.fill();
  ctx.strokeStyle = "#1a1028";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.ellipse(1, -24, 3.2, 2.4, -0.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#fffef8";
  ctx.beginPath();
  ctx.ellipse(-0.6, -22.5, 2.1, 2.6, 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(4.2, -22.8, 2.1, 2.6, -0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a1028";
  ctx.beginPath();
  ctx.arc(0.2, -22.3, 1.05, 0, Math.PI * 2);
  ctx.arc(5.0, -22.6, 1.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(-0.2, -23, 0.4, 0, Math.PI * 2);
  ctx.arc(4.6, -23.3, 0.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#1a1028";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(2.2, -19.4, 2.1, 0.2, Math.PI - 0.2);
  ctx.stroke();

  ctx.fillStyle = "rgba(232,90,140,0.45)";
  ctx.beginPath();
  ctx.ellipse(-2.4, -19.2, 1.6, 1.1, 0, 0, Math.PI * 2);
  ctx.ellipse(6.2, -19.6, 1.5, 1, 0, 0, Math.PI * 2);
  ctx.fill();

  if (!tumbling && w === current() && (state.phase === "turn" || state.phase === "charge")) {
    const spec = WEAPON[state.weapon];
    const len = spec.id === "mortar" ? 11 : spec.id === "cluster" ? 12 : 16;
    const thick = spec.id === "mortar" ? 4.2 : 2.8;
    ctx.save();
    ctx.translate(7, -16);
    ctx.rotate(-state.elev);
    ctx.fillStyle = spec.id === "mortar" ? "#5a4638" : "#3a3028";
    ctx.fillRect(0, -thick / 2, len, thick);
    ctx.fillStyle = "#1a1028";
    ctx.fillRect(len - 2, -thick / 2 - 0.4, 2.4, thick + 0.8);
    ctx.restore();
  }
  ctx.restore();

  if (!tumbling && w === current() && (state.phase === "turn" || state.phase === "charge")) {
    const power = state.phase === "charge" ? state.charge : Math.max(0.42, state.power);
    drawArcPreview(w, state.elev, power, w.facing);
  }

  const tag = w.name;
  ctx.font = `8px "Press Start 2P", monospace`;
  const tw = Math.max(52, ctx.measureText(tag).width + 12);
  const tx = w.x - tw / 2;
  const ty = w.y - 44;
  ctx.fillStyle = "#0d0814";
  ctx.strokeStyle = "#f4f7fb";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(tx, ty, tw, 22, 3);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = nameColor;
  ctx.fillText(tag, w.x, ty + 3);
  ctx.fillStyle = w.hp < 30 ? "#ff8a8a" : "#f4a0c0";
  ctx.fillText(String(w.hp), w.x, ty + 12);
}

function drawArcPreview(w: Worm, elev: number, power: number, facing: number): void {
  const spec = WEAPON[state.weapon];
  let x = w.x + facing * 16;
  let y = w.y - 8;
  let vx = Math.cos(elev) * facing * power * spec.maxPower;
  let vy = -Math.sin(elev) * power * spec.maxPower;
  let burn = spec.burn;
  ctx.fillStyle = "rgba(255,244,163,0.55)";
  for (let i = 0; i < 70; i++) {
    const next = flightStep(x, y, vx, vy, {
      windK: spec.windK,
      grav: spec.grav,
      drag: spec.drag,
      thrust: burn > 0 ? spec.thrust : 0,
      homing: false,
      turn: 0,
      target: null,
    }, 1);
    burn -= 1;
    x = next.x;
    y = next.y;
    vx = next.vx;
    vy = next.vy;
    if (i % 3 === 0) {
      ctx.beginPath();
      ctx.arc(x, y, i < 8 ? 1.6 : 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    if (x < 4 || x > W - 4 || y > WATER || (y > 4 && isSolid(x, y))) break;
  }
}

function drawShot(s: Shot): void {
  const ang = Math.atan2(s.vy, s.vx);
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(ang + (s.kind === "bomblet" || s.kind === "mortar" ? s.spin * 0.15 : 0));
  if (s.burn > 0 && s.kind !== "bomblet") {
    ctx.fillStyle = "#ff9a3c";
    ctx.beginPath();
    ctx.moveTo(-s.size - 2, 0);
    ctx.lineTo(-s.size - 9 - Math.random() * 4, 2.2);
    ctx.lineTo(-s.size - 6, 0);
    ctx.lineTo(-s.size - 9 - Math.random() * 3, -2.2);
    ctx.closePath();
    ctx.fill();
  }
  if (s.kind === "mortar") {
    ctx.fillStyle = "#6a5238";
    ctx.beginPath();
    ctx.ellipse(0, 0, 7.2, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c4a06a";
    ctx.beginPath();
    ctx.ellipse(3.4, 0, 3.2, 2.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2a2018";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  } else if (s.kind === "bomblet") {
    ctx.fillStyle = "#d4a43a";
    ctx.beginPath();
    ctx.arc(0, 0, 3.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#5a3a10";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = "#3a2810";
    ctx.beginPath();
    ctx.moveTo(-2, -2.4);
    ctx.lineTo(2, 2.4);
    ctx.stroke();
  } else if (s.kind === "cluster") {
    ctx.fillStyle = "#c9a038";
    ctx.beginPath();
    ctx.roundRect(-7, -3.2, 14, 6.4, 2);
    ctx.fill();
    ctx.fillStyle = "#8a6a20";
    ctx.fillRect(4, -3.2, 3, 6.4);
    ctx.strokeStyle = "#3a2a10";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  } else {
    ctx.fillStyle = "#f2eee4";
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-6, 3.2);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-6, -3.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#c45c2a";
    ctx.beginPath();
    ctx.moveTo(-2, 3.2);
    ctx.lineTo(-7, 5);
    ctx.lineTo(-5, 0);
    ctx.lineTo(-7, -5);
    ctx.lineTo(-2, -3.2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#1a1028";
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }
  ctx.restore();
}

function drawFx(s: Spark): void {
  const a = clamp(s.life / s.max, 0, 1);
  ctx.globalAlpha = s.kind === "smoke" ? a * 0.55 : a;
  if (s.kind === "ring") {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.kind === "flash") {
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size * a, 0, Math.PI * 2);
    ctx.fill();
  } else if (s.kind === "smoke") {
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = s.color;
    ctx.fillRect(s.x, s.y, s.size, s.size);
  }
  ctx.globalAlpha = 1;
}

function drawHud(): void {
  ctx.fillStyle = "rgba(10,16,24,0.72)";
  ctx.fillRect(0, H - 48, W, 48);
  ctx.font = `12px "Press Start 2P", monospace`;
  ctx.fillStyle = "#f4f7fb";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(WEAPON[state.weapon].label, W / 2, H - 36);
  ctx.fillStyle = "#9db0c0";
  ctx.font = `7px "Press Start 2P", monospace`;
  ctx.textAlign = "center";
  WEAPON_IDS.forEach((id, i) => {
    const x = 70 + i * 92;
    ctx.fillStyle = id === state.weapon ? "#fff4a3" : "#9db0c0";
    ctx.fillText(`${i + 1} ${WEAPON[id].label.slice(0, 7)}`, x, H - 16);
  });
  ctx.fillStyle = "#9db0c0";
  ctx.font = `8px "Press Start 2P", monospace`;
  ctx.textAlign = "right";
  ctx.fillText("WIND", W - 168, H - 24);
  ctx.fillStyle = "#2a2158";
  ctx.fillRect(W - 154, H - 32, 130, 14);
  const mid = W - 154 + 65;
  ctx.fillStyle = "#c45c2a";
  ctx.fillRect(mid + state.wind * 6 - 4, H - 34, 8, 18);
  if (state.phase === "charge") {
    ctx.fillStyle = "#fff4a3";
    ctx.fillRect(W / 2 - 70, H - 22, state.charge * 140, 10);
    ctx.strokeStyle = "#f4f7fb";
    ctx.strokeRect(W / 2 - 70, H - 22, 140, 10);
  }
  if (state.phase === "over") {
    ctx.fillStyle = "rgba(8,12,20,0.55)";
    ctx.fillRect(0, 0, W, H - 48);
    ctx.fillStyle = "#fff4a3";
    ctx.font = `18px "Press Start 2P", monospace`;
    ctx.textAlign = "center";
    ctx.fillText(living("you").length ? `${teamTag("you")} WINS` : `${teamTag("jev")} WINS`, W / 2, H / 2 - 10);
    ctx.font = `10px "Press Start 2P", monospace`;
    ctx.fillStyle = "#f4f7fb";
    ctx.fillText("SPACE TO REMATCH", W / 2, H / 2 + 18);
  }
}

function draw(): void {
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
  paintLand();
  drawSky();
  ctx.drawImage(land, 0, 0);
  drawWater();
  for (const w of state.worms) if (w.alive) drawWorm(w);
  for (const s of state.shots) drawShot(s);
  for (const s of state.sparks) drawFx(s);
  drawHud();
}

function resize(): void {
  const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function resetMatch(): void {
  buildLand();
  spawnWorms();
  state.turn = 0;
  state.sparks = [];
  state.shots = [];
  state.pending = null;
  state.shotLog = [];
  state.phase = "turn";
  rebuildOrder();
  beginTurn();
}

function setMode(mode: Mode): void {
  state.mode = mode;
  document.body.classList.toggle("worms-pvp", mode === "you-vs-you");
  feedList?.replaceChildren();
  resetMatch();
  setWeapon(state.weapon);
  for (const btn of modeButtons) btn.classList.toggle("is-active", btn.dataset.mode === mode);
  writeSearch({ mode: mode === "you-vs-jev" ? null : mode });
  syncChoiceLinks();
}

window.addEventListener(
  "keydown",
  (event) => {
    unlockAudio();
    if (
      event.code === "ArrowLeft" ||
      event.code === "ArrowRight" ||
      event.code === "ArrowUp" ||
      event.code === "ArrowDown" ||
      event.code === "KeyA" ||
      event.code === "KeyD" ||
      event.code === "Space" ||
      event.code === "Digit1" ||
      event.code === "Digit2" ||
      event.code === "Digit3"
    ) {
      event.preventDefault();
    }
    if (event.code === "ArrowLeft" || event.code === "KeyA") state.keys.left = true;
    if (event.code === "ArrowRight" || event.code === "KeyD") state.keys.right = true;
    if (event.code === "ArrowUp") state.keys.up = true;
    if (event.code === "ArrowDown") state.keys.down = true;
    if (event.code.startsWith("Digit")) {
      const n = Number(event.code.slice(5));
      const id = WEAPON_IDS[n - 1];
      if (id && state.phase === "turn" && !activeIsJev()) setWeapon(id);
    }
    if (event.code === "Space") {
      state.keys.fire = true;
      if (state.phase === "over") resetMatch();
    }
  },
  { passive: false },
);
window.addEventListener("keyup", (event) => {
  if (event.code === "ArrowLeft" || event.code === "KeyA") state.keys.left = false;
  if (event.code === "ArrowRight" || event.code === "KeyD") state.keys.right = false;
  if (event.code === "ArrowUp") state.keys.up = false;
  if (event.code === "ArrowDown") state.keys.down = false;
  if (event.code === "Space") state.keys.fire = false;
});

for (const btn of weaponButtons) {
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    const id = parseWeapon(btn.dataset.weapon);
    if (id && state.phase === "turn" && !activeIsJev()) setWeapon(id);
  });
}

for (const btn of modeButtons) {
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    const mode = btn.dataset.mode;
    if (mode === "you-vs-jev" || mode === "you-vs-you" || mode === "jev-vs-jev") setMode(mode);
  });
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(2.2, (now - last) / (1000 / 60));
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

window.addEventListener("pointerdown", unlockAudio, { once: true });
resize();
initLatencyChart();
{
  const q = new URLSearchParams(location.search);
  const mode = parseMode(q.get("mode"));
  const weapon = parseWeapon(q.get("weapon") ?? undefined) ?? "bazooka";
  setMode(mode);
  setWeapon(weapon);
}
window.addEventListener("popstate", () => {
  const q = new URLSearchParams(location.search);
  setMode(parseMode(q.get("mode")));
  const weapon = parseWeapon(q.get("weapon") ?? undefined);
  if (weapon) setWeapon(weapon);
});
requestAnimationFrame(loop);
