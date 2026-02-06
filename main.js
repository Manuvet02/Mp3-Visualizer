import { initAudio, loadAudio } from "./audio.js";
import "./visualizer.js";

const input = document.getElementById("fileInput");
const audioElement = document.getElementById("audio");

// File Input Change
input.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  initAudio();
  loadAudio(file);
  document.getElementById("trackInfo").textContent = file.name.replace(
    /\.[^/.]+$/,
    "",
  );
});

// Drag & Drop Support
document.body.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  // Optional: Add a visual cue like changing opacity
  document.body.style.opacity = "0.8";
});

document.body.addEventListener("dragleave", (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.body.style.opacity = "1";
});

document.body.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.body.style.opacity = "1";

  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("audio/")) {
    initAudio(); // Ensure context is ready
    loadAudio(file);
    // Auto-play on drop
    audioElement.play().catch((e) => console.log("Autoplay blocked", e));
    document.getElementById("trackInfo").textContent = file.name.replace(
      /\.[^/.]+$/,
      "",
    );
  }
});

// Playback Controls
function togglePlayback() {
  if (!audioElement.src) return; // No media loaded

  // Ensure AudioContext is running (sometimes needed if stuck in suspended)
  initAudio();

  if (audioElement.paused) {
    audioElement.play();
  } else {
    audioElement.pause();
  }
}

// Spacebar to pause/play
document.addEventListener("keydown", (e) => {
  if (e.target === input) return;

  if (e.code === "Space") {
    e.preventDefault(); // Prevent scrolling
    togglePlayback();
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    audioElement.currentTime = Math.min(
      audioElement.duration,
      audioElement.currentTime + 5,
    );
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    audioElement.currentTime = Math.max(0, audioElement.currentTime - 5);
  } else if (e.code === "ArrowUp") {
    e.preventDefault();
    audioElement.volume = Math.min(1, audioElement.volume + 0.1);
  } else if (e.code === "ArrowDown") {
    e.preventDefault();
    audioElement.volume = Math.max(0, audioElement.volume - 0.1);
  }
});

// Click on canvas to toggle playback
document.getElementById("myCanvas").addEventListener("click", () => {
  togglePlayback();
});

// Menu Toggle Logic
const sideMenu = document.getElementById("sideMenu");
const menuToggle = document.getElementById("menuToggle");
const closeMenu = document.getElementById("closeMenu");

function toggleMenu() {
  sideMenu.classList.toggle("open");
}

menuToggle.addEventListener("click", toggleMenu);
closeMenu.addEventListener("click", toggleMenu);

// Close menu when clicking outside (optional but good UX)
document.addEventListener("click", (e) => {
  if (
    sideMenu.classList.contains("open") &&
    !sideMenu.contains(e.target) &&
    e.target !== menuToggle
  ) {
    sideMenu.classList.remove("open");
  }
});
