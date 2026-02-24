import { audioState } from "./state.js";

const canvas = document.getElementById("myCanvas");
const ctx = canvas.getContext("2d", { alpha: false });

// -----------------------------
// PERFORMANCE CONFIG
// -----------------------------
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

const BAR_COUNT = isMobile ? 64 : 128;
const PARTICLE_COUNT = isMobile ? 20 : 35;
const MAX_DPR = isMobile ? 1.5 : 2;
const SMOOTHING = 0.8; // 0 = sluggish, 1 = instant; 0.75 feels snappy yet smooth

// -----------------------------
// GLOBALS
// -----------------------------
let logicalWidth = 0;
let logicalHeight = 0;
let dpr = 1;

let cachedGradient = null;
let binRanges = [];

const smoothedBars = new Float32Array(BAR_COUNT); // typed array = less GC pressure

// Simple particles stored as flat arrays for cache efficiency
const px = new Float32Array(PARTICLE_COUNT);
const py = new Float32Array(PARTICLE_COUNT);
const psp = new Float32Array(PARTICLE_COUNT); // speed
const pop = new Float32Array(PARTICLE_COUNT); // opacity
const psz = new Float32Array(PARTICLE_COUNT); // size (integer 1-2)

function resetParticle(i) {
  px[i] = Math.random() * logicalWidth;
  py[i] = Math.random() * logicalHeight;
  psp[i] = Math.random() * 0.6 + 0.3;
  pop[i] = Math.random() * 0.4 + 0.1;
  psz[i] = Math.random() < 0.5 ? 1 : 2;
}

function initParticles() {
  for (let i = 0; i < PARTICLE_COUNT; i++) resetParticle(i);
}

// -----------------------------
// RESIZE
// -----------------------------
function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  logicalWidth = canvas.width / dpr;
  logicalHeight = canvas.height / dpr;

  // Rebuild gradient once
  cachedGradient = ctx.createLinearGradient(0, logicalHeight, 0, 0);
  cachedGradient.addColorStop(0, "#240046");
  cachedGradient.addColorStop(0.5, "#ff006e");
  cachedGradient.addColorStop(1, "#3a86ff");

  // Rebuild bin ranges for new buffer length (if analyser already set up)
  if (audioState.analyser) {
    computeBinRanges(audioState.dataArray.length);
  } else {
    binRanges = [];
  }

  initParticles();
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// -----------------------------
// PRECOMPUTE BIN RANGES
// -----------------------------
function computeBinRanges(bufferLength) {
  binRanges = [];
  const half = bufferLength >> 1; // same as Math.floor(bufferLength / 2)
  for (let i = 0; i < BAR_COUNT; i++) {
    const t0 = Math.pow(i / BAR_COUNT, 1.8);
    const t1 = Math.pow((i + 1) / BAR_COUNT, 1.8);
    binRanges.push(Math.floor(t0 * half), Math.floor(t1 * half) + 1);
    // stored as pairs: [start0, end0, start1, end1, ...]
  }
}

// -----------------------------
// MAIN LOOP
// -----------------------------
function draw() {
  requestAnimationFrame(draw);
  if (!audioState.analyser) return;

  audioState.analyser.getByteFrequencyData(audioState.dataArray);

  const data = audioState.dataArray;

  if (binRanges.length === 0) {
    computeBinRanges(data.length);
  }

  ctx.clearRect(0, 0, logicalWidth, logicalHeight);

  // ---- BASS (lightweight, first ~40 bins)
  let bassSum = 0;
  for (let i = 0; i < 40; i++) bassSum += data[i];
  const bassNorm = bassSum / (40 * 255);

  // ---- BACKGROUND PARTICLES (cheap fillRect squares, no arc/beginPath per particle)
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    py[i] -= psp[i] + bassNorm * 0.8;
    if (py[i] < 0) {
      py[i] = logicalHeight;
      px[i] = Math.random() * logicalWidth;
    }
    ctx.globalAlpha = pop[i];
    ctx.fillRect(px[i], py[i], psz[i], psz[i]); // fillRect is much cheaper than arc
  }
  ctx.globalAlpha = 1;

  // ---- BARS: single pass — smooth + draw together
  ctx.fillStyle = cachedGradient;
  ctx.beginPath();

  const cx = logicalWidth / 2;
  const barUnit = cx / BAR_COUNT;
  const barWidth = barUnit * 0.82;
  const gap = barUnit - barWidth;

  let maxVal = 180; // floor so quiet moments don't over-scale

  for (let i = 0; i < BAR_COUNT; i++) {
    const rangeStart = binRanges[i * 2];
    const rangeEnd = binRanges[i * 2 + 1];

    let sum = 0;
    for (let j = rangeStart; j < rangeEnd; j++) sum += data[j];
    const raw = rangeEnd > rangeStart ? sum / (rangeEnd - rangeStart) : 0;

    // Exponential smoothing
    smoothedBars[i] += (raw - smoothedBars[i]) * SMOOTHING;
    if (smoothedBars[i] > maxVal) maxVal = smoothedBars[i];
  }

  const scale = (logicalHeight * 0.85) / maxVal;

  for (let i = 0; i < BAR_COUNT; i++) {
    const h = smoothedBars[i] * scale;
    if (h < 2) continue;

    const xR = cx + i * barUnit + gap * 0.5;
    const xL = cx - i * barUnit - barWidth - gap * 0.5;
    const yT = logicalHeight - h;

    ctx.rect(xR, yT, barWidth, h);
    ctx.rect(xL, yT, barWidth, h);
  }

  ctx.fill();
}

draw();
