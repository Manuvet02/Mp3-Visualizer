import { audioState } from "./state.js";

const canvas = document.getElementById("myCanvas");
const ctx = canvas.getContext("2d");

// Optimization: Pre-allocate variables to avoid GC
const dpr = window.devicePixelRatio || 1;
let cachedGradient = null;
let logicalWidth = 0;
let logicalHeight = 0;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.scale(dpr, dpr);

  logicalWidth = canvas.width / dpr;
  logicalHeight = canvas.height / dpr;

  // Create Gradient once on resize
  cachedGradient = ctx.createLinearGradient(0, logicalHeight, 0, 0);
  cachedGradient.addColorStop(0, "#240046");
  cachedGradient.addColorStop(0.3, "#7b2cbf");
  cachedGradient.addColorStop(0.6, "#ff006e");
  cachedGradient.addColorStop(1, "#3a86ff");
}

// Configuration
const SMOOTHING = 0.8;
const BAR_COUNT = 256;
const smoothedBars = new Array(BAR_COUNT).fill(0);
const PARTICLE_COUNT = 50;
const particles = [];
const flyingParticles = [];

window.addEventListener("resize", () => {
  resizeCanvas();
  initParticles();
});
resizeCanvas(); // Initial call

class BackgroundParticle {
  constructor(logicalWidth, logicalHeight) {
    this.reset(logicalWidth, logicalHeight);
  }

  reset(w, h) {
    this.x = Math.random() * w;
    this.y = Math.random() * h;
    this.size = Math.random() * 2 + 1;
    this.speedY = Math.random() * 1 + 0.5;
    this.opacity = Math.random() * 0.5 + 0.1;
    this.w = w;
    this.h = h;
  }

  update(bass) {
    this.y -= this.speedY + bass * 0.05;
    if (this.y < 0) {
      this.reset(this.w, this.h);
      this.y = this.h;
    }
  }

  draw(ctx) {
    ctx.fillStyle = `rgba(255, 255, 255, ${this.opacity})`;
    ctx.moveTo(this.x, this.y);
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
  }
}

class BarParticle {
  constructor(x, y, hue) {
    this.x = x;
    this.y = y;
    this.size = Math.random() * 3 + 1;
    this.speedX = (Math.random() - 0.5) * 2;
    this.speedY = -(Math.random() * 3 + 1);
    this.opacity = 1;
    this.hue = hue;
  }

  update() {
    this.x += this.speedX;
    this.y += this.speedY;
    this.opacity -= 0.02;
  }

  draw(ctx) {
    // Optimization: avoid template literals in loop if possible, but this is minor
    ctx.fillStyle = `hsla(${this.hue}, 100%, 80%, ${this.opacity})`;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function initParticles() {
  particles.length = 0;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push(new BackgroundParticle(logicalWidth, logicalHeight));
  }
}

// Initialize once
initParticles();

function draw() {
  requestAnimationFrame(draw);
  if (!audioState.analyser) return;

  audioState.analyser.getByteFrequencyData(audioState.dataArray);

  // Clear Canvas
  ctx.clearRect(0, 0, logicalWidth, logicalHeight);

  // Analyze Bass (Optimized)
  let bassSum = 0;
  let count = 0;
  // Reduce range scan
  const range = Math.min(audioState.dataArray.length, 50);
  for (let k = 0; k < range; k++) {
    bassSum += audioState.dataArray[k];
    count++;
  }
  const avgBass = count ? bassSum / count : 0;
  const bassNorm = avgBass / 255;

  // Dynamic Hue Calculation
  const time = performance.now() / 50;
  const baseHue = time % 360;

  // Batch Background Particles
  particles.forEach((p) => {
    p.update(bassNorm);
    // Dynamic color for background particles
    ctx.fillStyle = `hsla(${baseHue}, 50%, 80%, ${p.opacity})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  });

  // Flying Particles
  for (let i = flyingParticles.length - 1; i >= 0; i--) {
    let fp = flyingParticles[i];
    fp.update();
    fp.draw(ctx);
    if (fp.opacity <= 0) {
      flyingParticles.splice(i, 1);
    }
  }

  // Draw Bars
  // Create dynamic gradient
  const gradient = ctx.createLinearGradient(0, logicalHeight, 0, 0);
  gradient.addColorStop(0, `hsla(${baseHue}, 80%, 50%, 1)`);
  gradient.addColorStop(0.5, `hsla(${(baseHue + 60) % 360}, 80%, 50%, 1)`);
  gradient.addColorStop(1, `hsla(${(baseHue + 120) % 360}, 80%, 50%, 1)`);

  ctx.fillStyle = gradient;

  const cx = logicalWidth / 2;
  const barWidth = (cx / BAR_COUNT) * 0.8;
  const barSpacing = (cx / BAR_COUNT) * 0.2;
  const bufferLength = audioState.dataArray.length;

  ctx.beginPath(); // Batch draw bars into one path for performance!

  // Pass 1: Update bars and find peak
  let maxVal = 1;
  for (let i = 0; i < BAR_COUNT; i++) {
    const start = Math.floor(Math.pow(i / BAR_COUNT, 1.8) * (bufferLength / 2));
    const end =
      Math.floor(Math.pow((i + 1) / BAR_COUNT, 1.8) * (bufferLength / 2)) + 1;

    let sum = 0;
    let count = 0;

    for (let j = start; j < end; j++) {
      if (audioState.dataArray[j] !== undefined) {
        sum += audioState.dataArray[j];
        count++;
      }
    }

    const rawValue = count ? sum / count : 0;
    smoothedBars[i] += (rawValue - smoothedBars[i]) * SMOOTHING;

    if (smoothedBars[i] > maxVal) {
      maxVal = smoothedBars[i];
    }
  }

  // Pass 2: Draw
  for (let i = 0; i < BAR_COUNT; i++) {
    // Normalize based on the loudest bar in the current frame
    // Use a floor for maxVal to avoid scaling noise too much
    const effectiveMax = Math.max(maxVal, 255);
    const barHeight = (smoothedBars[i] / effectiveMax) * logicalHeight * 0.85;

    if (barHeight > 2) {
      const xRight = cx + i * (barWidth + barSpacing);
      const xLeft = cx - i * (barWidth + barSpacing) - barWidth;
      const yTop = logicalHeight - barHeight;

      ctx.rect(xRight, yTop, barWidth, barHeight);
      ctx.rect(xLeft, yTop, barWidth, barHeight);
    }
  }
  ctx.fill(); // Single fill call for all bars
}
draw();
