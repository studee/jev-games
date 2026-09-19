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

  // src/draw.ts
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
  var drawing = false;
  var promptText = "";
  var caretOn = true;
  var cols = 24;
  var rows = 18;
  var grid = [];
  var painted = 0;
  function setStatus(action, meta) {
    if (feedAction)
      feedAction.textContent = action;
    if (feedMeta)
      feedMeta.textContent = meta;
  }
  function logLine(kind, text) {
    if (!feedList)
      return;
    const li = document.createElement("li");
    li.className = kind;
    li.textContent = text;
    feedList.prepend(li);
    while (feedList.children.length > 14)
      feedList.removeChild(feedList.lastChild);
  }
  function rgb(r, g, b) {
    return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  }
  function resize() {
    const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      paint();
    }
  }
  function paper() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, "#f4efe4");
    g.addColorStop(1, "#e4d8c4");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  function paint() {
    paper();
    const w = canvas.width;
    const h = canvas.height;
    if (painted === 0) {
      ctx.fillStyle = promptText ? "#2a2018" : "#8a7a68";
      ctx.font = `${Math.max(13, Math.floor(w * 0.026))}px "Press Start 2P", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const title = promptText || "type what to draw";
      const shown = title.length > 42 ? `${title.slice(0, 40)}…` : title;
      ctx.fillText(shown + (caretOn && !drawing ? "|" : ""), w / 2, h / 2 - 18);
      ctx.font = `${Math.max(12, Math.floor(w * 0.02))}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = "#6a5a48";
      ctx.fillText("press Enter · 9 sections, each patch sees neighbors", w / 2, h / 2 + 22);
      return;
    }
    const cw = w / cols;
    const ch = h / rows;
    for (const px of grid) {
      if (!px)
        continue;
      ctx.fillStyle = rgb(px.r, px.g, px.b);
      ctx.fillRect(Math.floor(px.x * cw), Math.floor(px.y * ch), Math.ceil(cw) + 1, Math.ceil(ch) + 1);
    }
    if (!drawing && promptText) {
      ctx.fillStyle = "rgba(244,239,228,0.82)";
      ctx.fillRect(0, h * 0.42, w, h * 0.16);
      ctx.fillStyle = "#2a2018";
      ctx.font = `${Math.max(12, Math.floor(w * 0.022))}px "Press Start 2P", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const shown = promptText.length > 42 ? `${promptText.slice(0, 40)}…` : promptText;
      ctx.fillText(shown + (caretOn ? "|" : ""), w / 2, h / 2);
    }
  }
  async function runDraw() {
    if (drawing)
      return;
    const prompt = promptText.trim();
    if (!prompt) {
      setStatus("NEED WORDS", "type on the canvas");
      canvas.focus();
      return;
    }
    drawing = true;
    painted = 0;
    grid.length = 0;
    paint();
    setStatus("JEV DRAWING", "9 sections");
    feedList?.replaceChildren();
    logLine("flap", prompt);
    try {
      const res = await fetch("/api/draw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || err.error || `http ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder;
      let buf = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done)
          break;
        buf += decoder.decode(chunk.value, { stream: true });
        const bits = buf.split(`

`);
        buf = bits.pop() ?? "";
        for (const bit of bits) {
          const line = bit.split(`
`).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (!line)
            continue;
          const msg = JSON.parse(line);
          if (msg.started && msg.cols && msg.rows) {
            cols = msg.cols;
            rows = msg.rows;
            grid.length = cols * rows;
            grid.fill(null);
            painted = 0;
          }
          if (msg.area) {
            recordLatency(msg.area.ms);
            for (const px of msg.area.pixels) {
              grid[px.y * cols + px.x] = px;
              painted += 1;
            }
            logLine("flap", `area ${msg.area.x},${msg.area.y}  ${msg.area.ms}ms`);
            setStatus("JEV DRAWING", `${painted}/${cols * rows} px · 9 sections`);
            paint();
          }
          if (msg.done) {
            setStatus("DONE", prompt);
            promptText = "";
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "draw failed";
      setStatus("ERROR", message);
      logLine("error", message);
    } finally {
      drawing = false;
      canvas.focus();
      paint();
    }
  }
  canvas.addEventListener("click", () => canvas.focus());
  window.addEventListener("keydown", (event) => {
    const tag = event.target instanceof HTMLElement ? event.target.tagName : "";
    if (tag === "A" || tag === "BUTTON" || tag === "TEXTAREA" || tag === "INPUT")
      return;
    if (event.metaKey || event.ctrlKey || event.altKey)
      return;
    if (event.key === "Enter") {
      event.preventDefault();
      runDraw();
      return;
    }
    if (drawing)
      return;
    if (event.key === "Backspace") {
      event.preventDefault();
      promptText = promptText.slice(0, -1);
      paint();
      return;
    }
    if (event.key === "Escape") {
      promptText = "";
      painted = 0;
      grid.length = 0;
      paint();
      return;
    }
    if (event.key.length === 1 && promptText.length < 120) {
      event.preventDefault();
      promptText += event.key;
      paint();
    }
  });
  setInterval(() => {
    if (drawing)
      return;
    caretOn = !caretOn;
    if (painted === 0 || promptText)
      paint();
  }, 500);
  window.addEventListener("resize", resize);
  resize();
  canvas.focus();
  initLatencyChart();
  setStatus("WAITING", "type on the canvas");
})();
