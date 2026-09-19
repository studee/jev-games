import { initLatencyChart, recordLatency } from "./latency.ts";
import type { DrawArea, DrawPixel } from "./types.ts";

const canvasEl = document.getElementById("game");
if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error("Missing #game canvas");
const canvas = canvasEl;
const context = canvas.getContext("2d");
if (!context) throw new Error("2D canvas is not available");
const ctx: CanvasRenderingContext2D = context;

const feedAction = document.getElementById("pilot-action");
const feedMeta = document.getElementById("pilot-meta");
const feedList = document.getElementById("decisions");

let drawing = false;
let promptText = "";
let caretOn = true;
let cols = 24;
let rows = 18;
const grid: (DrawPixel | null)[] = [];
let painted = 0;

function setStatus(action: string, meta: string): void {
  if (feedAction) feedAction.textContent = action;
  if (feedMeta) feedMeta.textContent = meta;
}

function logLine(kind: string, text: string): void {
  if (!feedList) return;
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = text;
  feedList.prepend(li);
  while (feedList.children.length > 14) feedList.removeChild(feedList.lastChild as Node);
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

function resize(): void {
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

function paper(): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, "#f4efe4");
  g.addColorStop(1, "#e4d8c4");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function paint(): void {
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
    if (!px) continue;
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

async function runDraw(): Promise<void> {
  if (drawing) return;
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
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok || !res.body) {
      const err = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
      throw new Error(err.detail || err.error || `http ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const bits = buf.split("\n\n");
      buf = bits.pop() ?? "";
      for (const bit of bits) {
        const line = bit
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!line) continue;
        const msg = JSON.parse(line) as {
          started?: boolean;
          cols?: number;
          rows?: number;
          area?: DrawArea;
          done?: boolean;
        };
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
  if (tag === "A" || tag === "BUTTON" || tag === "TEXTAREA" || tag === "INPUT") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "Enter") {
    event.preventDefault();
    void runDraw();
    return;
  }
  if (drawing) return;
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
  if (drawing) return;
  caretOn = !caretOn;
  if (painted === 0 || promptText) paint();
}, 500);

window.addEventListener("resize", resize);
resize();
canvas.focus();
initLatencyChart();
setStatus("WAITING", "type on the canvas");
