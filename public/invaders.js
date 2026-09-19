(() => {
  // src/latency.ts
  var SMA_WINDOW = 8;
  var MAX_SAMPLES = 90;
  var samples = [];
  var chart = null;
  var chartCtx = null;
  var lastEl = null;
  var avgEl = null;
  function initLatencyChart() {
    const canvas = document.getElementById("latency-chart");
    if (!(canvas instanceof HTMLCanvasElement))
      return;
    const context = canvas.getContext("2d");
    if (!context)
      return;
    chart = canvas;
    chartCtx = context;
    lastEl = document.getElementById("lat-last");
    avgEl = document.getElementById("lat-avg");
    resizeLatencyChart();
    drawLatencyChart();
    window.addEventListener("resize", resizeLatencyChart);
  }
  function resizeLatencyChart() {
    if (!chart)
      return;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const rect = chart.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (chart.width !== w || chart.height !== h) {
      chart.width = w;
      chart.height = h;
      drawLatencyChart();
    }
  }
  function recordLatency(ms) {
    samples.push({ at: performance.now(), ms });
    if (samples.length > MAX_SAMPLES)
      samples.shift();
    const avg = movingAverage(samples.length - 1);
    if (lastEl)
      lastEl.textContent = `${Math.round(ms)}ms`;
    if (avgEl)
      avgEl.textContent = `${Math.round(avg)}ms`;
    drawLatencyChart();
  }
  function movingAverage(index) {
    const start = Math.max(0, index - SMA_WINDOW + 1);
    let sum = 0;
    let n = 0;
    for (let i = start;i <= index; i++) {
      const sample = samples[i];
      if (!sample)
        continue;
      sum += sample.ms;
      n += 1;
    }
    return n === 0 ? 0 : sum / n;
  }
  function averages() {
    return samples.map((_, i) => movingAverage(i));
  }
  function niceMax(value) {
    const padded = Math.max(400, value * 1.25);
    const step = padded > 2000 ? 500 : padded > 800 ? 200 : 100;
    return Math.ceil(padded / step) * step;
  }
  function drawLatencyChart() {
    if (!chart || !chartCtx)
      return;
    const ctx = chartCtx;
    const w = chart.width;
    const h = chart.height;
    ctx.clearRect(0, 0, w, h);
    const padL = 36 * (w / Math.max(1, chart.getBoundingClientRect().width));
    const padR = 10 * (w / Math.max(1, chart.getBoundingClientRect().width));
    const padT = 12 * (h / Math.max(1, chart.getBoundingClientRect().height));
    const padB = 22 * (h / Math.max(1, chart.getBoundingClientRect().height));
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    ctx.fillStyle = "#152430";
    roundRectPath(ctx, 0, 0, w, h, 12 * (w / 400));
    ctx.fill();
    if (samples.length === 0) {
      ctx.fillStyle = "#6d8193";
      ctx.font = `${11 * (w / 360)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("waiting for Jev calls", w / 2, h / 2);
      return;
    }
    const avgs = averages();
    const yMax = niceMax(Math.max(...samples.map((s) => s.ms), ...avgs));
    const x = (i) => padL + (samples.length === 1 ? plotW / 2 : i / (samples.length - 1) * plotW);
    const y = (ms) => padT + plotH - ms / yMax * plotH;
    ctx.strokeStyle = "rgba(143, 208, 201, 0.14)";
    ctx.lineWidth = 1;
    ctx.font = `${9 * (w / 360)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = "#6d8193";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const ticks = 4;
    for (let i = 0;i <= ticks; i++) {
      const ms = yMax / ticks * i;
      const py = y(ms);
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(padL + plotW, py);
      ctx.stroke();
      ctx.fillText(`${Math.round(ms)}`, padL - 6, py);
    }
    ctx.beginPath();
    ctx.moveTo(x(0), y(avgs[0]));
    for (let i = 1;i < avgs.length; i++)
      ctx.lineTo(x(i), y(avgs[i]));
    ctx.lineTo(x(avgs.length - 1), padT + plotH);
    ctx.lineTo(x(0), padT + plotH);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    fill.addColorStop(0, "rgba(255, 244, 163, 0.28)");
    fill.addColorStop(1, "rgba(255, 244, 163, 0.02)");
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.beginPath();
    for (let i = 0;i < samples.length; i++) {
      const px = x(i);
      const py = y(samples[i].ms);
      if (i === 0)
        ctx.moveTo(px, py);
      else
        ctx.lineTo(px, py);
    }
    ctx.strokeStyle = "rgba(197, 208, 218, 0.35)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x(0), y(avgs[0]));
    for (let i = 1;i < avgs.length; i++)
      ctx.lineTo(x(i), y(avgs[i]));
    ctx.strokeStyle = "#fff4a3";
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    const last = samples[samples.length - 1];
    const lastAvg = avgs[avgs.length - 1];
    ctx.fillStyle = "rgba(197, 208, 218, 0.9)";
    ctx.beginPath();
    ctx.arc(x(samples.length - 1), y(last.ms), 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff4a3";
    ctx.beginPath();
    ctx.arc(x(avgs.length - 1), y(lastAvg), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#6d8193";
    ctx.font = `${9 * (w / 360)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText("raw", padL, h - 6);
    ctx.fillStyle = "#fff4a3";
    ctx.fillText("moving avg", padL + 36 * (w / 360), h - 6);
  }
  function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // src/invaders.ts
  function writeSearch(patch) {
    const u = new URL(location.href);
    for (const [k, v] of Object.entries(patch)) {
      if (!v)
        u.searchParams.delete(k);
      else
        u.searchParams.set(k, v);
    }
    const next = `${u.pathname}${u.search}${u.hash}`;
    if (next !== `${location.pathname}${location.search}${location.hash}`)
      history.replaceState(null, "", next);
  }
  var W = 800;
  var H = 640;
  var COLS = 11;
  var ROWS = 5;
  var ALIEN_W = 36;
  var ALIEN_H = 24;
  var GAP_X = 18;
  var GAP_Y = 18;
  var SHIP_W = 44;
  var SHIP_H = 18;
  var SHIP_Y = H - 52;
  var SHIP_SPEED = 5.4;
  var PLAYER_SHOT_V = -11;
  var ALIEN_SHOT_V = 4.2;
  var STEP_X = 10;
  var DROP_Y = 18;
  var canvasEl = document.getElementById("game");
  if (!(canvasEl instanceof HTMLCanvasElement))
    throw new Error("Missing #game canvas");
  var canvas = canvasEl;
  var context = canvas.getContext("2d");
  if (!context)
    throw new Error("2D canvas is not available");
  var ctx = context;
  var feedAction = document.getElementById("pilot-action");
  var feedMeta = document.getElementById("pilot-meta");
  var feedList = document.getElementById("decisions");
  var modeButtons = document.querySelectorAll("[data-mode]");
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  function lerp(from, to, dt, rate) {
    return from + (to - from) * (1 - Math.exp(-rate * dt));
  }
  function pointsForRow(row) {
    if (row === 0)
      return 30;
    if (row <= 2)
      return 20;
    return 10;
  }
  function makeAliens() {
    const list = [];
    for (let row = 0;row < ROWS; row++) {
      for (let col = 0;col < COLS; col++)
        list.push({ col, row, alive: true });
    }
    return list;
  }
  function makeBunkers() {
    const cells = [];
    const cell = 7;
    const rows = 6;
    const cols = 10;
    const ys = H - 168;
    for (let b = 0;b < 4; b++) {
      const ox = 88 + b * 180;
      for (let r = 0;r < rows; r++) {
        for (let c = 0;c < cols; c++) {
          const corner = r === 0 && (c < 1 || c > 8) || r >= 4 && c >= 3 && c <= 6;
          if (corner)
            continue;
          cells.push({ x: ox + c * cell, y: ys + r * cell, alive: true });
        }
      }
    }
    return cells;
  }
  var state = {
    mode: "jev",
    phase: "playing",
    wave: 1,
    score: 0,
    best: 0,
    lives: 3,
    shipX: W / 2,
    shipVx: 0,
    invuln: 0,
    aliens: makeAliens(),
    originX: 72,
    originY: 72,
    dir: 1,
    stepWait: 0,
    anim: 0,
    playerShot: null,
    alienShots: [],
    alienFireWait: 40,
    bunkers: makeBunkers(),
    ufo: null,
    ufoWait: 420,
    keys: { left: false, right: false, fire: false },
    fireHeld: false,
    target: null,
    busy: false,
    stars: Array.from({ length: 48 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      s: 0.4 + Math.random() * 1.4
    }))
  };
  function shipMin() {
    return 24 + SHIP_W / 2;
  }
  function shipMax() {
    return W - 24 - SHIP_W / 2;
  }
  function alienPos(a) {
    return {
      x: state.originX + a.col * (ALIEN_W + GAP_X) + ALIEN_W / 2,
      y: state.originY + a.row * (ALIEN_H + GAP_Y) + ALIEN_H / 2
    };
  }
  function liveAliens() {
    return state.aliens.filter((a) => a.alive);
  }
  function columnView() {
    const cols = [];
    for (let id = 0;id < COLS; id++) {
      const inCol = liveAliens().filter((a) => a.col === id);
      if (!inCol.length)
        continue;
      let lowest = inCol[0];
      for (const a of inCol)
        if (a.row > lowest.row)
          lowest = a;
      const p = alienPos(lowest);
      cols.push({
        id,
        x: Math.round(p.x),
        lowest_y: Math.round(p.y),
        count: inCol.length,
        points: pointsForRow(lowest.row)
      });
    }
    return cols;
  }
  function incomingThreat() {
    const left = state.shipX - SHIP_W / 2 - 6;
    const right = state.shipX + SHIP_W / 2 + 6;
    let best = null;
    for (const s of state.alienShots) {
      if (s.x < left || s.x > right)
        continue;
      if (!best || s.y > best.y)
        best = s;
    }
    if (!best)
      return null;
    return { x: Math.round(best.x), hits_if_stay: best.y > SHIP_Y - 140 };
  }
  function formationBounds() {
    let left = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const a of liveAliens()) {
      const p = alienPos(a);
      left = Math.min(left, p.x - ALIEN_W / 2);
      right = Math.max(right, p.x + ALIEN_W / 2);
      bottom = Math.max(bottom, p.y + ALIEN_H / 2);
    }
    return { left, right, bottom };
  }
  function resetWave(nextWave) {
    if (nextWave)
      state.wave += 1;
    state.aliens = makeAliens();
    state.originX = 72;
    state.originY = 56 + Math.min(80, (state.wave - 1) * 12);
    state.dir = 1;
    state.stepWait = 0;
    state.playerShot = null;
    state.alienShots = [];
    state.alienFireWait = 36;
    state.target = null;
    if (state.wave === 1)
      state.bunkers = makeBunkers();
  }
  function resetGame() {
    state.phase = "playing";
    state.wave = 1;
    state.score = 0;
    state.lives = 3;
    state.shipX = W / 2;
    state.shipVx = 0;
    state.invuln = 0;
    state.ufo = null;
    state.ufoWait = 380;
    resetWave(false);
  }
  function setStatus(action, meta) {
    if (feedAction)
      feedAction.textContent = action;
    if (feedMeta)
      feedMeta.textContent = meta;
  }
  function logDecision(kind, text) {
    if (!feedList)
      return;
    const li = document.createElement("li");
    li.className = kind;
    li.textContent = text;
    feedList.prepend(li);
    while (feedList.children.length > 10)
      feedList.removeChild(feedList.lastChild);
  }
  function firePlayer() {
    if (state.playerShot || state.phase !== "playing" || state.invuln > 50)
      return;
    state.playerShot = { x: state.shipX, y: SHIP_Y - 12, vy: PLAYER_SHOT_V };
  }
  function hitRect(x, y, cx, cy, w, h) {
    return x >= cx - w / 2 && x <= cx + w / 2 && y >= cy - h / 2 && y <= cy + h / 2;
  }
  function destroyBunkerAt(x, y) {
    for (const c of state.bunkers) {
      if (!c.alive)
        continue;
      if (x >= c.x && x <= c.x + 7 && y >= c.y && y <= c.y + 7) {
        c.alive = false;
        return true;
      }
    }
    return false;
  }
  function killAlien(a) {
    a.alive = false;
    state.score += pointsForRow(a.row);
    if (state.target?.kind === "column" && state.target.id === a.col) {
      const still = liveAliens().some((x) => x.col === a.col);
      if (!still)
        state.target = null;
    }
  }
  function playerHit() {
    if (state.invuln > 0)
      return;
    state.lives -= 1;
    state.invuln = 90;
    state.alienShots = [];
    state.playerShot = null;
    if (state.lives <= 0) {
      state.phase = "over";
      state.best = Math.max(state.best, state.score);
      setStatus("GAME OVER", `score ${state.score}`);
    }
  }
  function march(dt) {
    const alive = liveAliens().length;
    if (!alive) {
      resetWave(true);
      return;
    }
    const interval = Math.max(7, 42 - (state.wave - 1) * 4 - (55 - alive) * 0.45);
    state.stepWait -= dt;
    if (state.stepWait > 0)
      return;
    state.stepWait = interval;
    state.anim = 1 - state.anim;
    const b = formationBounds();
    if (state.dir > 0 && b.right >= W - 28 || state.dir < 0 && b.left <= 28) {
      state.originY += DROP_Y;
      state.dir *= -1;
    } else {
      state.originX += state.dir * STEP_X;
    }
    if (formationBounds().bottom >= SHIP_Y - 8) {
      state.lives = 0;
      state.phase = "over";
      state.best = Math.max(state.best, state.score);
      state.invuln = 90;
      setStatus("GAME OVER", `score ${state.score}`);
    }
  }
  function maybeAlienFire(dt) {
    state.alienFireWait -= dt;
    if (state.alienFireWait > 0)
      return;
    if (state.alienShots.length >= 2 + Math.min(2, state.wave - 1)) {
      state.alienFireWait = 12;
      return;
    }
    const bottoms = new Map;
    for (const a of liveAliens()) {
      const prev = bottoms.get(a.col);
      if (!prev || a.row > prev.row)
        bottoms.set(a.col, a);
    }
    const pool = [...bottoms.values()];
    if (!pool.length)
      return;
    const shooter = pool[Math.floor(Math.random() * pool.length)];
    const p = alienPos(shooter);
    state.alienShots.push({ x: p.x, y: p.y + 12, vy: ALIEN_SHOT_V + state.wave * 0.35 });
    state.alienFireWait = Math.max(18, 52 - state.wave * 4);
  }
  function maybeUfo(dt) {
    if (state.ufo) {
      state.ufo.x += state.ufo.vx * dt;
      if (state.ufo.x < -40 || state.ufo.x > W + 40) {
        state.ufo = null;
        if (state.target?.kind === "ufo")
          state.target = null;
      }
      return;
    }
    state.ufoWait -= dt;
    if (state.ufoWait > 0)
      return;
    const goingRight = Math.random() < 0.5;
    state.ufo = { x: goingRight ? -20 : W + 20, vx: goingRight ? 2.6 : -2.6 };
    state.ufoWait = 480 + Math.random() * 260;
  }
  function collideShots() {
    if (state.playerShot) {
      const s = state.playerShot;
      if (s.y < 18)
        state.playerShot = null;
      else if (destroyBunkerAt(s.x, s.y))
        state.playerShot = null;
      else if (state.ufo && Math.abs(s.x - state.ufo.x) < 22 && Math.abs(s.y - 36) < 12) {
        state.score += 150;
        state.ufo = null;
        state.playerShot = null;
        if (state.target?.kind === "ufo")
          state.target = null;
      } else {
        for (const a of liveAliens()) {
          const p = alienPos(a);
          if (hitRect(s.x, s.y, p.x, p.y, ALIEN_W, ALIEN_H)) {
            killAlien(a);
            state.playerShot = null;
            break;
          }
        }
      }
    }
    state.alienShots = state.alienShots.filter((s) => {
      if (s.y > H - 8)
        return false;
      if (destroyBunkerAt(s.x, s.y))
        return false;
      if (state.invuln <= 0 && hitRect(s.x, s.y, state.shipX, SHIP_Y, SHIP_W, SHIP_H + 6)) {
        playerHit();
        return false;
      }
      return true;
    });
  }
  function fallbackTarget() {
    if (state.ufo && Math.abs(state.ufo.x - state.shipX) < 120)
      return { kind: "ufo" };
    const cols = columnView();
    if (!cols.length)
      return null;
    cols.sort((a, b) => b.lowest_y - a.lowest_y || Math.abs(a.x - state.shipX) - Math.abs(b.x - state.shipX));
    return { kind: "column", id: cols[0].id };
  }
  function aimXOf(target) {
    if (!target)
      return null;
    if (target.kind === "ufo")
      return state.ufo ? state.ufo.x : null;
    const col = columnView().find((c) => c.id === target.id);
    return col ? col.x : null;
  }
  function steerJev(dt) {
    const threat = incomingThreat();
    if (threat?.hits_if_stay) {
      const away = threat.x >= state.shipX ? -1 : 1;
      state.shipVx = lerp(state.shipVx, away * SHIP_SPEED, dt, 0.45);
      state.shipX = clamp(state.shipX + state.shipVx * dt, shipMin(), shipMax());
      return;
    }
    const lock = aimXOf(state.target) != null ? state.target : fallbackTarget();
    const tx = aimXOf(lock);
    if (tx == null) {
      state.shipVx = lerp(state.shipVx, 0, dt, 0.3);
      return;
    }
    const error = tx - state.shipX;
    const want = clamp(error * 0.22, -SHIP_SPEED, SHIP_SPEED);
    state.shipVx = lerp(state.shipVx, want, dt, 0.4);
    state.shipX = clamp(state.shipX + state.shipVx * dt, shipMin(), shipMax());
    if (Math.abs(error) < 10 && !state.playerShot)
      firePlayer();
  }
  function steerUser(dt) {
    if (state.keys.left === state.keys.right) {
      state.shipVx = 0;
    } else {
      state.shipVx = state.keys.left ? -SHIP_SPEED : SHIP_SPEED;
    }
    state.shipX = clamp(state.shipX + state.shipVx * dt, shipMin(), shipMax());
    if (state.keys.fire && !state.fireHeld)
      firePlayer();
    state.fireHeld = state.keys.fire;
  }
  function snapshot() {
    const threat = incomingThreat();
    return {
      rules: [
        "Space Invaders. Pick one column (or the UFO) for this attack run.",
        "The cannon slides under that x and fires. Incoming shots are dodged in code.",
        "Prefer the lowest aliens (largest y) so the formation never reaches the ship."
      ].join(" "),
      wave: state.wave,
      score: state.score,
      lives: state.lives,
      ship_x: Math.round(state.shipX),
      can_fire: !state.playerShot,
      threat,
      ufo: state.ufo ? { x: Math.round(state.ufo.x) } : null,
      columns: columnView()
    };
  }
  function needsAsk() {
    if (state.mode !== "jev" || state.phase !== "playing" || state.busy)
      return false;
    if (!columnView().length && !state.ufo)
      return false;
    const lock = state.target;
    if (lock?.kind === "ufo" && state.ufo)
      return false;
    if (lock?.kind === "column" && columnView().some((c) => c.id === lock.id))
      return false;
    return true;
  }
  async function askJev() {
    if (state.busy)
      return;
    state.busy = true;
    const t0 = performance.now();
    try {
      const res = await fetch("/api/invaders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot())
      });
      const ms = Math.round(performance.now() - t0);
      recordLatency(ms);
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.detail || data.error || `http ${res.status}`);
      if (data.column === "ufo" && state.ufo)
        state.target = { kind: "ufo" };
      else if (typeof data.column === "number" && columnView().some((c) => c.id === data.column)) {
        state.target = { kind: "column", id: data.column };
      } else {
        state.target = fallbackTarget();
      }
      const label = state.target?.kind === "ufo" ? "UFO" : `COL ${state.target?.id ?? "?"}`;
      setStatus(`JEV  ${label}`, `${ms}ms · wave ${state.wave}`);
      logDecision("flap", `${label}  ${ms}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Jev call failed";
      setStatus("ERROR", message);
      logDecision("error", message);
      state.target = fallbackTarget();
    } finally {
      state.busy = false;
    }
  }
  function update(dt) {
    if (state.phase === "over") {
      if (state.mode === "jev") {
        state.invuln -= dt;
        if (state.invuln < -90)
          resetGame();
      }
      return;
    }
    if (state.invuln > 0)
      state.invuln -= dt;
    if (needsAsk())
      askJev();
    if (state.mode === "you")
      steerUser(dt);
    else
      steerJev(dt);
    march(dt);
    maybeAlienFire(dt);
    maybeUfo(dt);
    if (state.playerShot)
      state.playerShot.y += state.playerShot.vy * dt;
    for (const s of state.alienShots)
      s.y += s.vy * dt;
    collideShots();
  }
  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  function drawAlien(a) {
    const p = alienPos(a);
    const w = ALIEN_W;
    const h = ALIEN_H;
    const x = p.x - w / 2;
    const y = p.y - h / 2;
    ctx.fillStyle = a.row === 0 ? "#fff4a3" : a.row <= 2 ? "#7ad3c0" : "#b6f08a";
    const f = state.anim;
    ctx.fillRect(x + 8, y + 4, w - 16, h - 8);
    ctx.fillRect(x + 4, y + 8, w - 8, 8);
    ctx.fillRect(x + (f ? 2 : w - 8), y + 14, 6, 6);
    ctx.fillRect(x + (f ? w - 8 : 2), y + 14, 6, 6);
    ctx.fillStyle = "#05080f";
    ctx.fillRect(x + 10, y + 8, 5, 5);
    ctx.fillRect(x + w - 15, y + 8, 5, 5);
  }
  function drawShip() {
    if (state.invuln > 0 && Math.floor(state.invuln / 6) % 2 === 0)
      return;
    const x = state.shipX - SHIP_W / 2;
    const y = SHIP_Y - SHIP_H / 2;
    ctx.fillStyle = "#f4f7fb";
    roundRect(x, y + 6, SHIP_W, SHIP_H - 6, 3);
    ctx.fill();
    ctx.fillRect(state.shipX - 4, y, 8, 10);
  }
  function draw() {
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    ctx.fillStyle = "#05080f";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#8aa0b8";
    for (const st of state.stars) {
      ctx.globalAlpha = 0.25 + st.s * 0.2;
      ctx.fillRect(st.x, st.y, st.s, st.s);
    }
    ctx.globalAlpha = 1;
    if (state.ufo) {
      ctx.fillStyle = "#ff6b6b";
      roundRect(state.ufo.x - 22, 24, 44, 16, 8);
      ctx.fill();
      ctx.fillStyle = "#fff4a3";
      ctx.fillRect(state.ufo.x - 10, 30, 4, 4);
      ctx.fillRect(state.ufo.x + 6, 30, 4, 4);
    }
    for (const a of liveAliens())
      drawAlien(a);
    ctx.fillStyle = "#2ecc71";
    for (const c of state.bunkers) {
      if (c.alive)
        ctx.fillRect(c.x, c.y, 6, 6);
    }
    if (state.playerShot) {
      ctx.fillStyle = "#fff4a3";
      ctx.fillRect(state.playerShot.x - 1.5, state.playerShot.y - 10, 3, 12);
    }
    ctx.fillStyle = "#ff8a8a";
    for (const s of state.alienShots)
      ctx.fillRect(s.x - 1.5, s.y, 3, 10);
    drawShip();
    ctx.fillStyle = "#1a3a28";
    ctx.fillRect(16, H - 18, W - 32, 4);
    ctx.font = `10px "Press Start 2P", monospace`;
    ctx.fillStyle = "#f4f7fb";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`SCORE ${state.score}`, 24, 16);
    ctx.textAlign = "right";
    ctx.fillText(`WAVE ${state.wave}`, W - 24, 16);
    ctx.textAlign = "center";
    ctx.fillStyle = "#8fd0c9";
    ctx.fillText(`LIVES ${state.lives}`, W / 2, 16);
    if (state.phase === "over") {
      ctx.fillStyle = "rgba(5,8,15,0.62)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#fff4a3";
      ctx.font = `18px "Press Start 2P", monospace`;
      ctx.fillText("GAME OVER", W / 2, H / 2 - 24);
      ctx.font = `10px "Press Start 2P", monospace`;
      ctx.fillStyle = "#f4f7fb";
      ctx.fillText(state.mode === "you" ? "SPACE TO RESTART" : "JEV RESTARTING", W / 2, H / 2 + 12);
    }
  }
  function resize() {
    const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  function setMode(mode) {
    state.mode = mode;
    resetGame();
    feedList?.replaceChildren();
    setStatus(mode === "jev" ? "JEV PLAYING" : "YOU", mode === "you" ? "← → and space" : "locking a column");
    for (const btn of modeButtons)
      btn.classList.toggle("is-active", btn.dataset.mode === mode);
    writeSearch({ mode: mode === "jev" ? null : mode });
  }
  window.addEventListener("keydown", (event) => {
    if (event.code === "ArrowLeft" || event.code === "ArrowRight" || event.code === "Space") {
      event.preventDefault();
    }
    if (event.code === "ArrowLeft")
      state.keys.left = true;
    if (event.code === "ArrowRight")
      state.keys.right = true;
    if (event.code === "Space") {
      state.keys.fire = true;
      if (state.phase === "over" && state.mode === "you")
        resetGame();
    }
  }, { passive: false });
  window.addEventListener("keyup", (event) => {
    if (event.code === "ArrowLeft")
      state.keys.left = false;
    if (event.code === "ArrowRight")
      state.keys.right = false;
    if (event.code === "Space")
      state.keys.fire = false;
  });
  for (const btn of modeButtons) {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      const mode = btn.dataset.mode;
      if (mode === "you" || mode === "jev")
        setMode(mode);
    });
  }
  var last = performance.now();
  function loop(now) {
    const dt = Math.min(2.2, (now - last) / (1000 / 60));
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }
  window.addEventListener("resize", resize);
  resize();
  initLatencyChart();
  setMode(new URLSearchParams(location.search).get("mode") === "you" ? "you" : "jev");
  window.addEventListener("popstate", () => {
    setMode(new URLSearchParams(location.search).get("mode") === "you" ? "you" : "jev");
  });
  requestAnimationFrame(loop);
})();
