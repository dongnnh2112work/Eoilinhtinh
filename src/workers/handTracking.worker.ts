/// <reference lib="webworker" />
// The triple-slash directive tells TypeScript to use the WebWorker lib types
// instead of DOM types, giving us the correct `self` type (DedicatedWorkerGlobalScope)
// and access to ImageBitmap, fetch, etc. without polluting the DOM namespace.

import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  NormalizedLandmark,
  HandTrackingPayload,
} from '../types';

// =============================================================================
// MODULE-LEVEL STATE
// Using module-level variables (not closures) keeps them accessible across
// multiple message handlers without re-instantiating on every frame.
// =============================================================================

let handLandmarker: HandLandmarker | null = null;

/**
 * Guard flag that prevents queuing a second DETECT before the first resolves.
 * Without this, slow frames could pile up and cause cascading latency spikes.
 * The main thread also has its own `isProcessingRef` but a double-guard here
 * is cheap insurance.
 */
let isProcessing = false;

// =============================================================================
// CAMERA-MIRROR LABEL CORRECTION
// =============================================================================
// A webcam at a kiosk acts like a mirror: the user's RIGHT hand physically
// appears on the LEFT side of the captured image.
//
// MediaPipe's HandLandmarker labels hands by which side of the IMAGE they
// appear on — NOT by anatomical side.  Therefore:
//
//   MediaPipe label "Left"  →  User's actual RIGHT hand
//   MediaPipe label "Right" →  User's actual LEFT hand
//
// This flag is true for a front-facing / mirror-mode camera (the typical
// kiosk/webcam setup).  Set to false if your camera feed is NOT mirrored
// (e.g. a rear-facing or flipped stream).
const CAMERA_IS_MIRRORED = false;

function resolveHandedness(mpLabel: string): 'left' | 'right' {
  // mpLabel is "Left" or "Right" as reported by MediaPipe
  if (CAMERA_IS_MIRRORED) {
    // Flip to get the user's anatomical hand
    return mpLabel === 'Left' ? 'right' : 'left';
  }
  return mpLabel === 'Left' ? 'left' : 'right';
}

// =============================================================================
// INIT — called once when main thread posts { type: 'INIT' }
// =============================================================================
async function init(wasmBasePath: string, modelAssetPath: string): Promise<void> {
  try {
    /**
     * FilesetResolver downloads and compiles the MediaPipe WASM binary.
     * We point it at our own /public/mediapipe/ folder (served statically by
     * Next.js / Vercel) rather than the CDN so the app works offline at an
     * event venue and avoids external network dependencies.
     *
     * Required files in /public/mediapipe/:
     *   - vision_wasm_internal.js
     *   - vision_wasm_internal.wasm
     *   - vision_wasm_nosimd_internal.js   (fallback for non-SIMD CPUs)
     *   - vision_wasm_nosimd_internal.wasm
     */
    const vision = await FilesetResolver.forVisionTasks(wasmBasePath);

    /**
     * CPU delegate is used deliberately even though GPU might be faster,
     * because WebGL is NOT available inside Web Workers (only OffscreenCanvas
     * with explicit transfer is, and MediaPipe doesn't use that path).
     * Attempting GPU delegate in a worker silently falls back to CPU anyway,
     * but being explicit avoids noisy console warnings and any future
     * breakage if MediaPipe changes its fallback behaviour.
     *
     * CPU inference off the main thread is still a massive win over running
     * GPU inference on the main thread — it keeps R3F's render loop smooth.
     */
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath,
        delegate: 'CPU',
      },
      runningMode: 'VIDEO',   // VIDEO mode maintains tracking state across frames
      numHands: 2,            // Track both hands simultaneously
      // Confidence thresholds tuned for an event environment where users may
      // have partial occlusion or move quickly past the sensor range:
      minHandDetectionConfidence: 0.65,
      minHandPresenceConfidence: 0.65,
      minTrackingConfidence: 0.5,
    });

    const readyMsg: WorkerOutboundMessage = { type: 'READY' };
    self.postMessage(readyMsg);
  } catch (err) {
    const errorMsg: WorkerOutboundMessage = {
      type: 'ERROR',
      message: `[HandWorker] Init failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    self.postMessage(errorMsg);
  }
}

// =============================================================================
// DETECT — called on every captured video frame
// =============================================================================
function detect(bitmap: ImageBitmap, timestamp: number): void {
  // Double-guard: bail early if not ready or already busy
  if (!handLandmarker || isProcessing) {
    // CRITICAL: always close the transferred bitmap to prevent memory leaks.
    // Once transferred to the worker, only the worker can free it.
    bitmap.close();
    return;
  }

  isProcessing = true;

  try {
    /**
     * detectForVideo() accepts ImageBitmap directly.
     * It returns synchronously (despite the async-looking API surface) — the
     * WASM model inference is synchronous inside the worker thread.
     *
     * The timestamp must be monotonically increasing across calls for the
     * internal Kalman-filter-style tracking to work correctly.  We use the
     * performance.now() value captured on the main thread at bitmap-creation
     * time, which satisfies this constraint.
     */
    const result = handLandmarker.detectForVideo(bitmap, timestamp);

    // Free GPU/CPU memory as soon as we're done reading the pixel data.
    // Not closing this is the #1 cause of memory leaks in long-running
    // hand-tracking sessions.
    bitmap.close();

    // -------------------------------------------------------------------------
    // Build a compact, serialisation-friendly payload
    // We map over result.landmarks to strip any prototype methods and ensure
    // the array is plain JSON-serialisable (structured-clone safe).
    // -------------------------------------------------------------------------
    let leftHand: NormalizedLandmark[] | null = null;
    let rightHand: NormalizedLandmark[] | null = null;

    result.handedness.forEach((handednessArray, handIndex) => {
      // handednessArray[0] is the highest-confidence classification
      const mpLabel = handednessArray[0]?.categoryName ?? 'Left';
      const anatomicalSide = resolveHandedness(mpLabel);

      // Flatten landmarks to plain objects — MediaPipe landmark objects may
      // carry extra prototype baggage that slows structured-clone.
      const landmarks: NormalizedLandmark[] = result.landmarks[handIndex].map((lm) => ({
        x: lm.x,
        y: lm.y,
        z: lm.z,
      }));

      if (anatomicalSide === 'left') {
        leftHand = landmarks;
      } else {
        rightHand = landmarks;
      }
    });

    const payload: HandTrackingPayload = { leftHand, rightHand, timestamp };
    const resultMsg: WorkerOutboundMessage = { type: 'RESULT', payload };

    // No Transferables here: the payload is a small plain object.
    // Structured-clone of ~21 × 3 floats per hand is negligible overhead
    // compared to the inference cost above.
    self.postMessage(resultMsg);
  } catch (err) {
    // Ensure bitmap is always freed even on error
    try { bitmap.close(); } catch (_) { /* already closed */ }

    const errorMsg: WorkerOutboundMessage = {
      type: 'ERROR',
      message: `[HandWorker] Detection error: ${err instanceof Error ? err.message : String(err)}`,
    };
    self.postMessage(errorMsg);
  } finally {
    // Always reset the guard so the next frame can be processed.
    // If this were in the try block, an unhandled throw would deadlock
    // the pipeline.
    isProcessing = false;
  }
}

// =============================================================================
// DESTROY — graceful shutdown
// =============================================================================
function destroy(): void {
  try {
    handLandmarker?.close();
  } catch (_) { /* ignore */ }
  handLandmarker = null;
  // self.close() terminates the worker — safe because the main thread also
  // calls worker.terminate() as a belt-and-suspenders measure.
  self.close();
}

// =============================================================================
// MESSAGE ROUTER
// =============================================================================
self.onmessage = (event: MessageEvent<WorkerInboundMessage>): void => {
  const msg = event.data;

  switch (msg.type) {
    case 'INIT':
      init(msg.wasmBasePath, msg.modelAssetPath);
      break;

    case 'DETECT':
      // msg.bitmap was transferred — it is now owned exclusively by this worker
      detect(msg.bitmap, msg.timestamp);
      break;

    case 'DESTROY':
      destroy();
      break;

    default:
      // Exhaustiveness guard — TypeScript should catch unknown message types
      // at compile time, but a runtime guard is good defensive practice.
      console.warn('[HandWorker] Unknown message type received:', (msg as { type: string }).type);
  }
};

// Propagate uncaught errors back to the main thread instead of silently
// swallowing them.  The main thread's worker.onerror will also fire, but
// posting explicitly lets us include a structured message.
self.onerror = (event: ErrorEvent): void => {
  const errorMsg: WorkerOutboundMessage = {
    type: 'ERROR',
    message: `[HandWorker] Uncaught error: ${event.message} (${event.filename}:${event.lineno})`,
  };
  self.postMessage(errorMsg);
};
