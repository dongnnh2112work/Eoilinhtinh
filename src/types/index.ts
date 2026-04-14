// =============================================================================
// HAND LANDMARK INDICES — MediaPipe 21-point hand skeleton
// Reference: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
// =============================================================================
// These are used by the gesture detector (lib/gestures.ts) to read
// specific joints without "magic number" index lookups.
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

// =============================================================================
// CORE LANDMARK TYPE
// Matches the shape returned by MediaPipe tasks-vision (x/y normalised 0–1,
// z is depth relative to wrist — negative = closer to camera).
// We intentionally keep this flat to avoid GC pressure when posting 30–60
// copies per second through the MessageChannel.
// =============================================================================
export interface NormalizedLandmark {
  x: number; // 0 = left edge of image, 1 = right edge
  y: number; // 0 = top edge, 1 = bottom edge
  z: number; // relative depth (wrist = 0)
}

// =============================================================================
// WORKER ↔ MAIN THREAD MESSAGE PROTOCOL
// Discriminated unions let TypeScript narrow inside each switch/case branch.
//
// Optimization note: ImageBitmap is the only large payload and is always sent
// as a Transferable (ownership transfer, zero memory copy).  All other
// payloads are small plain-JS objects that serialize cheaply through the
// structured-clone algorithm.
// =============================================================================

/** Messages sent FROM the main thread TO the worker */
export type WorkerInboundMessage =
  | {
      type: 'INIT';
      /**
       * Full origin + path where the MediaPipe WASM bundle is served.
       * Example: "https://localhost:3000/mediapipe"
       * Must be absolute because the worker's own base-URL may differ from
       * the page URL, and fetch() inside the worker resolves relative paths
       * against the worker script URL, not the page URL.
       */
      wasmBasePath: string;
      /**
       * Full URL to the hand landmarker .task model.
       * Example:
       * "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
       */
      modelAssetPath: string;
    }
  | {
      type: 'DETECT';
      /**
       * A snapshot of the <video> frame captured on the main thread via
       * createImageBitmap().  It is transferred (not copied) to the worker,
       * so the main thread loses its reference.  The worker MUST call
       * bitmap.close() after detection to free GPU/CPU memory.
       */
      bitmap: ImageBitmap;
      /**
       * performance.now() value from the main thread at capture time.
       * MediaPipe's detectForVideo() requires monotonically increasing
       * timestamps in milliseconds.
       */
      timestamp: number;
    }
  | { type: 'DESTROY' };

/** Messages sent FROM the worker TO the main thread */
export type WorkerOutboundMessage =
  | { type: 'READY' }
  | { type: 'ERROR'; message: string }
  | {
      type: 'RESULT';
      payload: HandTrackingPayload;
    };

// =============================================================================
// HAND TRACKING PAYLOAD
// The canonical shape written to Zustand by useHandWorker and read by
// the gesture detector.  Null means that hand is not in frame.
// =============================================================================
export interface HandTrackingPayload {
  /** User's actual left hand landmarks (after camera-mirror correction) */
  leftHand: NormalizedLandmark[] | null;
  /** User's actual right hand landmarks (after camera-mirror correction) */
  rightHand: NormalizedLandmark[] | null;
  /** Millisecond timestamp of this detection frame (from performance.now()) */
  timestamp: number;
}

// =============================================================================
// LAMP DATA TYPE  (used by lib/lampData.ts and the gallery store)
// =============================================================================
export interface Lamp {
  id: string;           // e.g. "lamp-01" — used as the webhook lampId
  name: string;         // Display name: "Aurora Pendant"
  tagline: string;      // Short descriptor: "Parametric Voronoi Shade"
  description: string;  // 2–3 sentence body copy
  modelPath: string;    // Path to .glb in /public/models/
  accentColor: string;  // Hex — used for the glow / InfoBox border
  material: string;     // e.g. "PLA+ Silk Gold"
  printTime: string;    // e.g. "14h 22m"
}

// =============================================================================
// TUTORIAL STATE MACHINE LEVELS
// =============================================================================
export type TutorialLevel = 0 | 1 | 2 | 3 | 4;
// 0 = Awaiting camera permission & first hand detection
// 1 = Awaiting first successful Swipe
// 2 = Awaiting Left-Hand Grab
// 3 = Awaiting Right-Hand Rotate + Pinch Zoom
// 4 = Tutorial complete — full gallery unlocked

// =============================================================================
// GESTURE EVENT TYPES  (emitted by lib/gestures.ts, consumed by stores/hooks)
// =============================================================================
export type GestureType = 'SWIPE_LEFT' | 'SWIPE_RIGHT' | 'GRAB' | 'RELEASE' | 'PINCH' | 'PALM';

export interface GestureEvent {
  gesture: GestureType;
  hand: 'left' | 'right';
  /** Pinch distance 0–1; only meaningful when gesture === 'PINCH' */
  pinchDistance?: number;
  /** Palm center 0–1 in normalised image space; only for 'PALM' */
  palmX?: number;
  palmY?: number;
  timestamp: number;
}
