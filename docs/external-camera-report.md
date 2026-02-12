# External Camera Report

## Current Functionality
- **Live preview** – The `RNUvcCameraView` renders inside the standard `CameraScreen` layout on Android. It keeps a 16:9 letterboxed box centered on screen, showing placeholder copy when no USB camera is connected or preview isn’t ready. Phone camera and UI chrome remain visible so toggling sources never blanks the screen.
- **Recording flow** – External sessions now use the native AUSBC OpenGL pipeline exclusively. When the user taps record, `startExternalSegment()` ensures the USB handle is ready, creates `documentDirectory/uvc/[timestamp]`, and calls `UvcCameraModule.startRecording(handle, { fps:30, durationSec:300 })`. Timers, badges, and record button all mirror the phone camera flow.
- **Segment chaining** – The Kotlin bridge emits `recordingComplete` for every 5‑minute clip. The React listener resets `isRecording`, enqueues the file via `UploadQueueService.addToQueue`, shows a toast, and immediately triggers the next `startExternalSegment()` if the session is still active. Stopping the session (button press, USB disconnect, or native error) calls `stopExternalRecording()` to halt the native recorder cleanly.
- **Fallback UX** – Without a USB camera (emulator or unplugged device), the preview box shows a placeholder with guidance (“Connect USB camera to begin”) and the record button stays disabled. When native preview isn’t supported on the build, the overlay explicitly states that external preview is unavailable.
- **Upload convergence** – Both phone and external flows push MP4 paths into `UploadQueueService`, so queue indicators, retries, and background uploads behave identically regardless of source.

## Validation Checklist
1. **Emulator / no USB camera**
   - External toggle shows placeholder overlay + disabled record button.
   - Status text: “Connect USB camera to begin” (or “External preview unavailable…” if module missing).
2. **Physical device + USB camera**
   - Plugging in camera shows preview after permission prompt.
   - Record button enables once `uvcStatus.connected && externalReady`.
   - Tapping record starts timer; a toast appears every time a segment finishes; upload queue increments.
   - Disconnecting camera mid-session stops recording, disables button, and restores placeholder overlay.
3. **Phone camera**
   - Unaffected: VisionCamera preview/record logic works exactly as before.

## Key Files
- `mobile-app/src/screens/CameraScreen.tsx`
  - External preview integration: lines ~770–940 (letterboxed preview box + overlay).
  - Recording helpers & native event listeners: lines ~410–520.
  - Session branching & UI gating: lines ~489–940.
- Native module: `mobile-app/android/app/src/main/java/com/supervolcano/camera/uvc/*` (unchanged in this pass but still responsible for AUSBC OpenGL encoding, preview surfaces, and emitting `recordingComplete`/`error` events).

## Next Steps
- Exercise the flow on multiple device/USB-camera combos to confirm stability.
- Once satisfied with preview stability, consider exposing external-camera-specific settings (e.g., resolution/fps) via the native module for future tuning.
