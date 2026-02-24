import { audioState } from "./state.js";

// ─────────────────────────────────────
// CANVAS + CONTEXT
// ─────────────────────────────────────
const canvas = document.getElementById("myCanvas");
const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });

if (!gl) {
  alert(
    "WebGL2 is not supported in your browser. Try Chrome, Edge, or Firefox.",
  );
}

// ─────────────────────────────────────
// CONFIG
// ─────────────────────────────────────
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

const BAR_COUNT = isMobile ? 512 : 1024;
const PARTICLE_COUNT = isMobile ? 20 : 35;
const MAX_DPR = isMobile ? 1.5 : 2;
const SMOOTHING = 0.75;

// ─────────────────────────────────────
// STATE
// ─────────────────────────────────────
let logicalWidth = 0;
let logicalHeight = 0;
let dpr = 1;

// Bar audio data
const smoothedBars = new Float32Array(BAR_COUNT);
const barHeightsNorm = new Float32Array(BAR_COUNT); // 0..1, sent to GPU

// Flat bin ranges [start0, end0, start1, end1, ...]
let binRanges = null;

// Particle state (updated CPU-side, streamed to GPU each frame)
const px = new Float32Array(PARTICLE_COUNT); // x position
const py = new Float32Array(PARTICLE_COUNT); // y position
const psp = new Float32Array(PARTICLE_COUNT); // speed
const pop = new Float32Array(PARTICLE_COUNT); // opacity
const psz = new Float32Array(PARTICLE_COUNT); // point size (physical px)

// Interleaved VBO: [x, y, size, opacity] × PARTICLE_COUNT
const particleData = new Float32Array(PARTICLE_COUNT * 4);

// ─────────────────────────────────────
// SHADER HELPERS
// ─────────────────────────────────────
function compileShader(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("Shader error:", gl.getShaderInfoLog(sh), "\n", src);
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function createProgram(vertSrc, fragSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error("Program link error:", gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

// ─────────────────────────────────────
// BAR SHADERS
// BAR_COUNT is injected as a compile-time constant so the uniform array
// size is fixed (required by GLSL).
// Each instance draws one rectangle (right side: 0..N-1, left: N..2N-1).
// ─────────────────────────────────────
const barVertSrc = /* glsl */ `#version 300 es

// One unit-quad vertex [0..1, 0..1]. 6 verts = 2 triangles = 1 bar.
in vec2 a_quad;

// BAR_COUNT bars, normalized heights 0..1
uniform float u_barHeights[${BAR_COUNT}];
uniform vec2  u_resolution; // logical CSS pixels

out float v_screenY; // 0 = canvas top, 1 = canvas bottom (for gradient)

void main() {
  int barIdx = int(gl_InstanceID) % ${BAR_COUNT};
  int side   = int(gl_InstanceID) / ${BAR_COUNT}; // 0 = right, 1 = left

  float cx      = u_resolution.x * 0.5;
  float barUnit = cx / float(${BAR_COUNT});
  float barW    = barUnit * 0.82;
  float gap     = barUnit - barW;

  float h = u_barHeights[barIdx] * u_resolution.y * 0.85;

  // X base: right side fans out from center, left is mirrored
  float xBase;
  if (side == 0) {
    xBase = cx + float(barIdx) * barUnit + gap * 0.5;
  } else {
    xBase = cx - float(barIdx) * barUnit - barW - gap * 0.5;
  }

  // Pixel position (x: left-to-right, y: top-to-bottom)
  float x = xBase + a_quad.x * barW;
  float y = (u_resolution.y - h) + a_quad.y * h;

  // Used by fragment shader for gradient
  v_screenY = y / u_resolution.y;

  // Convert to NDC: x ∈ [-1,1], y ∈ [1,-1] (WebGL y-up, canvas y-down)
  gl_Position = vec4(
    x / u_resolution.x * 2.0 - 1.0,
    -(y / u_resolution.y * 2.0 - 1.0),
    0.0, 1.0
  );
}
`;

const barFragSrc = /* glsl */ `#version 300 es
precision mediump float;

in  float v_screenY; // 0 = top, 1 = bottom
out vec4  fragColor;

// Same gradient as the original canvas version:
// top (#3a86ff) → middle (#ff006e) → bottom (#240046)
vec3 gradient(float t) {
  vec3 top = vec3(0.227, 0.525, 1.0);   // #3a86ff
  vec3 mid = vec3(1.0,   0.0,   0.431); // #ff006e
  vec3 bot = vec3(0.141, 0.0,   0.275); // #240046
  if (t < 0.5) return mix(top, mid, t * 2.0);
  return mix(mid, bot, (t - 0.5) * 2.0);
}

void main() {
  fragColor = vec4(gradient(v_screenY), 1.0);
}
`;

// ─────────────────────────────────────
// PARTICLE SHADERS
// Drawn as GL_POINTS — one GPU call for all particles.
// Position/size/opacity are streamed as vertex attributes.
// ─────────────────────────────────────
const partVertSrc = /* glsl */ `#version 300 es

in vec2  a_position; // logical CSS px
in float a_size;     // physical px (already dpr-scaled)
in float a_opacity;

uniform vec2 u_resolution; // logical CSS px

out float v_opacity;

void main() {
  v_opacity    = a_opacity;
  gl_PointSize = a_size;
  gl_Position  = vec4(
    a_position.x / u_resolution.x * 2.0 - 1.0,
    -(a_position.y / u_resolution.y * 2.0 - 1.0),
    0.0, 1.0
  );
}
`;

const partFragSrc = /* glsl */ `#version 300 es
precision mediump float;

in  float v_opacity;
out vec4  fragColor;

void main() {
  fragColor = vec4(1.0, 1.0, 1.0, v_opacity);
}
`;

// ─────────────────────────────────────
// COMPILE PROGRAMS
// ─────────────────────────────────────
const barProg = createProgram(barVertSrc, barFragSrc);
const partProg = createProgram(partVertSrc, partFragSrc);

// Bar uniform/attribute locations
const barLoc = {
  a_quad: gl.getAttribLocation(barProg, "a_quad"),
  u_barHeights: gl.getUniformLocation(barProg, "u_barHeights"),
  u_resolution: gl.getUniformLocation(barProg, "u_resolution"),
};

// Particle uniform/attribute locations
const partLoc = {
  a_position: gl.getAttribLocation(partProg, "a_position"),
  a_size: gl.getAttribLocation(partProg, "a_size"),
  a_opacity: gl.getAttribLocation(partProg, "a_opacity"),
  u_resolution: gl.getUniformLocation(partProg, "u_resolution"),
};

// ─────────────────────────────────────
// BAR VAO — a static unit-quad VBO
// Six vertices form two triangles covering [0..1, 0..1].
// gl_InstanceID is used in the shader to position each copy.
// ─────────────────────────────────────
const quadVerts = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);

const barVAO = gl.createVertexArray();
gl.bindVertexArray(barVAO);

const quadVBO = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

gl.enableVertexAttribArray(barLoc.a_quad);
gl.vertexAttribPointer(barLoc.a_quad, 2, gl.FLOAT, false, 0, 0);

gl.bindVertexArray(null);

// ─────────────────────────────────────
// PARTICLE VAO — dynamic, updated every frame
// Interleaved layout: [x(f32), y(f32), size(f32), opacity(f32)] = 16 bytes/vertex
// ─────────────────────────────────────
const PART_STRIDE = 4 * 4; // 4 floats × 4 bytes

const partVAO = gl.createVertexArray();
gl.bindVertexArray(partVAO);

const partVBO = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, partVBO);
gl.bufferData(gl.ARRAY_BUFFER, particleData, gl.DYNAMIC_DRAW);

gl.enableVertexAttribArray(partLoc.a_position);
gl.vertexAttribPointer(partLoc.a_position, 2, gl.FLOAT, false, PART_STRIDE, 0);

gl.enableVertexAttribArray(partLoc.a_size);
gl.vertexAttribPointer(partLoc.a_size, 1, gl.FLOAT, false, PART_STRIDE, 8);

gl.enableVertexAttribArray(partLoc.a_opacity);
gl.vertexAttribPointer(partLoc.a_opacity, 1, gl.FLOAT, false, PART_STRIDE, 12);

gl.bindVertexArray(null);

// Enable alpha blending for particles
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// ─────────────────────────────────────
// PARTICLES — CPU STATE
// ─────────────────────────────────────
function resetParticle(i) {
  px[i] = Math.random() * logicalWidth;
  py[i] = Math.random() * logicalHeight;
  psp[i] = Math.random() * 0.6 + 0.3;
  pop[i] = Math.random() * 0.4 + 0.1;
  psz[i] = (Math.random() < 0.5 ? 1.5 : 2.5) * dpr; // physical px
}

function initParticles() {
  for (let i = 0; i < PARTICLE_COUNT; i++) resetParticle(i);
}

// ─────────────────────────────────────
// RESIZE
// ─────────────────────────────────────
function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;

  gl.viewport(0, 0, canvas.width, canvas.height);

  logicalWidth = canvas.width / dpr;
  logicalHeight = canvas.height / dpr;

  binRanges = null; // recompute on next draw
  initParticles();
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ─────────────────────────────────────
// BIN RANGES — logarithmic frequency mapping
// ─────────────────────────────────────
function computeBinRanges(bufferLength) {
  const half = bufferLength >> 1;
  binRanges = new Int32Array(BAR_COUNT * 2);
  for (let i = 0; i < BAR_COUNT; i++) {
    binRanges[i * 2] = Math.floor(Math.pow(i / BAR_COUNT, 1.8) * half);
    binRanges[i * 2 + 1] =
      Math.floor(Math.pow((i + 1) / BAR_COUNT, 1.8) * half) + 1;
  }
}

// ─────────────────────────────────────
// MAIN RENDER LOOP
// ─────────────────────────────────────
function draw() {
  requestAnimationFrame(draw);
  if (!audioState.analyser) return;

  audioState.analyser.getByteFrequencyData(audioState.dataArray);
  const data = audioState.dataArray;

  if (!binRanges) computeBinRanges(data.length);

  // ── Background clear (matches CSS #121212)
  gl.clearColor(0.0706, 0.0706, 0.0706, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // ── Bass energy (first ~40 bins)
  let bassSum = 0;
  for (let i = 0; i < 40; i++) bassSum += data[i];
  const bassNorm = bassSum / (40 * 255);

  // ── Smooth bars + find peak
  let maxVal = 180; // floor prevents over-scaling during quiet moments
  for (let i = 0; i < BAR_COUNT; i++) {
    const s = binRanges[i * 2];
    const e = binRanges[i * 2 + 1];
    let sum = 0;
    for (let j = s; j < e; j++) sum += data[j];
    const raw = e > s ? sum / (e - s) : 0;
    smoothedBars[i] += (raw - smoothedBars[i]) * SMOOTHING;
    if (smoothedBars[i] > maxVal) maxVal = smoothedBars[i];
  }

  // Normalise to 0..1
  const invMax = 1.0 / maxVal;
  for (let i = 0; i < BAR_COUNT; i++) {
    barHeightsNorm[i] = smoothedBars[i] * invMax;
  }

  // ── DRAW BARS (one instanced call = 2×BAR_COUNT rectangles)
  gl.useProgram(barProg);
  gl.bindVertexArray(barVAO);
  gl.uniform2f(barLoc.u_resolution, logicalWidth, logicalHeight);
  gl.uniform1fv(barLoc.u_barHeights, barHeightsNorm);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, BAR_COUNT * 2);

  // ── UPDATE + DRAW PARTICLES
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    py[i] -= psp[i] + bassNorm * 0.8;
    if (py[i] < 0) {
      py[i] = logicalHeight;
      px[i] = Math.random() * logicalWidth;
    }
    const b = i * 4;
    particleData[b] = px[i];
    particleData[b + 1] = py[i];
    particleData[b + 2] = psz[i];
    particleData[b + 3] = pop[i];
  }

  gl.useProgram(partProg);
  gl.bindVertexArray(partVAO);
  gl.uniform2f(partLoc.u_resolution, logicalWidth, logicalHeight);
  gl.bindBuffer(gl.ARRAY_BUFFER, partVBO);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, particleData);
  gl.drawArrays(gl.POINTS, 0, PARTICLE_COUNT);

  gl.bindVertexArray(null);
}

draw();
