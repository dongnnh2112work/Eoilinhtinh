/**
 * gestures.ts — Pure, stateless math functions
 *
 * This module translates raw MediaPipe landmark arrays into gesture intents.
 * Every function is a pure transformation: same input always → same output,
 * no side effects, no store reads or writes.
 *
 * That design means:
 *  • Each function is trivially unit-testable with mock landmark arrays.
 *  • The gesture detector hook (useGestureDetector.ts) owns all state and
 *    calls these functions on every frame.
 *  • Nothing here imports from React or Zustand.
 */

import type { NormalizedLandmark } from '../types';
import { LM } from '../types';

// =============================================================================
// INTERNAL GEOMETRY UTILITIES
// =============================================================================

/** Euclidean distance in full 3-D space (x, y, z). */
function dist3(a: NormalizedLandmark, b: NormalizedLandmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Palm centre — centroid of the wrist + four MCP (knuckle) joints.
 *
 * Using the centroid of the lower knuckle row rather than just the wrist gives
 * a point that sits in the middle of the palm and is stable across all hand
 * orientations.  The wrist alone drifts noticeably when the hand tilts.
 */
function palmCentre(lm: NormalizedLandmark[]): NormalizedLandmark {
  const pts = [
    lm[LM.WRIST],
    lm[LM.INDEX_MCP],
    lm[LM.MIDDLE_MCP],
    lm[LM.RING_MCP],
    lm[LM.PINKY_MCP],
  ];
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    z: pts.reduce((s, p) => s + p.z, 0) / pts.length,
  };
}

/**
 * Hand size reference — distance from wrist to middle-finger MCP.
 *
 * This is the most scale-stable segment on the hand.  Dividing any
 * measured distance by this value makes thresholds resolution-independent:
 * they work whether the user is 0.8 m or 1.5 m from the camera.
 */
function handSize(lm: NormalizedLandmark[]): number {
  return dist3(lm[LM.WRIST], lm[LM.MIDDLE_MCP]);
}

/**
 * Finger curl ratio for a single finger.
 *
 * Returns the distance from TIP → palm centre, normalised by hand size.
 * Typical values (empirically calibrated against MediaPipe hand_landmarker):
 *   • Fully extended:  1.6 – 2.8
 *   • Loosely open:    1.2 – 1.6
 *   • Half curled:     0.8 – 1.2
 *   • Fully curled:    0.3 – 0.8
 *
 * A single unified threshold of ~1.0 cleanly separates open from closed
 * fingers across the full range of hand sizes and camera distances.
 */
function fingerCurlRatio(
  lm: NormalizedLandmark[],
  tipIdx: number,
  centre: NormalizedLandmark,
  size: number,
): number {
  if (size < 1e-4) return 1; // degenerate hand — treat as open
  return dist3(lm[tipIdx], centre) / size;
}

// =============================================================================
// GRAB / FIST DETECTION
// =============================================================================

/**
 * Threshold below which a finger is considered "curled".
 * Tuned so a relaxed open palm never false-triggers, and a natural grab
 * (not a perfect Hollywood fist) reliably triggers.
 */
const GRAB_CURL_THRESHOLD = 1.05;

/** Finger TIP indices checked for the grab gesture (thumb intentionally excluded). */
const FINGER_TIPS = [LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP] as const;

/**
 * isGrabbing
 *
 * Returns true when all four fingers (index, middle, ring, pinky) are curled
 * tight enough to constitute a fist / grab.
 *
 * The thumb is deliberately excluded: users naturally leave their thumb in
 * varying positions and it would produce false negatives on a valid grab.
 *
 * Implementation:
 *   For each finger TIP, compute the normalised distance to the palm centre.
 *   If ALL four are below GRAB_CURL_THRESHOLD → fist confirmed.
 */
export function isGrabbing(landmarks: NormalizedLandmark[]): boolean {
  const size = handSize(landmarks);
  if (size < 1e-4) return false;

  const centre = palmCentre(landmarks);

  return FINGER_TIPS.every(
    (tip) => fingerCurlRatio(landmarks, tip, centre, size) < GRAB_CURL_THRESHOLD,
  );
}

/**
 * grabConfidence
 *
 * Returns a continuous score in [0, 1] representing how tightly the hand is
 * closed.  0 = fully open, 1 = fully fisted.
 *
 * Scene3D uses this (not the boolean) to drive the emissive intensity smoothly
 * so the glow ramps up gradually as the fist forms rather than snapping on.
 *
 * Algorithm:
 *   Average the four finger curl ratios, then invert and normalise so that:
 *     mean ratio ≥ OPEN  → 0.0
 *     mean ratio ≤ CLOSED → 1.0
 */
const GRAB_OPEN_RATIO   = 1.5; // mean ratio considered "fully open"
const GRAB_CLOSED_RATIO = 0.55; // mean ratio considered "fully closed"

export function grabConfidence(landmarks: NormalizedLandmark[]): number {
  const size = handSize(landmarks);
  if (size < 1e-4) return 0;

  const centre = palmCentre(landmarks);

  const meanCurl =
    FINGER_TIPS.reduce((sum, tip) => sum + fingerCurlRatio(landmarks, tip, centre, size), 0) /
    FINGER_TIPS.length;

  // Invert: lower curl ratio = more grabbed = higher confidence
  const t = (GRAB_OPEN_RATIO - meanCurl) / (GRAB_OPEN_RATIO - GRAB_CLOSED_RATIO);
  return Math.max(0, Math.min(1, t));
}

// =============================================================================
// ROTATION MAPPING (Right Hand Open Palm → Model Rotation)
// =============================================================================

/**
 * RotationTarget — the output consumed by Scene3D's useFrame loop.
 * Both values are in radians, ready to be fed directly into damp().
 */
export interface RotationTarget {
  /** Target rotation.x — vertical tilt (nod).  Palm up/down. */
  rotX: number;
  /** Target rotation.y — horizontal pan (turn).  Palm left/right. */
  rotY: number;
}

/**
 * Maximum rotation travel in each axis.
 * ±72° on X prevents the lamp from tipping completely upside-down.
 * ±90° on Y gives a full quarter-turn in each direction.
 */
const MAX_ROT_X = Math.PI * 0.40; // ±72°
const MAX_ROT_Y = Math.PI * 0.50; // ±90°

/**
 * calculateRotation
 *
 * Maps the open-palm centre (right hand) to a 3-D rotation target.
 *
 * Coordinate mapping:
 *   Image space x ∈ [0, 1] (0 = left edge of frame)
 *   Image space y ∈ [0, 1] (0 = top edge of frame)
 *
 * After mirror correction the palm's image-space position maps to:
 *   x → rotation.y   (pan left/right)
 *   y → rotation.x   (tilt up/down)
 *
 * The remapping to [-1, 1] is linear with the screen centre as origin.
 * The ×1.4 scale factor compensates for the fact that users rarely sweep
 * their palm to the very edge of the frame — the effective range is
 * typically [0.15, 0.85], so we stretch it to fill the full ±1 output range.
 */
const COORD_SCALE = 1.4;

export function calculateRotation(landmarks: NormalizedLandmark[]): RotationTarget {
  const centre = palmCentre(landmarks);

  // Normalise from [0, 1] → [-1, 1] with stretch
  const nx = Math.max(-1, Math.min(1, (centre.x - 0.5) * 2 * COORD_SCALE));
  const ny = Math.max(-1, Math.min(1, (centre.y - 0.5) * 2 * COORD_SCALE));

  return {
    rotY:  nx * MAX_ROT_Y, // palm right in image → positive Y rotation
    rotX:  ny * MAX_ROT_X, // palm down in image  → positive X rotation (tip forward)
  };
}

// =============================================================================
// PINCH DISTANCE (Right Hand Thumb + Index → Zoom)
// =============================================================================

/**
 * calculatePinch
 *
 * Returns a normalised distance in [0, 1]:
 *   0 = fully pinched (thumb tip touching index tip) → zoom IN
 *   1 = fully spread  (thumb and index maximally apart) → zoom OUT
 *
 * The raw distance is normalised by hand size to make it camera-distance
 * invariant, then clamped into a calibrated [PINCH_MIN, PINCH_MAX] band
 * before being mapped to [0, 1].
 *
 * Calibrated ranges (normalised units):
 *   PINCH_MIN = 0.15  — fingertips touching or nearly touching
 *   PINCH_MAX = 0.80  — fingers fully spread apart
 */
const PINCH_MIN = 0.15;
const PINCH_MAX = 0.80;

export function calculatePinch(landmarks: NormalizedLandmark[]): number {
  const size = handSize(landmarks);
  if (size < 1e-4) return 1; // assume open (no zoom) on degenerate input

  const raw = dist3(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]) / size;
  return Math.max(0, Math.min(1, (raw - PINCH_MIN) / (PINCH_MAX - PINCH_MIN)));
}

// =============================================================================
// INDEX-POINT DIRECTION DETECTION (Left/Right)
// =============================================================================

export type PointDirection = 'LEFT' | 'RIGHT' | 'NONE';

const POINT_MIN_INDEX_EXTENSION = 0.6;
const POINT_MIN_HORIZONTAL_COMPONENT = 0.18;
const POINT_MAX_VERTICAL_COMPONENT = 0.14;
const POINT_MIN_HORIZONTAL_DOMINANCE = 1.45;
const POINT_MAX_MIDDLE_CURL = 1.2;

/**
 * detectIndexPointDirection
 *
 * Detects a deliberate "index finger points left/right" gesture from a single
 * hand frame. The gesture is accepted when:
 *   1. Index finger is clearly extended,
 *   2. Tip-to-base vector has strong horizontal component,
 *   3. Vertical component is relatively small,
 *   4. Middle finger is not fully extended (helps reject open palm).
 *
 * Every distance-like measurement is normalized by handSize to remain robust
 * for users standing at different distances from the camera.
 */
export function detectIndexPointDirection(landmarks: NormalizedLandmark[]): PointDirection {
  const size = handSize(landmarks);
  if (size < 1e-4) return 'NONE';

  const indexMcp = landmarks[LM.INDEX_MCP];
  const indexTip = landmarks[LM.INDEX_TIP];
  const middleTip = landmarks[LM.MIDDLE_TIP];

  const dxNorm = (indexTip.x - indexMcp.x) / size;
  const dyNorm = (indexTip.y - indexMcp.y) / size;
  const indexExtension = dist3(indexTip, indexMcp) / size;

  if (indexExtension < POINT_MIN_INDEX_EXTENSION) return 'NONE';
  if (Math.abs(dxNorm) < POINT_MIN_HORIZONTAL_COMPONENT) return 'NONE';
  if (Math.abs(dyNorm) > POINT_MAX_VERTICAL_COMPONENT) return 'NONE';
  if (Math.abs(dxNorm) < Math.abs(dyNorm) * POINT_MIN_HORIZONTAL_DOMINANCE) return 'NONE';

  const centre = palmCentre(landmarks);
  const middleCurl = fingerCurlRatio(landmarks, LM.MIDDLE_TIP, centre, size);
  if (middleCurl > POINT_MAX_MIDDLE_CURL) return 'NONE';

  return dxNorm < 0 ? 'LEFT' : 'RIGHT';
}

// =============================================================================
// PALM OPEN CHECK  (guard for rotation — only track if hand is actually open)
// =============================================================================

/**
 * isPalmOpen
 *
 * Returns true when the hand is open enough to use for rotation control.
 * This prevents the rotation from jumping around when the user starts forming
 * a grab gesture — we stop tracking rotation the moment fingers begin curling.
 *
 * Uses the same curl ratio system as isGrabbing but with a looser threshold.
 */
const PALM_OPEN_THRESHOLD = 1.25; // must be > GRAB_CURL_THRESHOLD

export function isPalmOpen(landmarks: NormalizedLandmark[]): boolean {
  const size = handSize(landmarks);
  if (size < 1e-4) return false;

  const centre = palmCentre(landmarks);

  // At least 3 of 4 fingers must be open (allows a slightly curled pinky)
  const openCount = FINGER_TIPS.filter(
    (tip) => fingerCurlRatio(landmarks, tip, centre, size) >= PALM_OPEN_THRESHOLD,
  ).length;

  return openCount >= 3;
}
