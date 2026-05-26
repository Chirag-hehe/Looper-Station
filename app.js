import {
  audioBufferToWav,
  clamp,
  copyAudioBufferSegment,
  deserializeAudioBuffer,
  fitBufferToLoop,
  formatClock,
  formatSeconds,
  getGridSize,
  mixBuffers,
  nextGridTime,
  normalizeMidiMessage,
  positiveModulo,
  quantizeLoopDuration,
  serializeAudioBuffer,
} from "./core.js";

const TRACK_COUNT = 6;
const DB_NAME = "looper-station";
const DB_STORE = "sessions";
const COLORS = ["#83e377", "#68d8bd", "#ff6b5f", "#e8bb4f", "#8fd0ff", "#f497d1"];

const elements = {
  statusText: document.querySelector("#statusText"),
  playBtn: document.querySelector("#playBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  saveBtn: document.querySelector("#saveBtn"),
  loadBtn: document.querySelector("#loadBtn"),
  deleteSaveBtn: document.querySelector("#deleteSaveBtn"),
  micBtn: document.querySelector("#micBtn"),
  midiBtn: document.querySelector("#midiBtn"),
  metronomeBtn: document.querySelector("#metronomeBtn"),
  overdubBtn: document.querySelector("#overdubBtn"),
  bpmInput: document.querySelector("#bpmInput"),
  beatsInput: document.querySelector("#beatsInput"),
  quantizeSelect: document.querySelector("#quantizeSelect"),
  inputDeviceSelect: document.querySelector("#inputDeviceSelect"),
  sessionSelect: document.querySelector("#sessionSelect"),
  monitorSlider: document.querySelector("#monitorSlider"),
  masterSlider: document.querySelector("#masterSlider"),
  loopReadout: document.querySelector("#loopReadout"),
  trackReadout: document.querySelector("#trackReadout"),
  clockReadout: document.querySelector("#clockReadout"),
  midiStatus: document.querySelector("#midiStatus"),
  scopeCanvas: document.querySelector("#scopeCanvas"),
  trackGrid: document.querySelector("#trackGrid"),
  trackTemplate: document.querySelector("#trackTemplate"),
  downloadLink: document.querySelector("#downloadLink"),
};

const state = {
  audioContext: null,
  stream: null,
  micSource: null,
  analyser: null,
  masterGain: null,
  monitorGain: null,
  isPlaying: false,
  loopLength: 0,
  sessionStart: 0,
  metronome: false,
  overdub: true,
  nextTickTime: 0,
  selectedInputId: "",
  db: null,
  midiAccess: null,
  tracks: [],
};

for (let index = 0; index < TRACK_COUNT; index += 1) {
  state.tracks.push(createTrack(index));
}

wireControls();
drawScope();
updateReadouts();
refreshSavedSessions();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

function createTrack(index) {
  const fragment = elements.trackTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".track-card");
  const title = fragment.querySelector("h2");
  const stateLabel = fragment.querySelector(".track-state");
  const waveform = fragment.querySelector(".waveform");
  const recordButton = fragment.querySelector(".record-button");
  const muteButton = fragment.querySelector(".mute-button");
  const clearButton = fragment.querySelector(".clear-track-button");
  const volumeSlider = fragment.querySelector(".volume-control input");

  title.textContent = `Track ${index + 1}`;
  card.style.setProperty("--track-color", COLORS[index]);
  recordButton.style.borderColor = `${COLORS[index]}88`;

  const track = {
    id: crypto.randomUUID(),
    index,
    color: COLORS[index],
    buffer: null,
    source: null,
    gainNode: null,
    recorder: null,
    chunks: [],
    captureStartAt: 0,
    recordStartAt: 0,
    recordEndAt: 0,
    stopTimer: 0,
    recording: false,
    discardTake: false,
    overdubTake: false,
    muted: false,
    volume: 1,
    elements: {
      card,
      stateLabel,
      waveform,
      recordButton,
      muteButton,
      clearButton,
      volumeSlider,
    },
  };

  recordButton.addEventListener("click", () => toggleRecording(track));
  muteButton.addEventListener("click", () => toggleMute(track));
  clearButton.addEventListener("click", () => clearTrack(track));
  volumeSlider.addEventListener("input", () => {
    track.volume = Number(volumeSlider.value);
    applyTrackGain(track);
  });

  elements.trackGrid.appendChild(fragment);
  drawEmptyWaveform(track);
  return track;
}

function wireControls() {
  elements.micBtn.addEventListener("click", initAudio);
  elements.midiBtn.addEventListener("click", enableMidi);
  elements.playBtn.addEventListener("click", () => {
    if (state.isPlaying) {
      stopSession();
    } else {
      playSession();
    }
  });
  elements.stopBtn.addEventListener("click", stopSession);
  elements.clearBtn.addEventListener("click", clearSession);
  elements.exportBtn.addEventListener("click", exportLoop);
  elements.saveBtn.addEventListener("click", saveSession);
  elements.loadBtn.addEventListener("click", loadSelectedSession);
  elements.deleteSaveBtn.addEventListener("click", deleteSelectedSession);
  elements.metronomeBtn.addEventListener("click", toggleMetronome);
  elements.overdubBtn.addEventListener("click", toggleOverdub);
  elements.inputDeviceSelect.addEventListener("change", () => {
    state.selectedInputId = elements.inputDeviceSelect.value;
    if (state.stream) {
      initAudio();
    }
  });
  elements.bpmInput.addEventListener("change", normalizeTimingInputs);
  elements.beatsInput.addEventListener("change", normalizeTimingInputs);
  elements.masterSlider.addEventListener("input", () => {
    if (state.masterGain) {
      state.masterGain.gain.value = Number(elements.masterSlider.value);
    }
  });
  elements.monitorSlider.addEventListener("input", () => {
    if (state.monitorGain) {
      state.monitorGain.gain.value = Number(elements.monitorSlider.value);
    }
  });
  document.addEventListener("keydown", handleKeyboard);

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", refreshInputDevices);
  }
}

async function ensureAudioContext() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    setStatus("Web Audio is not supported in this browser");
    return null;
  }

  state.audioContext = state.audioContext || new AudioContext();
  if (state.audioContext.state !== "running") {
    await state.audioContext.resume();
  }
  ensureOutputGraph();
  return state.audioContext;
}

function ensureOutputGraph() {
  if (!state.audioContext) {
    return;
  }

  if (!state.masterGain) {
    state.masterGain = state.audioContext.createGain();
    state.masterGain.gain.value = Number(elements.masterSlider.value);
    state.masterGain.connect(state.audioContext.destination);
  }

  if (!state.analyser) {
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    state.analyser.smoothingTimeConstant = 0.82;
    state.analyser.connect(state.masterGain);
  }
}

async function initAudio() {
  await ensureAudioContext();
  if (!state.audioContext) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Mic capture is not supported in this browser");
    return;
  }

  try {
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };

    if (state.selectedInputId) {
      constraints.audio.deviceId = { exact: state.selectedInputId };
    }

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    connectMicStream(stream);
    await refreshInputDevices();

    elements.micBtn.textContent = "Mic enabled";
    elements.micBtn.classList.add("ready");
    setStatus("Mic enabled");
  } catch (error) {
    setStatus("Mic permission blocked");
    console.error(error);
  }
}

function connectMicStream(stream) {
  if (state.micSource) {
    state.micSource.disconnect();
  }

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
  }

  state.stream = stream;
  state.monitorGain = state.monitorGain || state.audioContext.createGain();
  state.monitorGain.gain.value = Number(elements.monitorSlider.value);
  state.monitorGain.connect(state.analyser);
  state.micSource = state.audioContext.createMediaStreamSource(stream);
  state.micSource.connect(state.monitorGain);
}

async function refreshInputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const previousValue = state.selectedInputId || elements.inputDeviceSelect.value;

  elements.inputDeviceSelect.replaceChildren(createOption("", "Default input"));
  inputs.forEach((device, index) => {
    elements.inputDeviceSelect.appendChild(createOption(device.deviceId, device.label || `Input ${index + 1}`));
  });

  const hasPrevious = inputs.some((device) => device.deviceId === previousValue);
  elements.inputDeviceSelect.value = hasPrevious ? previousValue : "";
  state.selectedInputId = elements.inputDeviceSelect.value;
}

async function toggleRecording(track) {
  if (track.recording) {
    requestStopRecording(track);
    return;
  }

  await startRecording(track);
}

async function startRecording(track) {
  await initAudio();
  if (!state.audioContext || !state.stream) {
    return;
  }

  if (!window.MediaRecorder) {
    setStatus("MediaRecorder is not supported in this browser");
    return;
  }

  const hadLoop = Boolean(track.buffer);
  track.overdubTake = hadLoop && state.overdub;
  if (hadLoop && !track.overdubTake) {
    stopTrackSource(track);
    track.buffer = null;
    track.elements.card.classList.remove("has-loop");
  }

  const mimeType = getSupportedMimeType();
  track.chunks = [];
  track.discardTake = false;
  track.captureStartAt = state.audioContext.currentTime;
  track.recordStartAt = getQuantizedBoundary(track.captureStartAt);
  track.recordEndAt = 0;
  track.recorder = mimeType
    ? new MediaRecorder(state.stream, { mimeType })
    : new MediaRecorder(state.stream);
  track.recording = true;

  track.elements.recordButton.setAttribute("aria-label", "Stop recording track");
  track.elements.card.classList.add("recording");
  updateTrackRecordingLabel(track);
  setStatus(`${track.overdubTake ? "Overdubbing" : "Recording"} Track ${track.index + 1}`);

  track.recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      track.chunks.push(event.data);
    }
  });

  track.recorder.addEventListener(
    "stop",
    async () => {
      await finishRecording(track, mimeType);
    },
    { once: true },
  );

  track.recorder.start();
}

function requestStopRecording(track) {
  if (!track.recording || track.stopTimer) {
    return;
  }

  const now = state.audioContext.currentTime;
  const gridSize = getActiveGridSize();
  const shouldQuantize = Boolean(state.isPlaying && state.loopLength && gridSize);

  if (!shouldQuantize) {
    track.recordEndAt = now;
    stopRecorder(track);
    return;
  }

  const earliest = Math.max(now, track.recordStartAt + 0.06);
  let stopAt = nextGridTime(earliest, state.sessionStart, gridSize);
  if (stopAt <= track.recordStartAt + 0.06) {
    stopAt += gridSize;
  }

  track.recordEndAt = stopAt;
  track.elements.stateLabel.textContent = "Closing";
  setStatus(`Track ${track.index + 1} closing on grid`);
  track.stopTimer = window.setTimeout(() => stopRecorder(track), Math.max(0, (stopAt - now) * 1000));
}

function stopRecorder(track) {
  window.clearTimeout(track.stopTimer);
  track.stopTimer = 0;

  if (track.recorder && track.recorder.state !== "inactive") {
    track.recorder.stop();
  }
}

async function finishRecording(track, mimeType) {
  track.recording = false;
  track.elements.recordButton.setAttribute("aria-label", "Record track");
  track.elements.card.classList.remove("recording");

  if (track.discardTake) {
    track.chunks = [];
    return;
  }

  const blob = new Blob(track.chunks, { type: mimeType || "audio/webm" });
  track.chunks = [];
  if (!blob.size) {
    track.elements.stateLabel.textContent = track.buffer ? `${formatSeconds(track.buffer.duration)} loop` : "Empty";
    setStatus("No audio captured");
    return;
  }

  try {
    const rawBuffer = await state.audioContext.decodeAudioData(await blob.arrayBuffer());
    const recordEndAt = track.recordEndAt || track.captureStartAt + rawBuffer.duration;
    const startInTake = clamp(track.recordStartAt - track.captureStartAt, 0, rawBuffer.duration);
    const endInTake = clamp(recordEndAt - track.captureStartAt, startInTake + 0.02, rawBuffer.duration);
    const cleanTake = copyAudioBufferSegment(rawBuffer, startInTake, endInTake, state.audioContext);

    if (!state.loopLength) {
      state.loopLength = quantizeLoopDuration(
        cleanTake.duration,
        getBpm(),
        getBeats(),
        elements.quantizeSelect.value,
      );
    }

    const startOffset = state.loopLength && state.isPlaying
      ? positiveModulo(track.recordStartAt - state.sessionStart, state.loopLength)
      : 0;
    const loopTake = fitBufferToLoop(cleanTake, state.loopLength, startOffset, state.audioContext);
    track.buffer = track.overdubTake && track.buffer
      ? mixBuffers(track.buffer, loopTake, state.audioContext)
      : loopTake;

    track.elements.card.classList.add("has-loop");
    track.elements.stateLabel.textContent = `${formatSeconds(track.buffer.duration)} loop`;
    drawBufferWaveform(track);
    updateReadouts();
    await refreshSavedSessions();
    setStatus(`Track ${track.index + 1} ${track.overdubTake ? "overdubbed" : "captured"}`);

    if (state.isPlaying) {
      scheduleTrack(track, 0);
    } else {
      await playSession();
    }
  } catch (error) {
    track.elements.stateLabel.textContent = "Decode failed";
    setStatus("Could not decode recording");
    console.error(error);
  } finally {
    track.overdubTake = false;
    track.recordStartAt = 0;
    track.recordEndAt = 0;
  }
}

async function playSession() {
  if (state.isPlaying) {
    return;
  }

  const tracksWithLoops = state.tracks.filter((track) => track.buffer);
  if (!tracksWithLoops.length) {
    setStatus("Record a track first");
    return;
  }

  await ensureAudioContext();
  if (!state.audioContext) {
    return;
  }

  if (!state.loopLength) {
    state.loopLength = Math.max(...tracksWithLoops.map((track) => track.buffer.duration));
  }

  state.isPlaying = true;
  state.sessionStart = state.audioContext.currentTime + 0.03;
  state.nextTickTime = state.sessionStart;
  tracksWithLoops.forEach((track) => scheduleTrack(track, 0.03));
  elements.playBtn.classList.add("active");
  setStatus("Playing");
}

function stopSession() {
  state.tracks.forEach(stopTrackSource);
  state.isPlaying = false;
  elements.playBtn.classList.remove("active");
  setStatus("Stopped");
  updateReadouts();
}

function scheduleTrack(track, delay = 0) {
  if (!track.buffer || !state.audioContext || !state.analyser) {
    return;
  }

  stopTrackSource(track);
  const source = state.audioContext.createBufferSource();
  const gainNode = state.audioContext.createGain();
  const panNode = "createStereoPanner" in state.audioContext
    ? state.audioContext.createStereoPanner()
    : null;

  source.buffer = track.buffer;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = state.loopLength || track.buffer.duration;
  gainNode.gain.value = track.muted ? 0 : track.volume;

  source.connect(gainNode);
  if (panNode) {
    panNode.pan.value = (track.index - (TRACK_COUNT - 1) / 2) * 0.08;
    gainNode.connect(panNode);
    panNode.connect(state.analyser);
  } else {
    gainNode.connect(state.analyser);
  }

  track.source = source;
  track.gainNode = gainNode;
  const offset = state.loopLength && state.isPlaying
    ? positiveModulo(state.audioContext.currentTime - state.sessionStart, state.loopLength)
    : 0;

  try {
    source.start(state.audioContext.currentTime + delay, offset);
  } catch (error) {
    console.error(error);
  }
}

function stopTrackSource(track) {
  if (!track.source) {
    return;
  }

  try {
    track.source.stop();
  } catch {}
  track.source.disconnect();
  track.source = null;
  track.gainNode = null;
}

function toggleMute(track) {
  track.muted = !track.muted;
  track.elements.card.classList.toggle("muted", track.muted);
  track.elements.muteButton.setAttribute("aria-pressed", String(track.muted));
  applyTrackGain(track);
}

function applyTrackGain(track) {
  if (track.gainNode) {
    track.gainNode.gain.value = track.muted ? 0 : track.volume;
  }
}

function clearTrack(track, silent = false) {
  if (track.recording) {
    track.discardTake = true;
    stopRecorder(track);
  }

  stopTrackSource(track);
  track.buffer = null;
  track.chunks = [];
  track.muted = false;
  track.volume = 1;
  track.elements.volumeSlider.value = "1";
  track.elements.muteButton.setAttribute("aria-pressed", "false");
  track.elements.card.classList.remove("has-loop", "recording", "muted");
  track.elements.stateLabel.textContent = "Empty";
  drawEmptyWaveform(track);

  if (!state.tracks.some((item) => item.buffer)) {
    state.loopLength = 0;
    state.isPlaying = false;
  }

  updateReadouts();
  if (!silent) {
    setStatus(`Track ${track.index + 1} cleared`);
  }
}

function clearSession() {
  state.tracks.forEach((track) => clearTrack(track, true));
  state.loopLength = 0;
  state.isPlaying = false;
  elements.downloadLink.hidden = true;
  updateReadouts();
  setStatus("Session cleared");
}

async function exportLoop() {
  await ensureAudioContext();

  const tracks = state.tracks.filter((track) => track.buffer && !track.muted);
  if (!tracks.length || !state.loopLength) {
    setStatus("Nothing to export");
    return;
  }

  const sampleRate = tracks[0].buffer.sampleRate || state.audioContext.sampleRate;
  const frameCount = Math.ceil(state.loopLength * sampleRate);
  const offline = new OfflineAudioContext(2, frameCount, sampleRate);
  const master = offline.createGain();
  master.gain.value = Number(elements.masterSlider.value);
  master.connect(offline.destination);

  tracks.forEach((track) => {
    const source = offline.createBufferSource();
    const gain = offline.createGain();
    source.buffer = track.buffer;
    source.loop = true;
    source.loopEnd = state.loopLength;
    gain.gain.value = track.volume;
    source.connect(gain);
    gain.connect(master);
    source.start(0);
  });

  setStatus("Rendering WAV");
  const rendered = await offline.startRendering();
  const wav = audioBufferToWav(rendered);
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  if (elements.downloadLink.href.startsWith("blob:")) {
    URL.revokeObjectURL(elements.downloadLink.href);
  }
  elements.downloadLink.href = url;
  elements.downloadLink.hidden = false;
  setStatus("WAV ready");
}

async function saveSession() {
  const loops = state.tracks.filter((track) => track.buffer);
  if (!loops.length) {
    setStatus("Nothing to save");
    return;
  }

  const now = new Date();
  const record = {
    id: crypto.randomUUID(),
    name: `Take ${now.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`,
    createdAt: now.toISOString(),
    bpm: getBpm(),
    beats: getBeats(),
    loopLength: state.loopLength,
    tracks: loops.map((track) => ({
      index: track.index,
      muted: track.muted,
      volume: track.volume,
      buffer: serializeAudioBuffer(track.buffer),
    })),
  };

  await putSession(record);
  await refreshSavedSessions(record.id);
  setStatus("Session saved");
}

async function loadSelectedSession() {
  const id = elements.sessionSelect.value;
  if (!id) {
    setStatus("No saved take selected");
    return;
  }

  const record = await getSession(id);
  if (!record) {
    setStatus("Saved take missing");
    await refreshSavedSessions();
    return;
  }

  await ensureAudioContext();
  stopSession();
  state.tracks.forEach((track) => clearTrack(track, true));
  elements.bpmInput.value = record.bpm;
  elements.beatsInput.value = record.beats;
  state.loopLength = record.loopLength;

  record.tracks.forEach((savedTrack) => {
    const track = state.tracks[savedTrack.index];
    if (!track) {
      return;
    }

    track.buffer = deserializeAudioBuffer(savedTrack.buffer, state.audioContext);
    track.muted = Boolean(savedTrack.muted);
    track.volume = Number(savedTrack.volume) || 1;
    track.elements.volumeSlider.value = String(track.volume);
    track.elements.muteButton.setAttribute("aria-pressed", String(track.muted));
    track.elements.card.classList.add("has-loop");
    track.elements.card.classList.toggle("muted", track.muted);
    track.elements.stateLabel.textContent = `${formatSeconds(track.buffer.duration)} loop`;
    drawBufferWaveform(track);
  });

  updateReadouts();
  setStatus(`${record.name} loaded`);
}

async function deleteSelectedSession() {
  const id = elements.sessionSelect.value;
  if (!id) {
    setStatus("No saved take selected");
    return;
  }

  await deleteSession(id);
  await refreshSavedSessions();
  setStatus("Saved take deleted");
}

async function enableMidi() {
  if (!navigator.requestMIDIAccess) {
    elements.midiStatus.textContent = "MIDI unsupported";
    setStatus("MIDI is not supported in this browser");
    return;
  }

  try {
    state.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    connectMidiInputs();
    state.midiAccess.addEventListener("statechange", connectMidiInputs);
    elements.midiBtn.textContent = "MIDI enabled";
    elements.midiBtn.classList.add("ready");
    setStatus("MIDI enabled");
  } catch (error) {
    elements.midiStatus.textContent = "MIDI blocked";
    setStatus("MIDI permission blocked");
    console.error(error);
  }
}

function connectMidiInputs() {
  if (!state.midiAccess) {
    return;
  }

  const inputs = Array.from(state.midiAccess.inputs.values());
  inputs.forEach((input) => {
    input.onmidimessage = handleMidiMessage;
  });
  elements.midiStatus.textContent = `${inputs.length} MIDI input${inputs.length === 1 ? "" : "s"}`;
}

function handleMidiMessage(event) {
  const message = normalizeMidiMessage(event.data);
  if (!message.active) {
    return;
  }

  if (message.type === "noteon" && message.note >= 36 && message.note < 36 + TRACK_COUNT) {
    toggleRecording(state.tracks[message.note - 36]);
    return;
  }

  if (message.type === "control" && message.controller >= 20 && message.controller < 20 + TRACK_COUNT) {
    toggleRecording(state.tracks[message.controller - 20]);
    return;
  }

  if ((message.type === "noteon" && message.note === 42) || (message.type === "control" && message.controller === 102)) {
    playSession();
  }

  if ((message.type === "noteon" && message.note === 43) || (message.type === "control" && message.controller === 103)) {
    stopSession();
  }
}

function toggleMetronome() {
  state.metronome = !state.metronome;
  elements.metronomeBtn.setAttribute("aria-pressed", String(state.metronome));
  if (state.audioContext) {
    state.nextTickTime = state.audioContext.currentTime + 0.05;
  }
}

function toggleOverdub() {
  state.overdub = !state.overdub;
  elements.overdubBtn.setAttribute("aria-pressed", String(state.overdub));
  setStatus(state.overdub ? "Overdub on" : "Overdub off");
}

function handleKeyboard(event) {
  const target = event.target;
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target?.isContentEditable;
  if (event.repeat || isTyping) {
    return;
  }

  if (event.key >= "1" && event.key <= String(TRACK_COUNT)) {
    event.preventDefault();
    toggleRecording(state.tracks[Number(event.key) - 1]);
    return;
  }

  if (event.code === "Space") {
    event.preventDefault();
    if (state.isPlaying) {
      stopSession();
    } else {
      playSession();
    }
    return;
  }

  if (event.key.toLowerCase() === "m") {
    toggleMetronome();
  }

  if (event.key.toLowerCase() === "o") {
    toggleOverdub();
  }

  if (event.key.toLowerCase() === "q") {
    cycleQuantize();
  }
}

function cycleQuantize() {
  const values = ["bar", "beat", "off"];
  const nextIndex = (values.indexOf(elements.quantizeSelect.value) + 1) % values.length;
  elements.quantizeSelect.value = values[nextIndex];
  setStatus(`Quantize ${values[nextIndex]}`);
}

function drawEmptyWaveform(track) {
  const canvas = track.elements.waveform;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#11130f";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgba(167,170,155,0.24)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(0, canvas.height / 2);
  context.lineTo(canvas.width, canvas.height / 2);
  context.stroke();
}

function drawBufferWaveform(track) {
  const canvas = track.elements.waveform;
  const context = canvas.getContext("2d");
  const data = track.buffer.getChannelData(0);
  const step = Math.ceil(data.length / canvas.width);
  const center = canvas.height / 2;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#11130f";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = track.color;
  context.lineWidth = 2;
  context.beginPath();

  for (let x = 0; x < canvas.width; x += 1) {
    let min = 1;
    let max = -1;
    const start = x * step;
    const end = Math.min(start + step, data.length);

    for (let index = start; index < end; index += 1) {
      const value = data[index];
      min = Math.min(min, value);
      max = Math.max(max, value);
    }

    context.moveTo(x, center + min * center * 0.86);
    context.lineTo(x, center + max * center * 0.86);
  }

  context.stroke();
}

function drawScope() {
  const canvas = elements.scopeCanvas;
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "rgba(17, 19, 15, 0.72)";
  context.fillRect(0, 0, width, height);

  if (state.analyser) {
    const data = new Uint8Array(state.analyser.frequencyBinCount);
    state.analyser.getByteTimeDomainData(data);
    context.strokeStyle = state.isPlaying ? "#83e377" : "#68d8bd";
    context.lineWidth = 4;
    context.beginPath();

    for (let index = 0; index < data.length; index += 1) {
      const x = (index / (data.length - 1)) * width;
      const y = (data[index] / 255) * height;
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }

    context.stroke();
  } else {
    context.strokeStyle = "rgba(104,216,189,0.35)";
    context.lineWidth = 4;
    context.beginPath();
    for (let x = 0; x < width; x += 20) {
      const y = height / 2 + Math.sin(x / 42) * 18;
      if (x === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
  }

  drawBeatGrid(context, width, height);
  state.tracks.filter((track) => track.recording).forEach(updateTrackRecordingLabel);
  scheduleMetronome();
  updateReadouts();
  requestAnimationFrame(drawScope);
}

function drawBeatGrid(context, width, height) {
  const beats = getBeats();
  context.strokeStyle = "rgba(242,240,232,0.08)";
  context.lineWidth = 1;

  for (let index = 1; index < beats; index += 1) {
    const x = (index / beats) * width;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
}

function scheduleMetronome() {
  if (!state.metronome || !state.audioContext || !state.isPlaying) {
    return;
  }

  const interval = 60 / getBpm();
  while (state.nextTickTime < state.audioContext.currentTime + 0.12) {
    playClick(state.nextTickTime);
    state.nextTickTime += interval;
  }
}

function playClick(time) {
  const oscillator = state.audioContext.createOscillator();
  const gain = state.audioContext.createGain();
  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(1000, time);
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.22, time + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055);
  oscillator.connect(gain);
  gain.connect(state.masterGain);
  oscillator.start(time);
  oscillator.stop(time + 0.06);
}

function updateTrackRecordingLabel(track) {
  if (!track.recording || !state.audioContext) {
    return;
  }

  const now = state.audioContext.currentTime;
  if (track.recordEndAt && track.recordEndAt > now) {
    track.elements.stateLabel.textContent = "Closing";
  } else if (track.recordStartAt > now + 0.04) {
    track.elements.stateLabel.textContent = "Armed";
  } else {
    track.elements.stateLabel.textContent = track.overdubTake ? "Overdubbing" : "Recording";
  }
}

function updateReadouts() {
  const activeTracks = state.tracks.filter((track) => track.buffer).length;
  elements.loopReadout.textContent = state.loopLength ? formatSeconds(state.loopLength) : "00.0s";
  elements.trackReadout.textContent = `${activeTracks}/${TRACK_COUNT}`;

  if (state.isPlaying && state.audioContext) {
    const elapsed = Math.max(0, state.audioContext.currentTime - state.sessionStart);
    elements.clockReadout.textContent = formatClock(elapsed);
  } else {
    elements.clockReadout.textContent = "00:00";
  }
}

function normalizeTimingInputs() {
  elements.bpmInput.value = String(getBpm());
  elements.beatsInput.value = String(getBeats());
}

function getBpm() {
  return clamp(Number(elements.bpmInput.value) || 90, 45, 220);
}

function getBeats() {
  return clamp(Number(elements.beatsInput.value) || 4, 1, 16);
}

function getActiveGridSize() {
  return getGridSize(getBpm(), getBeats(), elements.quantizeSelect.value);
}

function getQuantizedBoundary(time) {
  const gridSize = getActiveGridSize();
  if (!state.isPlaying || !state.loopLength || !gridSize) {
    return time;
  }

  return nextGridTime(time, state.sessionStart, gridSize);
}

function getSupportedMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function openDatabase() {
  if (!("indexedDB" in window)) {
    setStatus("Browser storage is unavailable");
    return null;
  }

  if (state.db) {
    return state.db;
  }

  state.db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

  return state.db;
}

async function putSession(record) {
  const db = await openDatabase();
  if (!db) {
    return;
  }

  await idbRequest(db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(record));
}

async function getSession(id) {
  const db = await openDatabase();
  if (!db) {
    return null;
  }

  return idbRequest(db.transaction(DB_STORE).objectStore(DB_STORE).get(id));
}

async function getSessions() {
  const db = await openDatabase();
  if (!db) {
    return [];
  }

  return idbRequest(db.transaction(DB_STORE).objectStore(DB_STORE).getAll());
}

async function deleteSession(id) {
  const db = await openDatabase();
  if (!db) {
    return;
  }

  await idbRequest(db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).delete(id));
}

async function refreshSavedSessions(selectedId = "") {
  try {
    const sessions = await getSessions();
    sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    elements.sessionSelect.replaceChildren(
      sessions.length ? createOption("", "Select saved take") : createOption("", "No saved takes"),
    );
    sessions.forEach((session) => {
      elements.sessionSelect.appendChild(createOption(session.id, session.name));
    });
    elements.sessionSelect.value = selectedId;
  } catch (error) {
    console.error(error);
  }
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function createOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

function setStatus(message) {
  elements.statusText.textContent = message;
}
