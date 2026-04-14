import { create } from 'zustand';

// =============================================================================
// TUTORIAL PHASE TYPE
// =============================================================================
// Linear state machine — each phase has exactly one valid successor.
// The only "skip" path jumps from any phase directly to COMPLETED.
//
//   REQUESTING_CAMERA
//       ↓  (camera permission granted)
//   WAITING_FOR_HAND
//       ↓  (first hand landmark frame received)
//   LEARN_SWIPE
//       ↓  (swipe gesture detected; gallery index changed)
//   LEARN_GRAB
//       ↓  (isGrabbing = true for left hand)
//   LEARN_ROTATE
//       ↓  (right-hand rotation tracked for ROTATE_HOLD_SECONDS)
//   COMPLETED

export type TutorialPhase =
  | 'REQUESTING_CAMERA'
  | 'WAITING_FOR_HAND'
  | 'LEARN_SWIPE'
  | 'LEARN_GRAB'
  | 'LEARN_ROTATE'
  | 'COMPLETED';

// =============================================================================
// ORDERED LIST — used by components for step-indicator rendering
// =============================================================================
export const TUTORIAL_PHASES: TutorialPhase[] = [
  'REQUESTING_CAMERA',
  'WAITING_FOR_HAND',
  'LEARN_SWIPE',
  'LEARN_GRAB',
  'LEARN_ROTATE',
  'COMPLETED',
];

// =============================================================================
// STORE SHAPE
// =============================================================================
export interface TutorialStoreState {
  phase: TutorialPhase;

  /** Unix-ms timestamp when the tutorial was completed (or skipped).
   *  Null until then.  Useful for analytics or re-entry detection. */
  completedAt: number | null;

  /** True while the user is holding the grab during LEARN_GRAB.
   *  Written by TutorialOverlay's timer so the Step component can
   *  display a confirmation progress ring without reading gesture stores. */
  grabHoldProgress: number; // 0–1

  // ── Guarded advance actions ─────────────────────────────────────────────
  // Each action is a no-op unless the store is in exactly the right
  // preceding phase.  This prevents race conditions where two events
  // could both fire before the state has updated.

  /** Called by WebcamFeed / useHandWorker once camera stream is live. */
  onCameraGranted: () => void;

  /** Called by TutorialOverlay's useHandStore subscription when
   *  isTracking first becomes true. */
  onHandDetected: () => void;

  /** Called by TutorialOverlay when a swipe causes the gallery index
   *  to change for the first time. */
  onSwipeDetected: () => void;

  /** Called by TutorialOverlay when left-hand isGrabbing becomes true. */
  onGrabDetected: () => void;

  /** Called by TutorialOverlay after the right-hand rotation timer
   *  reaches its threshold. */
  onRotationComplete: () => void;

  /** Bypasses all remaining phases and jumps directly to COMPLETED.
   *  Triggered by the "Skip Tutorial" button — always available. */
  skip: () => void;

  /** Written by TutorialOverlay's countdown to drive the progress ring. */
  setGrabHoldProgress: (value: number) => void;
}

// =============================================================================
// GUARD HELPER
// =============================================================================
// Returns a setState-compatible updater that only applies the change when
// the store is in the expected phase.  Makes every action self-documenting
// and prevents impossible transitions at runtime.
function guardedAdvance(
  requiredPhase: TutorialPhase,
  nextPhase: TutorialPhase,
) {
  return (state: TutorialStoreState): Partial<TutorialStoreState> => {
    if (state.phase !== requiredPhase) return {}; // no-op
    return {
      phase: nextPhase,
      completedAt: nextPhase === 'COMPLETED' ? Date.now() : state.completedAt,
      grabHoldProgress: 0,
    };
  };
}

// =============================================================================
// STORE
// =============================================================================
export const useTutorialStore = create<TutorialStoreState>()((set) => ({
  phase: 'REQUESTING_CAMERA',
  completedAt: null,
  grabHoldProgress: 0,

  onCameraGranted: () =>
    set(guardedAdvance('REQUESTING_CAMERA', 'WAITING_FOR_HAND')),

  onHandDetected: () =>
    set(guardedAdvance('WAITING_FOR_HAND', 'LEARN_SWIPE')),

  onSwipeDetected: () =>
    set(guardedAdvance('LEARN_SWIPE', 'LEARN_GRAB')),

  onGrabDetected: () =>
    set(guardedAdvance('LEARN_GRAB', 'LEARN_ROTATE')),

  onRotationComplete: () =>
    set(guardedAdvance('LEARN_ROTATE', 'COMPLETED')),

  skip: () =>
    set({ phase: 'COMPLETED', completedAt: Date.now(), grabHoldProgress: 0 }),

  setGrabHoldProgress: (value) => set({ grabHoldProgress: value }),
}));
