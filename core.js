export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

export function getBeatLength(bpm) {
  return 60 / clamp(Number(bpm) || 90, 45, 220);
}

export function getGridSize(bpm, beats, mode) {
  if (mode === "off") {
    return 0;
  }

  const beatLength = getBeatLength(bpm);
  return mode === "beat" ? beatLength : beatLength * clamp(Number(beats) || 4, 1, 16);
}

export function nextGridTime(currentTime, sessionStart, gridSize, lookAhead = 0.025) {
  if (!gridSize) {
    return currentTime;
  }

  const elapsed = Math.max(0, currentTime - sessionStart);
  const step = Math.ceil((elapsed + lookAhead) / gridSize);
  return sessionStart + step * gridSize;
}

export function quantizeLoopDuration(duration, bpm, beats, mode) {
  const gridSize = getGridSize(bpm, beats, mode);
  if (!gridSize) {
    return Math.max(duration, 0.5);
  }

  return Math.max(gridSize, Math.round(duration / gridSize) * gridSize);
}

export function normalizeMidiMessage(data) {
  const status = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  const number = data[1] ?? 0;
  const value = data[2] ?? 0;

  if (status === 0x90) {
    return {
      active: value > 0,
      channel,
      type: value > 0 ? "noteon" : "noteoff",
      note: number,
      velocity: value,
    };
  }

  if (status === 0x80) {
    return { active: false, channel, type: "noteoff", note: number, velocity: value };
  }

  if (status === 0xb0) {
    return { active: value > 0, channel, type: "control", controller: number, value };
  }

  return { active: false, channel, type: "unknown" };
}

export function copyAudioBufferSegment(sourceBuffer, startSeconds, endSeconds, context) {
  const sampleRate = sourceBuffer.sampleRate;
  const channelCount = Math.min(sourceBuffer.numberOfChannels, 2);
  const startFrame = clamp(Math.floor(startSeconds * sampleRate), 0, sourceBuffer.length);
  const endFrame = clamp(Math.ceil(endSeconds * sampleRate), startFrame + 1, sourceBuffer.length);
  const frameCount = Math.max(1, endFrame - startFrame);
  const target = context.createBuffer(channelCount, frameCount, sampleRate);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const source = sourceBuffer.getChannelData(channel).subarray(startFrame, endFrame);
    target.copyToChannel(source, channel);
  }

  return target;
}

export function fitBufferToLoop(sourceBuffer, loopLength, startOffset, context) {
  const sampleRate = context.sampleRate;
  const channelCount = Math.min(sourceBuffer.numberOfChannels, 2);
  const frameCount = Math.max(1, Math.ceil(loopLength * sampleRate));
  const target = context.createBuffer(channelCount, frameCount, sampleRate);
  const maxSourceFrames = Math.min(sourceBuffer.length, frameCount);
  const offsetFrames = Math.floor(startOffset * sampleRate) % frameCount;

  for (let channel = 0; channel < channelCount; channel += 1) {
    const source = sourceBuffer.getChannelData(channel);
    const output = target.getChannelData(channel);

    for (let index = 0; index < maxSourceFrames; index += 1) {
      output[(offsetFrames + index) % frameCount] += source[index];
    }
  }

  return target;
}

export function mixBuffers(baseBuffer, layerBuffer, context) {
  const sampleRate = baseBuffer.sampleRate;
  const channelCount = Math.max(baseBuffer.numberOfChannels, layerBuffer.numberOfChannels);
  const frameCount = Math.max(baseBuffer.length, layerBuffer.length);
  const target = context.createBuffer(channelCount, frameCount, sampleRate);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const output = target.getChannelData(channel);
    const base = baseBuffer.getChannelData(Math.min(channel, baseBuffer.numberOfChannels - 1));
    const layer = layerBuffer.getChannelData(Math.min(channel, layerBuffer.numberOfChannels - 1));

    for (let index = 0; index < frameCount; index += 1) {
      output[index] = clamp((base[index] || 0) + (layer[index] || 0), -1, 1);
    }
  }

  return target;
}

export function serializeAudioBuffer(buffer) {
  return {
    duration: buffer.duration,
    length: buffer.length,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
      buffer.getChannelData(channel).slice(0),
    ),
  };
}

export function deserializeAudioBuffer(serialized, context) {
  const channelCount = serialized.numberOfChannels || serialized.channels.length || 1;
  const buffer = context.createBuffer(channelCount, serialized.length, serialized.sampleRate);

  serialized.channels.forEach((channelData, channel) => {
    buffer.copyToChannel(channelData, channel);
  });

  return buffer;
}

export function audioBufferToWav(buffer) {
  const channelCount = buffer.numberOfChannels;
  const length = buffer.length * channelCount * 2;
  const arrayBuffer = new ArrayBuffer(44 + length);
  const view = new DataView(arrayBuffer);
  const channels = [];
  let offset = 0;
  let position = 0;

  writeString(view, position, "RIFF");
  position += 4;
  view.setUint32(position, 36 + length, true);
  position += 4;
  writeString(view, position, "WAVE");
  position += 4;
  writeString(view, position, "fmt ");
  position += 4;
  view.setUint32(position, 16, true);
  position += 4;
  view.setUint16(position, 1, true);
  position += 2;
  view.setUint16(position, channelCount, true);
  position += 2;
  view.setUint32(position, buffer.sampleRate, true);
  position += 4;
  view.setUint32(position, buffer.sampleRate * channelCount * 2, true);
  position += 4;
  view.setUint16(position, channelCount * 2, true);
  position += 2;
  view.setUint16(position, 16, true);
  position += 2;
  writeString(view, position, "data");
  position += 4;
  view.setUint32(position, length, true);
  position += 4;

  for (let channel = 0; channel < channelCount; channel += 1) {
    channels.push(buffer.getChannelData(channel));
  }

  while (position < view.byteLength) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = clamp(channels[channel][offset] || 0, -1, 1);
      view.setInt16(position, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      position += 2;
    }
    offset += 1;
  }

  return arrayBuffer;
}

export function formatSeconds(seconds) {
  return `${seconds.toFixed(1).padStart(4, "0")}s`;
}

export function formatClock(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function writeString(view, offset, string) {
  for (let index = 0; index < string.length; index += 1) {
    view.setUint8(offset + index, string.charCodeAt(index));
  }
}
