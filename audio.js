import { audioState } from "./state.js";

const audioElement = document.getElementById("audio");

let audioContext;
let source;

export function initAudio() {
  if (audioContext) return;

  audioContext = new AudioContext();

  source = audioContext.createMediaElementSource(audioElement);

  audioState.analyser = audioContext.createAnalyser();
  audioState.analyser.fftSize = 1024;
  audioState.analyser.smoothingTimeConstant = 0.8;

  audioState.dataArray = new Uint8Array(audioState.analyser.frequencyBinCount);

  source.connect(audioState.analyser);
  audioState.analyser.connect(audioContext.destination);

  audioElement.addEventListener("play", () => {
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
  });
}

export function loadAudio(file) {
  audioElement.src = URL.createObjectURL(file);
  audioElement.load();
}
