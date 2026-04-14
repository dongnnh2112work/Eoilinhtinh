/**
 * useGestureDetector.ts — Gesture-to-Intent Bridge
 *
 * This hook sits between the raw landmark store (useHandStore) and the
 * application state store (useGalleryStore).  It subscribes to new landmark
 * frames, runs the pure gesture-math functions from lib/gestures.ts, and
 * writes the interpreted intents (isGrabbing, pinchNormalized, swipe
 * navigation, selection confirmation) back to useGalleryStore.
 *
 * ── Hand assignment ────────────────────────────────────────────────────────
 *   Right hand (dominant):  grab detection · rotation control · pinch zoom
 *   Left hand (nav hand):   swipe detection
 *   Fallback:               if only one hand is visible, the visible hand
 *                           drives whichever gesture(s) it can produce.
 *
 * ── Thread and re-render contract ─────────────────────────────────────────
 *   • The subscription fires synchronously inside useHandStore.setState()
 *     — roughly once per decoded video frame (~30 fps).
 *   • ALL mutable frame-rate state lives in useRef (never useState).
 *   • Writes to useGalleryStore are batched via setState — they bypass the
 *     React reconciler and do not trigger component re-renders directly.
 *   • This hook itself renders nothing and never re-renders — it is designed
 *     to be mounted exactly once in AppShell and forgotten.
 *
 * ── Swipe cooldown ─────────────────────────────────────────────────────────
 *   After a swipe fires, a 1 200 ms cooldown prevents repeated navigation
 *   from a hand that lingers in motion.  The wrist history buffer is also
 *   flushed on swipe to prevent the tail of one swipe seeding the next.
 *
 * ── Grab-to-select flow ────────────────────────────────────────────────────
 *   1. isGrabbing becomes true  →  start a hold timer (GRAB_SELECT_HOLD_MS).
 *   2. Sustained grab for the full hold period  →  setIsSelected(true).
 *   3. Any release before the hold period  →  timer is cancelled.
 *   4. On release after selection  →  setIsSelected(false) so the panel closes.
 *   5. The one-shot webhook is handled by a separate useWebhook hook that
 *      watches isSelected — this hook only manages the boolean.
 */

'use client';

import { useEffect, useRef } from 'react';
import { useHandStore }    from '../store/useHandStore';
import { useGalleryStore } from '../store/useGalleryStore';
import { useTutorialStore } from '../store/useTutorialStore';
import {
  grabConfidence,
  calculatePinch,
  detectSwipe,
  type WristSample,
  type RotationTarget,
} from '../lib/gestures';
import type { NormalizedLandmark } from '../types';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * How long (ms) the user must hold a grab before isSelected flips to true.
 * 800 ms is deliberate — prevents accidental selection from passing grabs.
 */
const GRAB_SELECT_HOLD_MS = 800;

/**
 * After a swipe is detected, ignore further swipes for this many milliseconds.
 * Prevents one fast sweep from firing two navigations.
 */
const SWIPE_COOLDOWN_MS = 700;

/**
 * Maximum entries in the wrist history buffer.  At ~30 fps the 350 ms
 * detection window holds ~10 samples; 60 entries gives ample headroom.
 */
const WRIST_HISTORY_MAX = 60;

/**
 * Minimum grabConfidence to write isGrabbing = true.
 * A little higher than the boolean threshold so the binary state stabilises
 * before the glow starts ramping.
 */
const GRAB_CONFIDENCE_THRESHOLD = 0.55;
const ROTATE_DEADZONE = 0.0009;
const ROTATE_MAX_DELTA_PER_FRAME = 0.03;
const ROTATE_SMOOTHING_ALPHA = 0.5;
const ROTATE_X_SENSITIVITY = Math.PI * 2.4;
const ROTATE_Y_SENSITIVITY = Math.PI * 2.4;

// =============================================================================
// HOOK
// =============================================================================

/**
 * useGestureDetector
 *
 * Mount this hook once at the top of the component tree (in AppShell).
 * It has no return value — all outputs are written directly to Zustand stores.
 *
 * @example
 * // In AppShell.tsx:
 * useGestureDetector();
 */
export function useGestureDetector(): void {
  // ── Per-frame mutable refs (never useState — no re-renders) ──────────────
  const leftWristHistoryRef  = useRef<WristSample[]>([]);
  const rightWristHistoryRef = useRef<WristSample[]>([]);
  const swipeCooldownUntil = useRef<number>(0);       // performance.now() cutoff
  const grabStartTime      = useRef<number | null>(null); // when current grab began
  const wasGrabbing        = useRef<boolean>(false);
  const rotationRef        = useRef<RotationTarget>({ rotX: 0, rotY: 0 });
  const accumulatedRotX    = useRef<number>(0);
  const accumulatedRotY    = useRef<number>(0);
  const lastRightPalmX     = useRef<number | null>(null);
  const lastRightPalmY     = useRef<number | null>(null);
  const filteredDxRef      = useRef<number>(0);
  const filteredDyRef      = useRef<number>(0);
  const handSeenSince      = useRef<number | null>(null);
  const grabSeenSince      = useRef<number | null>(null);

  useEffect(() => {
    /**
     * processFrame — called synchronously every time useHandStore is updated
     * (i.e., once per decoded video frame from the worker).
     */
    function processFrame() {
      const { leftHand, rightHand } = useHandStore.getState();
      const gallery = useGalleryStore.getState();
      const tutorial = useTutorialStore.getState();

      const tutorialDone = tutorial.phase === 'COMPLETED';
      const swipeEnabled = tutorial.phase === 'LEARN_SWIPE' || tutorialDone;

      const now = performance.now();

      // ── Tutorial auto-advance: WAITING_FOR_HAND ───────────────────────────
      if (tutorial.phase === 'WAITING_FOR_HAND') {
        if (leftHand || rightHand) {
          if (handSeenSince.current === null) handSeenSince.current = now;
          if (now - handSeenSince.current >= 250) {
            tutorial.onHandDetected();
          }
        } else {
          handSeenSince.current = null;
        }
      }

      // ── 1. Swipe detection (both hands, LEFT direction only) ──────────────
      // Requirement: user swipes either hand to the LEFT to move next.
      const leftIsGrabbing = leftHand
        ? grabConfidence(leftHand) > GRAB_CONFIDENCE_THRESHOLD
        : false;

      const appendPalmX = (
        hand: NormalizedLandmark[] | null,
        targetHistory: { current: WristSample[] },
      ) => {
        if (!hand) {
          targetHistory.current = [];
          return;
        }
        const palmX = (
          hand[0].x +
          hand[5].x +
          hand[9].x +
          hand[13].x +
          hand[17].x
        ) / 5;
        targetHistory.current.push({ x: palmX, timestamp: now });
        if (targetHistory.current.length > WRIST_HISTORY_MAX) {
          targetHistory.current = targetHistory.current.slice(-WRIST_HISTORY_MAX);
        }
      };

      appendPalmX(leftIsGrabbing ? null : leftHand, leftWristHistoryRef);
      appendPalmX(rightHand, rightWristHistoryRef);

      if (swipeEnabled && now > swipeCooldownUntil.current) {
        const leftHandSwipe = detectSwipe(leftWristHistoryRef.current);
        const rightHandSwipe = detectSwipe(rightWristHistoryRef.current);

        if (leftHandSwipe === 'LEFT' || rightHandSwipe === 'LEFT') {
          // Flush both buffers so one gesture cannot chain multiple navigations.
          leftWristHistoryRef.current = [];
          rightWristHistoryRef.current = [];
          swipeCooldownUntil.current = now + SWIPE_COOLDOWN_MS;

          gallery.navigateNext();

          // Tutorial auto-advance: LEARN_SWIPE
          if (tutorial.phase === 'LEARN_SWIPE') {
            tutorial.onSwipeDetected();
          }
        }
      }

      // ── 2. Grab detection (left hand) ────────────────────────────────────
      if (leftHand) {
        const confidence = grabConfidence(leftHand);
        const grabNow    = confidence > GRAB_CONFIDENCE_THRESHOLD;

        // Update the continuous confidence value — Scene3D reads this
        // directly from the store for smooth emissive glow.
        // We re-use pinchNormalized in Scene3D for glow; grabConfidence
        // is stored separately via isGrabbing + a direct confidence write.
        // (grabConfidence is used by Scene3D directly via getState() in useFrame.)

        if (grabNow !== wasGrabbing.current) {
          // Transition: open → grab
          if (grabNow) {
            grabStartTime.current = now;
            useGalleryStore.setState({ isGrabbing: true });
          } else {
            // Transition: grab → open
            grabStartTime.current = null;
            useGalleryStore.setState({
              isGrabbing: false,
              // Close the info panel when the user releases the grab.
              isSelected: false,
            });
          }
          wasGrabbing.current = grabNow;
        }

        // Tutorial auto-advance: LEARN_GRAB (stable fist hold)
        if (tutorial.phase === 'LEARN_GRAB') {
          if (grabNow) {
            if (grabSeenSince.current === null) grabSeenSince.current = now;
            if (now - grabSeenSince.current >= 500) {
              tutorial.onGrabDetected();
            }
          } else {
            grabSeenSince.current = null;
          }
        }

        // Hold-to-select: if the grab has been sustained long enough, confirm selection.
        if (
          grabNow &&
          tutorialDone &&
          grabStartTime.current !== null &&
          !gallery.isSelected &&
          now - grabStartTime.current >= GRAB_SELECT_HOLD_MS
        ) {
          useGalleryStore.setState({ isSelected: true });
        }

      } else {
        // Left hand not visible — clear grab state if it was active.
        if (wasGrabbing.current) {
          grabStartTime.current = null;
          wasGrabbing.current   = false;
          useGalleryStore.setState({
            isGrabbing: false,
            isSelected: false,
          });
        }
        grabSeenSince.current = null;
      }

      // ── 3. Rotation control: hold LEFT fist + move RIGHT hand ────────────
      // Mapping for 2D camera input:
      //   - right hand left/right movement  -> model rotation X
      //   - right hand up/down movement     -> model rotation Y
      if (rightHand && wasGrabbing.current) {
        const palmX = (
          rightHand[0].x +
          rightHand[5].x +
          rightHand[9].x +
          rightHand[13].x +
          rightHand[17].x
        ) / 5;
        const palmY = (
          rightHand[0].y +
          rightHand[5].y +
          rightHand[9].y +
          rightHand[13].y +
          rightHand[17].y
        ) / 5;

        if (Number.isFinite(palmX) && Number.isFinite(palmY)) {
          if (lastRightPalmX.current !== null && lastRightPalmY.current !== null) {
            let dx = palmX - lastRightPalmX.current;
            let dy = palmY - lastRightPalmY.current;

            // Clamp unexpected spikes from noisy frames.
            dx = Math.max(-ROTATE_MAX_DELTA_PER_FRAME, Math.min(ROTATE_MAX_DELTA_PER_FRAME, dx));
            dy = Math.max(-ROTATE_MAX_DELTA_PER_FRAME, Math.min(ROTATE_MAX_DELTA_PER_FRAME, dy));

            // Ignore micro jitters around the resting hand position.
            if (Math.abs(dx) < ROTATE_DEADZONE) dx = 0;
            if (Math.abs(dy) < ROTATE_DEADZONE) dy = 0;

            // First-order low-pass filter for smoother 2-axis control.
            filteredDxRef.current =
              filteredDxRef.current * (1 - ROTATE_SMOOTHING_ALPHA) +
              dx * ROTATE_SMOOTHING_ALPHA;
            filteredDyRef.current =
              filteredDyRef.current * (1 - ROTATE_SMOOTHING_ALPHA) +
              dy * ROTATE_SMOOTHING_ALPHA;

            // X: left-right hand motion
            accumulatedRotX.current += filteredDxRef.current * ROTATE_X_SENSITIVITY;
            // Y: moving hand up should increase Y rotation, so invert dy
            accumulatedRotY.current += -filteredDyRef.current * ROTATE_Y_SENSITIVITY;
          }
          lastRightPalmX.current = palmX;
          lastRightPalmY.current = palmY;
        }

        rotationRef.current = {
          rotX: accumulatedRotX.current,
          rotY: accumulatedRotY.current,
        };
        useGalleryStore.setState({ rotationTarget: rotationRef.current });
      } else {
        // Freeze current angle when combo is not active.
        lastRightPalmX.current = null;
        lastRightPalmY.current = null;
        filteredDxRef.current = 0;
        filteredDyRef.current = 0;
      }

      // ── 4. Pinch zoom (right hand thumb + index) ──────────────────────
      if (rightHand) {
        const pinch = calculatePinch(rightHand);
        useGalleryStore.setState({ pinchNormalized: pinch });
      } else {
        useGalleryStore.setState({ pinchNormalized: 1 });
      }
    }

    // Subscribe to the hand store.  The callback fires synchronously inside
    // useHandStore.setState() — approximately once per decoded video frame.
    // We subscribe to the whole state object because both leftHand and
    // rightHand can change independently.
    const unsub = useHandStore.subscribe(processFrame);

    return () => {
      unsub();
      // Reset all live gesture state when this hook unmounts (e.g., during
      // hot-module reload) so stale values do not persist.
      useGalleryStore.setState({
        isGrabbing:     false,
        isSelected:     false,
        pinchNormalized: 1,
      });
    };
  }, []); // empty deps — subscribe once, clean up on unmount
}
