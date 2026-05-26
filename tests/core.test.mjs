import assert from "node:assert/strict";
import {
  audioBufferToWav,
  getGridSize,
  nextGridTime,
  normalizeMidiMessage,
  quantizeLoopDuration,
} from "../core.js";

function fakeBuffer({ channels = 2, length = 4, sampleRate = 48000 } = {}) {
  const data = Array.from({ length: channels }, (_, channel) => {
    const samples = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      samples[index] = channel === 0 ? 0.25 : -0.25;
    }
    return samples;
  });

  return {
    duration: length / sampleRate,
    length,
    numberOfChannels: channels,
    sampleRate,
    getChannelData(channel) {
      return data[channel];
    },
  };
}

assert.equal(getGridSize(120, 4, "beat"), 0.5);
assert.equal(getGridSize(120, 4, "bar"), 2);
assert.equal(getGridSize(120, 4, "off"), 0);

assert.equal(nextGridTime(1.01, 0, 0.5), 1.5);
assert.equal(nextGridTime(1.51, 0, 0.5), 2);
assert.equal(quantizeLoopDuration(1.81, 120, 4, "bar"), 2);
assert.equal(quantizeLoopDuration(2.76, 120, 4, "beat"), 3);

assert.deepEqual(normalizeMidiMessage(new Uint8Array([0x90, 36, 100])), {
  active: true,
  channel: 0,
  type: "noteon",
  note: 36,
  velocity: 100,
});
assert.deepEqual(normalizeMidiMessage(new Uint8Array([0xb0, 20, 127])), {
  active: true,
  channel: 0,
  type: "control",
  controller: 20,
  value: 127,
});

const wav = audioBufferToWav(fakeBuffer());
const view = new DataView(wav);
assert.equal(String.fromCharCode(...new Uint8Array(wav.slice(0, 4))), "RIFF");
assert.equal(String.fromCharCode(...new Uint8Array(wav.slice(8, 12))), "WAVE");
assert.equal(view.getUint16(22, true), 2);
assert.equal(view.getUint32(24, true), 48000);

console.log("core tests passed");
