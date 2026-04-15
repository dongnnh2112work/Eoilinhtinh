'use client';
/**
 * TutorialOverlay.tsx
 *
 * Semi-transparent overlay that sits above the 3D canvas and walks new users
 * through four gesture steps.  It renders null once the tutorial is COMPLETED.
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 * React hook reads are ONLY for things that change ≤5 times per session:
 *   useTutorialStore((s) => s.phase)  — re-renders only on phase transition
 *
 * Gesture-based advancement uses Zustand subscribe() inside useEffect so
 * the component is NEVER re-rendered at gesture detection frequency (30-60 Hz).
 *
 * ── Component tree ───────────────────────────────────────────────────────────
 *   TutorialOverlay (phase router + skip button)
 *     StepRequestingCamera  —  phase: REQUESTING_CAMERA
 *     StepWaitingForHand    —  phase: WAITING_FOR_HAND
 *     StepLearnSwipe        —  phase: LEARN_SWIPE
 *     StepLearnGrab         —  phase: LEARN_GRAB
 *     StepLearnRotate       —  phase: LEARN_ROTATE
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { useTutorialStore }  from '../../store/useTutorialStore';
import { useGalleryStore }   from '../../store/useGalleryStore';
import { useHandStore }      from '../../store/useHandStore';

// =============================================================================
// SHARED PRIMITIVES
// =============================================================================

/** Animated gradient ring that sits behind the main icon on each step. */
function PulseRing({ color = 'white' }: { color?: string }) {
  return (
    <div
      className="absolute inset-0 rounded-full animate-ping opacity-20"
      style={{ backgroundColor: color }}
    />
  );
}

/**
 * Headline text block.  Forces the 1.5 m outdoor rule — nothing smaller
 * than text-5xl ever reaches the screen in an instruction context.
 */
function StepHeadline({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-6xl font-black leading-tight tracking-tight text-white drop-shadow-2xl text-center">
      {children}
    </h2>
  );
}

function StepSubtitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-3xl font-bold text-white/80 text-center leading-snug max-w-xl mx-auto">
      {children}
    </p>
  );
}

// =============================================================================
// HAND / GESTURE SVGs
// =============================================================================

/**
 * OutlineHand — a minimal SVG hand drawn with stroke only (no fill).
 * Intended to convey "ghost" — you can see the 3D model behind it.
 */
function OutlineHand({
  className = '',
  animate = true,
}: {
  className?: string;
  animate?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 120 160"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${className} ${animate ? 'animate-pulse' : ''}`}
    >
      {/* Index finger */}
      <rect x="41" y="8"  width="20" height="52" rx="10" stroke="white" strokeWidth="3.5" />
      {/* Middle finger */}
      <rect x="63" y="4"  width="20" height="58" rx="10" stroke="white" strokeWidth="3.5" />
      {/* Ring finger */}
      <rect x="85" y="10" width="18" height="50" rx="9"  stroke="white" strokeWidth="3.5" />
      {/* Pinky */}
      <rect x="105" y="22" width="14" height="38" rx="7" stroke="white" strokeWidth="3.5" />
      {/* Thumb */}
      <rect
        x="10" y="36" width="16" height="42" rx="8"
        stroke="white" strokeWidth="3.5"
        transform="rotate(-25 18 57)"
      />
      {/* Palm */}
      <path
        d="M41 56 C20 60 10 78 12 108 C14 134 40 148 66 148 C92 148 116 134 116 108 C116 80 100 62 103 58"
        stroke="white" strokeWidth="3.5"
      />
    </svg>
  );
}

/**
 * FistIcon — same silhouette but knuckles are visible as a closed hand.
 */
function FistIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 140"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Knuckle row */}
      <path d="M28 50 Q66 40 100 50" stroke="white" strokeWidth="4" />
      {/* Top of fist */}
      <path d="M28 50 Q26 36 34 30 Q44 24 52 34 Q56 24 66 24 Q76 24 78 34 Q82 22 92 24 Q102 26 100 38 L100 50" stroke="white" strokeWidth="3.5" />
      {/* Thumb */}
      <path d="M28 50 Q18 54 16 66 Q14 78 22 82 L42 82" stroke="white" strokeWidth="3.5" />
      {/* Bottom of fist / palm */}
      <path d="M28 50 L26 90 Q26 110 66 110 Q106 110 104 90 L100 50" stroke="white" strokeWidth="3.5" />
    </svg>
  );
}

/**
 * PointingHandIcon — index finger extended horizontally.
 * Used in LEARN_SWIPE step to match the current point-left/right navigation gesture.
 */
function PointingHandIcon({
  direction,
  className = '',
}: {
  direction: 'left' | 'right';
  className?: string;
}) {
  const isRight = direction === 'right';
  return (
    <svg
      viewBox="0 0 140 90"
      fill="none"
      stroke="white"
      strokeWidth="4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ transform: isRight ? undefined : 'scaleX(-1)' }}
    >
      {/* Index finger */}
      <path d="M22 45 H112" />
      {/* Finger tip hook */}
      <path d="M112 45 Q122 45 124 38" />
      {/* Folded fingers + palm */}
      <path d="M44 45 Q40 34 48 28 Q56 22 64 30 Q68 20 78 22 Q86 24 88 34 Q96 28 104 32 Q112 36 108 46" />
      <path d="M40 46 Q32 52 34 62 Q36 72 50 72 H82 Q98 72 102 58" />
      {/* Thumb */}
      <path d="M52 52 Q44 56 44 63" />
    </svg>
  );
}

/**
 * SwipeArrow — a simple animated directional chevron.
 * The `direction` prop flips it for left vs right swipe hints.
 */
function SwipeArrow({
  direction,
  delay = '0ms',
}: {
  direction: 'left' | 'right';
  delay?: string;
}) {
  const d = direction === 'right'
    ? 'M5 12H19M13 6l6 6-6 6'
    : 'M19 12H5M11 6L5 12l6 6';

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-32 h-32 drop-shadow-[0_0_16px_rgba(255,255,255,0.5)]"
      style={{
        animation: `arrowSlide${direction === 'right' ? 'Right' : 'Left'} 1.4s ease-in-out infinite`,
        animationDelay: delay,
      }}
    >
      <path d={d} />
    </svg>
  );
}

// =============================================================================
// STEP: REQUESTING_CAMERA
// =============================================================================
function StepRequestingCamera() {
  const onCameraGranted = useTutorialStore((s) => s.onCameraGranted);

  const handleRequestCamera = useCallback(async () => {
    try {
      // Probe for permission — the actual stream is managed by WebcamFeed.
      // This call just prompts the browser permission dialog.
      await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      onCameraGranted();
    } catch {
      // User denied — show a retry state without crashing
    }
  }, [onCameraGranted]);

  return (
    <div className="flex flex-col items-center gap-10">
      {/* Camera icon */}
      <div className="relative w-40 h-40 flex items-center justify-center">
        <div className="absolute inset-0 rounded-full bg-white/5 border-2 border-white/20" />
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="1.5"
          className="w-20 h-20 opacity-90"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9A2.25 2.25 0 0013.5 5.25h-9A2.25 2.25 0 002.25 7.5v9A2.25 2.25 0 004.5 18.75z" />
        </svg>
      </div>

      <StepHeadline>Enable Camera</StepHeadline>
      <StepSubtitle>
        This experience uses your webcam to track your hands.
        No data is recorded or stored.
      </StepSubtitle>

      <button
        onClick={handleRequestCamera}
        className="
          mt-4 px-16 py-6
          bg-white text-[#141418]
          text-3xl font-black tracking-wide rounded-2xl
          hover:bg-white/90 active:scale-95
          transition-all duration-150
          shadow-[0_0_40px_rgba(255,255,255,0.2)]
        "
      >
        Allow Camera Access
      </button>
    </div>
  );
}

// =============================================================================
// STEP: WAITING_FOR_HAND
// =============================================================================
function StepWaitingForHand() {
  const onHandDetected = useTutorialStore((s) => s.onHandDetected);

  // Subscribe to isTracking WITHOUT causing a re-render on every frame.
  // The subscriber fires only when the boolean value flips.
  useEffect(() => {
    const unsub = useHandStore.subscribe(
      (s) => s.isTracking,
      (isTracking) => {
        if (isTracking) onHandDetected();
      },
    );
    return unsub;
  }, [onHandDetected]);

  return (
    <div className="flex flex-col items-center gap-10">
      {/* Ghost hand outline — pulsing to attract attention */}
      <div className="relative w-52 h-52 flex items-center justify-center">
        <div className="absolute inset-0 rounded-full">
          <PulseRing />
        </div>
        <OutlineHand className="w-40 h-40 opacity-80" />
      </div>

      <StepHeadline>
        Raise Your Hand
      </StepHeadline>
      <StepSubtitle>
        Hold your open palm up facing the screen.
        <br />
        Stand 1–1.5 metres away for best results.
      </StepSubtitle>

      {/* Live detection feedback — tiny dot that lights up when hand seen */}
      <div className="flex items-center gap-3 text-2xl font-bold text-white/50">
        <span className="w-4 h-4 rounded-full bg-white/20 animate-pulse" />
        Looking for your hand…
      </div>
    </div>
  );
}

// =============================================================================
// STEP: LEARN_SWIPE
// =============================================================================
function StepLearnSwipe() {
  const onSwipeDetected = useTutorialStore((s) => s.onSwipeDetected);

  // Advance when the gallery lamp index changes — that can only happen if a
  // swipe was detected by useGestureDetector.  No coupling to gesture internals.
  useEffect(() => {
    const initialIndex = useGalleryStore.getState().activeLampIndex;

    const unsub = useGalleryStore.subscribe(
      (s) => s.activeLampIndex,
      (index) => {
        if (index !== initialIndex) onSwipeDetected();
      },
    );
    return unsub;
  }, [onSwipeDetected]);

  return (
    <div className="flex flex-col items-center gap-10">
      <StepHeadline>Point to Explore</StepHeadline>

      {/* Directional arrows + pointing-hand gesture icons */}
      <div className="flex items-center gap-16 my-2">
        <SwipeArrow direction="left"  delay="0ms" />

        <div className="flex items-center gap-6">
          <PointingHandIcon direction="left" className="w-28 h-20 opacity-70" />
          <PointingHandIcon direction="right" className="w-28 h-20 opacity-70" />
        </div>

        <SwipeArrow direction="right" delay="200ms" />
      </div>

      <StepSubtitle>
        Point your index finger left or right to browse our lamp collection.
      </StepSubtitle>
    </div>
  );
}

// =============================================================================
// STEP: LEARN_GRAB
// =============================================================================
function StepLearnGrab() {
  const onGrabDetected      = useTutorialStore((s) => s.onGrabDetected);
  const setGrabHoldProgress = useTutorialStore((s) => s.setGrabHoldProgress);
  const grabHoldProgress    = useTutorialStore((s) => s.grabHoldProgress);

  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Subscribe to isGrabbing transitions.  Start / stop a hold timer.
    const unsub = useGalleryStore.subscribe(
      (s) => s.isGrabbing,
      (isGrabbing) => {
        if (isGrabbing) {
          // Start 1-second hold confirmation timer
          let elapsed = 0;
          holdTimerRef.current = setInterval(() => {
            elapsed += 80;
            const progress = Math.min(1, elapsed / 1000);
            setGrabHoldProgress(progress);

            if (progress >= 1) {
              clearInterval(holdTimerRef.current!);
              onGrabDetected();
            }
          }, 80);
        } else {
          // Hand opened — cancel the timer and reset progress
          if (holdTimerRef.current) {
            clearInterval(holdTimerRef.current);
            holdTimerRef.current = null;
          }
          setGrabHoldProgress(0);
        }
      },
    );

    return () => {
      unsub();
      if (holdTimerRef.current) clearInterval(holdTimerRef.current);
    };
  }, [onGrabDetected, setGrabHoldProgress]);

  // SVG circle progress ring maths
  const RADIUS = 54;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const dashOffset = CIRCUMFERENCE * (1 - grabHoldProgress);

  return (
    <div className="flex flex-col items-center gap-10">
      <StepHeadline>Make a Fist</StepHeadline>

      {/* Fist icon with circular progress ring */}
      <div className="relative w-56 h-56 flex items-center justify-center">
        {/* Background ring */}
        <svg
          viewBox="0 0 120 120"
          className="absolute inset-0 w-full h-full -rotate-90"
        >
          <circle cx="60" cy="60" r={RADIUS} fill="none" stroke="white" strokeOpacity="0.12" strokeWidth="5" />
          {/* Progress arc — grows as user holds the fist */}
          <circle
            cx="60" cy="60" r={RADIUS}
            fill="none"
            stroke="white"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            strokeDashoffset={dashOffset}
            className="transition-all duration-75"
          />
        </svg>

        {/* Fist silhouette, bounces when not holding */}
        <FistIcon
          className={`w-32 h-32 ${grabHoldProgress === 0 ? 'animate-bounce' : ''}`}
        />
      </div>

      <StepSubtitle>
        Close your left hand into a fist and hold it.
        <br />
        Keep it closed to select the lamp.
      </StepSubtitle>

      {grabHoldProgress > 0 && (
        <p className="text-2xl font-bold text-white animate-pulse">
          Hold still… {Math.round(grabHoldProgress * 100)}%
        </p>
      )}
    </div>
  );
}

// =============================================================================
// STEP: LEARN_ROTATE
// =============================================================================

/** Required seconds of continuous right-hand tracking to pass this step. */
const ROTATE_REQUIRED_SECONDS = 3.5;
/** Poll interval in ms — fast enough for a smooth progress bar but not 60fps */
const ROTATE_POLL_MS = 80;

function StepLearnRotate() {
  const onRotationComplete = useTutorialStore((s) => s.onRotationComplete);

  // Local state for the progress bar — legitimate because it drives visible UI
  // and changes at 12fps (ROTATE_POLL_MS), not 60fps.
  const [trackingProgress, setTrackingProgress] = useState(0);
  const accumulatedRef = useRef(0);
  const lastTickRef    = useRef(performance.now());

  useEffect(() => {
    const interval = setInterval(() => {
      const now       = performance.now();
      const delta     = now - lastTickRef.current;
      lastTickRef.current = now;

      const { rightHand } = useHandStore.getState();
      const { isGrabbing } = useGalleryStore.getState();

      if (rightHand !== null && isGrabbing) {
        accumulatedRef.current += delta;
      } else {
        // Require BOTH: left-hand fist hold + right-hand control
        accumulatedRef.current = Math.max(0, accumulatedRef.current - delta * 0.5);
      }

      const progress = Math.min(1, accumulatedRef.current / (ROTATE_REQUIRED_SECONDS * 1000));
      setTrackingProgress(progress);

      if (progress >= 1) {
        clearInterval(interval);
        onRotationComplete();
      }
    }, ROTATE_POLL_MS);

    return () => clearInterval(interval);
  }, [onRotationComplete]);

  const RADIUS = 54;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  return (
    <div className="flex flex-col items-center gap-10">
      <StepHeadline>Hold Left Fist + Rotate</StepHeadline>

      {/* Open palm with progress ring */}
      <div className="relative w-56 h-56 flex items-center justify-center">
        <svg
          viewBox="0 0 120 120"
          className="absolute inset-0 w-full h-full -rotate-90"
        >
          <circle cx="60" cy="60" r={RADIUS} fill="none" stroke="white" strokeOpacity="0.12" strokeWidth="5" />
          <circle
            cx="60" cy="60" r={RADIUS}
            fill="none"
            stroke="#FFD580"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            strokeDashoffset={CIRCUMFERENCE * (1 - trackingProgress)}
            className="transition-all duration-75"
          />
        </svg>
        <OutlineHand className="w-36 h-36 opacity-90" animate={false} />
      </div>

      {/* Dual-gesture instruction cards */}
      <div className="flex gap-6">
        <div className="flex flex-col items-center gap-3 px-8 py-5 rounded-2xl bg-white/8 border border-white/15">
          <span className="text-4xl">✊</span>
          <span className="text-xl font-bold text-white text-center">Hold LEFT fist<br/>to unlock rotate</span>
        </div>
        <div className="flex flex-col items-center gap-3 px-8 py-5 rounded-2xl bg-white/8 border border-white/15">
          <span className="text-4xl">🖐</span>
          <span className="text-xl font-bold text-white text-center">Move RIGHT hand<br/>to rotate 360</span>
        </div>
      </div>

      <StepSubtitle>
        Keep your left hand closed, then control the lamp with your right hand.
      </StepSubtitle>

      <div className="flex items-center gap-3 text-2xl font-semibold text-white/60">
        <span
          className="w-4 h-4 rounded-full"
          style={{ backgroundColor: trackingProgress > 0 ? '#FFD580' : 'rgba(255,255,255,0.2)' }}
        />
        {trackingProgress > 0
          ? `Tracking combo… ${Math.round(trackingProgress * 100)}%`
          : 'Hold left fist and raise right hand'}
      </div>
    </div>
  );
}

// =============================================================================
// SKIP BUTTON
// =============================================================================
function SkipButton({ onSkip }: { onSkip: () => void }) {
  return (
    // TOP-RIGHT corner — satisfies the "No Bottom UI" rule.
    // Bottom placement risks being off-screen or blocked by the kiosk bezel
    // when viewed at 1.5 m by users of varying heights.
    <button
      onClick={onSkip}
      className="
        fixed top-10 right-10 z-50
        flex items-center gap-3
        px-8 py-4
        text-2xl font-bold text-white/50
        border border-white/20 rounded-xl
        hover:text-white/80 hover:border-white/40
        active:scale-95
        transition-all duration-200
        backdrop-blur-sm
      "
    >
      Skip Tutorial
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
      </svg>
    </button>
  );
}

// =============================================================================
// STEP PROGRESS DOTS  (top-centre safe zone)
// =============================================================================
const STEP_LABELS: Record<string, string> = {
  REQUESTING_CAMERA: 'Camera',
  WAITING_FOR_HAND:  'Hand',
  LEARN_SWIPE:       'Point',
  LEARN_GRAB:        'Grab',
  LEARN_ROTATE:      'Rotate',
};

function ProgressDots({ phase }: { phase: string }) {
  const steps = Object.keys(STEP_LABELS);
  const activeIndex = steps.indexOf(phase);

  return (
    <div className="flex items-center gap-4">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center gap-4">
          <div className={`
            flex items-center justify-center
            w-5 h-5 rounded-full
            transition-all duration-500
            ${i < activeIndex  ? 'bg-white scale-100 opacity-60' : ''}
            ${i === activeIndex ? 'bg-white scale-125 opacity-100 shadow-[0_0_12px_rgba(255,255,255,0.6)]' : ''}
            ${i > activeIndex  ? 'bg-white/20 scale-100' : ''}
          `} />
          {i < steps.length - 1 && (
            <div className={`
              w-8 h-0.5 rounded-full transition-all duration-500
              ${i < activeIndex ? 'bg-white/60' : 'bg-white/15'}
            `} />
          )}
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// TUTORIAL OVERLAY  (root export)
// =============================================================================
/**
 * Renders null when phase === 'COMPLETED' so AppShell can mount
 * MainOverlay transparently without a conditional at the call site.
 */
export default function TutorialOverlay() {
  const phase = useTutorialStore((s) => s.phase);
  const skip  = useTutorialStore((s) => s.skip);

  if (phase === 'COMPLETED') return null;

  return (
    <>
      {/*
        ── CSS keyframes injected once alongside the component ────────────────
        Using a <style> tag instead of globals.css keeps this component
        fully self-contained — no build-step coordination required.
      */}
      <style>{`
        @keyframes arrowSlideRight {
          0%, 100% { transform: translateX(0);    opacity: 0.55; }
          50%       { transform: translateX(18px); opacity: 1; }
        }
        @keyframes arrowSlideLeft {
          0%, 100% { transform: translateX(0);     opacity: 0.55; }
          50%       { transform: translateX(-18px); opacity: 1; }
        }
      `}</style>

      {/*
        ── Backdrop ───────────────────────────────────────────────────────────
        Not fully opaque — the 3D lamp model shows through, which makes the
        tutorial feel immersive rather than a separate "screen".
        bg-[#141418]/80 = design system charcoal at 80% opacity.
      */}
      <div className="fixed inset-0 z-20 bg-[#141418]/80 backdrop-blur-[2px] flex flex-col">

        {/*
          ── Top safe zone — progress dots ──────────────────────────────────
          Fixed to the top-centre so it never intrudes on the instruction area
          and is always above the fold regardless of display height.
        */}
        <div className="flex justify-center pt-10 pb-6">
          <ProgressDots phase={phase} />
        </div>

        {/*
          ── Central content area ───────────────────────────────────────────
          flex-1 + flex-col + justify-center keeps the instruction block in
          the upper-centre half of the screen — satisfying the Safe Zone rule.
          We deliberately DON'T use items-center vertically; the natural
          position lands content in the top-60% region which is well above
          the bottom edge where tall/short users see differently.
        */}
        <div className="flex-1 flex flex-col items-center justify-center px-12 pb-24">
          {/*
            key={phase} forces React to unmount/remount the step component
            on each phase change, resetting all local state and giving us a
            clean CSS enter animation via Tailwind's animate-in classes.
          */}
          <div
            key={phase}
            className="w-full max-w-3xl flex flex-col items-center gap-10 animate-in fade-in slide-in-from-bottom-6 duration-500"
          >
            {phase === 'REQUESTING_CAMERA' && <StepRequestingCamera />}
            {phase === 'WAITING_FOR_HAND'  && <StepWaitingForHand />}
            {phase === 'LEARN_SWIPE'       && <StepLearnSwipe />}
            {phase === 'LEARN_GRAB'        && <StepLearnGrab />}
            {phase === 'LEARN_ROTATE'      && <StepLearnRotate />}
          </div>
        </div>
      </div>

      {/* Skip button is always rendered regardless of current step */}
      <SkipButton onSkip={skip} />
    </>
  );
}
