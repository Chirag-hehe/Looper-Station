# Play Store Notes

This app can become an Android app in two realistic ways.

## Fast route: Trusted Web Activity

Host the PWA over HTTPS, then use Bubblewrap or PWABuilder to create an Android project that opens the website fullscreen. This keeps one codebase for web and Android. You must set up Digital Asset Links at `/.well-known/assetlinks.json` so Android can verify that the app and website belong to the same owner.

## Stronger route: Capacitor or native Android

Wrap the web UI with Capacitor and add native plugins for audio/MIDI where browser APIs are not enough. This is more work, but it is the better route for very low latency, device-specific audio routing, Bluetooth MIDI, and reliable stage use.

## Main hurdles

- A Google Play developer account and app setup in Play Console.
- App signing, package name, version codes, app bundle builds, screenshots, descriptions, and store assets.
- Target SDK requirements that change over time.
- A privacy policy and accurate Data safety declarations, because the app uses microphone/audio input and local storage.
- Permission review and user trust around microphone and possible MIDI device access.
- Testing requirements, especially for new personal developer accounts.
- Device testing across Android phones, tablets, USB-C audio interfaces, Bluetooth devices, and browsers.
- Latency: browser audio can work, but serious live looping may need a native low-latency audio engine.
