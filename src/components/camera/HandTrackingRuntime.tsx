'use client';
/**
 * HandTrackingRuntime.tsx — Camera permission + video feed + hand tracking bootstrap
 *
 * Responsibilities (one concern per component):
 *   1. Request camera permission via getUserMedia
 *   2. Attach the live stream to a hidden <video> element
 *   3. Pass the videoRef to useHandWorker so the worker can pull frames
 *   4. Call useGestureDetector once — it subscribes to useHandStore and
 *      writes all interpreted gesture intents to useGalleryStore
 *   5. Render a diagnostic camera preview (operator-only; not user-facing)
 *
 * What this component does NOT do:
 *   • It does NOT interpret gestures — that is useGestureDetector's job.
 *   • It does NOT drive application state — that is useGalleryStore's job.
 *   • It does NOT render any user-facing UI — that is TutorialOverlay /
 *     MainOverlay's job.
 *
 * Camera permission state is communicated via useTutorialStore:
 *   • We only start the camera once the tutorial leaves REQUESTING_CAMERA.
 *   • If permission is denied, the error is logged; the tutorial overlay
 *     handles showing the user a "camera required" message.
 */

import { useEffect, useRef } from 'react';
import { useHandWorker }      from '../../hooks/useHandWorker';
import { useGestureDetector } from '../../hooks/useGestureDetector';
import { useHandStore }       from '../../store/useHandStore';
import { useTutorialStore }   from '../../store/useTutorialStore';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Ideal capture resolution requested from getUserMedia.
 * The worker will downscale further to 640×360 before sending to MediaPipe,
 * but requesting a larger source gives the browser more pixels to work with
 * for its own downscale algorithm (higher quality than a 640p source).
 */
const IDEAL_WIDTH  = 1280;
const IDEAL_HEIGHT = 720;

// =============================================================================
// COMPONENT
// =============================================================================

export default function HandTrackingRuntime() {
  const videoRef = useRef<HTMLVideoElement>(null);

  // ── Subscribe to stores for the diagnostic overlay ───────────────────────
  // Using the hook form here is fine — this component re-renders at most a
  // few times (tracking on/off transitions), never at frame rate.
  const phase       = useTutorialStore((s) => s.phase);
  const isTracking  = useHandStore((s) => s.isTracking);
  const hasLeftHand = useHandStore((s) => s.leftHand !== null);
  const hasRightHand = useHandStore((s) => s.rightHand !== null);

  // ── Start the worker capture loop (attaches to videoRef) ─────────────────
  useHandWorker(videoRef);

  // ── Subscribe to useHandStore and write gesture intents to gallery store ──
  // This is a zero-arg hook with no return value — it fires once on mount
  // and sets up a Zustand subscription that lives for the component lifetime.
  useGestureDetector();

  // ── Camera permission + stream lifecycle ─────────────────────────────────
  useEffect(() => {
    // The tutorial's REQUESTING_CAMERA phase is handled by TutorialOverlay,
    // which prompts the user to allow camera access.  We only start streaming
    // after that phase transitions (the user has acknowledged the permission
    // request dialog).
    if (phase === 'REQUESTING_CAMERA') return;

    let mounted = true;
    let stream: MediaStream | null = null;

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width:  { ideal: IDEAL_WIDTH  },
            height: { ideal: IDEAL_HEIGHT },
          },
          audio: false,
        });

        if (!mounted || !videoRef.current) return;

        videoRef.current.srcObject = stream;
        // play() returns a Promise; we await it so autoPlay constraints
        // (which vary by browser policy) do not produce unhandled rejections.
        await videoRef.current.play();
      } catch (err) {
        // Log the underlying error for debugging but do not crash.
        // The UI handles the "no camera" state via useTutorialStore.
        console.error('[HandTrackingRuntime] Camera start failed:', err);
      }
    }

    startCamera();

    return () => {
      mounted = false;
      // Stop all tracks so the OS camera indicator light turns off cleanly.
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [phase]); // re-attempt if phase changes (e.g., user re-grants permission)

  // ── Diagnostic overlay (operator-only, not visible to event attendees) ───
  //
  // Positioned top-right so it is in the safe zone and does not overlap the
  // InfoPanel or tutorial content.  The CSS transform mirror on the <video>
  // is purely cosmetic — it makes the preview feel like a selfie camera
  // (natural mirror); the raw stream sent to the worker is not mirrored at
  // the capture stage (mirror correction is applied inside the worker).
  return (
    <div
      aria-hidden="true"
      style={{
        position:     'fixed',
        top:          16,
        right:        16,
        width:        220,
        borderRadius: 12,
        overflow:     'hidden',
        border:       `2px solid ${isTracking ? '#22c55e' : 'rgba(255,255,255,0.22)'}`,
        background:   '#000',
        zIndex:       50,
        boxShadow:    '0 8px 24px rgba(0,0,0,0.55)',
        transition:   'border-color 0.4s',
      }}
    >
      {/* ── Hidden video element — worker reads from this ───────────────── */}
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        style={{
          width:        '100%',
          aspectRatio:  '16 / 9',
          objectFit:    'cover',
          transform:    'scaleX(-1)', // mirror for operator preview only
          display:      'block',
          opacity:      phase === 'REQUESTING_CAMERA' ? 0.30 : 0.85,
          transition:   'opacity 0.4s',
        }}
      />

      {/* ── Status bar ──────────────────────────────────────────────────── */}
      <div
        style={{
          position:   'absolute',
          left:       0,
          right:      0,
          bottom:     0,
          padding:    '5px 9px',
          background: 'linear-gradient(to top, rgba(0,0,0,0.85), transparent)',
          color:      '#fff',
          fontSize:   11,
          fontWeight: 700,
          display:    'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ opacity: 0.7 }}>
          {phase === 'REQUESTING_CAMERA' ? 'awaiting permission' : 'camera live'}
        </span>
        <span style={{ color: isTracking ? '#4ade80' : '#fbbf24' }}>
          {isTracking ? 'tracking' : 'searching'}
        </span>
      </div>

      {/* ── Hand presence indicators ─────────────────────────────────────── */}
      <div
        style={{
          position:   'absolute',
          top:        6,
          left:       8,
          display:    'flex',
          gap:        5,
        }}
      >
        {(['L', 'R'] as const).map((side) => {
          const visible = side === 'L' ? hasLeftHand : hasRightHand;
          return (
            <span
              key={side}
              style={{
                padding:      '2px 6px',
                borderRadius: 999,
                background:   visible ? 'rgba(34,197,94,0.85)' : 'rgba(0,0,0,0.55)',
                color:        '#fff',
                fontSize:     10,
                fontWeight:   800,
                transition:   'background 0.2s',
              }}
            >
              {side}
            </span>
          );
        })}
      </div>
    </div>
  );
}
