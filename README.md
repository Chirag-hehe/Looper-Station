# Looper Station

A static browser looper for recording microphone layers, playing them back as a loop, overdubbing, mixing levels, muting tracks, using a metronome, saving sessions locally, connecting MIDI controllers, and exporting the current loop as a WAV file.

The home page is now a dedicated website with the live studio first, plus hardware, Android, support, and privacy pages.

## Run locally

```powershell
node server.mjs
```

Then open `http://localhost:4173`.

Microphone access requires a secure context. `localhost` works in modern browsers; opening `index.html` directly from the filesystem usually does not.

## Controls

- Track record buttons record or overdub that track.
- Quantize can snap takes to the next bar or beat while the loop is playing.
- Overdub mixes a new take into an existing track instead of replacing it.
- Saved takes are stored in the browser with IndexedDB.
- Keyboard: number keys 1-6 arm tracks, Space toggles play/stop, M toggles the metronome, O toggles overdub, and Q cycles quantize.
- MIDI: notes 36-41 or CC 20-25 control tracks 1-6. Note 42 or CC 102 starts playback. Note 43 or CC 103 stops playback.

## Hardware

The web version can use audio inputs that the browser exposes as microphones, including many USB audio interfaces. For footswitches and controllers, use a USB/Bluetooth MIDI device in a browser that supports Web MIDI. For the lowest latency on stage, a native Android audio layer will eventually be better than browser audio.

## Android path

This project is already shaped as a Progressive Web App with `manifest.webmanifest` and `service-worker.js`. The fastest Play Store route is to publish the web app over HTTPS and package it with a Trusted Web Activity. A fuller native route would wrap this UI and audio engine with Capacitor, then build the Android project in Android Studio.

## Next features

- Undo/redo for track takes.
- Cloud sharing.
- Low-latency native Android audio backend.
