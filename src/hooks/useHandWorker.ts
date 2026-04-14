import { useEffect, useRef, useCallback } from 'react';
import type { RefObject } from 'react';
import type { WorkerOutboundMessage } from '../types';
import { useHandStore } from '../store/useHandStore';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Downscale the captured video bitmap before sending it to the worker.
 * MediaPipe's hand landmarker model operates internally at a fixed resolution
 * (~224×224), so sending it a 1920×1080 frame wastes createImageBitmap() time
 * and structured-clone memory without improving detection quality.
 *
 * 640×360 preserves the 16:9 aspect ratio of a landscape webcam and is more
 * than sufficient for robust landmark detection at 1–1.5m range.
 */
const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 360;

// =============================================================================
// HOOK
// =============================================================================

/**
 * useHandWorker
 *
 * Manages the full lifecycle of the hand-tracking Web Worker:
 *  1. Spawns the worker once on mount.
 *  2. Sends INIT with the WASM base path.
 *  3. On READY, starts the frame-capture loop using requestVideoFrameCallback
 *     (rVFC) with a requestAnimationFrame (rAF) fallback.
 *  4. On each frame: createImageBitmap (resized) → transfer to worker → receive
 *     RESULT → write to Zustand store via setState (not a React state setter).
 *  5. On unmount: cancels the loop and terminates the worker cleanly.
 *
 * Anti-pattern avoidance:
 *  - NO useState/useReducer for hand coordinates. All writes go through
 *    useHandStore.setState() which bypasses React's reconciler entirely.
 *    This is safe because R3F's useFrame and gesture detector hooks read
 *    the store via getState() or subscribe(), not via the React hook.
 *  - NO async state: isProcessingRef is a plain mutable ref so that the
 *    backpressure guard never triggers a re-render.
 *
 * @param videoRef - A ref to the <video> element whose frames will be captured.
 *                   The video element must have its stream attached before the
 *                   hook's internal loop will start producing frames.
 */
export function useHandWorker(videoRef: RefObject<HTMLVideoElement>): void {
  // ── Worker ref ──────────────────────────────────────────────────────────────
  const workerRef = useRef<Worker | null>(null);

  // ── Lifecycle flags (plain refs, NOT state — no re-renders) ─────────────────
  /** Set to true after the worker posts { type: 'READY' } */
  const isWorkerReadyRef = useRef(false);

  /**
   * Backpressure guard.
   * True while the worker is processing a frame.  The capture loop skips
   * bitmap creation when this is true so frames never pile up in the
   * MessageChannel queue, preventing cascading latency under CPU load.
   */
  const isProcessingRef = useRef(false);

  /** Stores the last video.currentTime to skip duplicate frames in rAF mode */
  const lastVideoTimeRef = useRef(-1);

  /** rAF handle — needed for cleanup */
  const rafIdRef = useRef<number | null>(null);

  /** rVFC handle — needed for cleanup */
  const rVFCIdRef = useRef<number | null>(null);

  // ── Zustand store write (stable reference, no deps) ─────────────────────────
  /**
   * We call useHandStore.setState() directly rather than going through the
   * hook selector.  This writes to the store without scheduling a React
   * re-render, which is exactly what we want for 30–60 Hz updates.
   * Components that need hand data use useHandStore.subscribe() or read
   * getState() inside useFrame() — neither of those triggers reconciliation.
   */
  const handleResult = useCallback((msg: WorkerOutboundMessage & { type: 'RESULT' }) => {
    useHandStore.setState({
      leftHand: msg.payload.leftHand,
      rightHand: msg.payload.rightHand,
      lastTimestamp: msg.payload.timestamp,
      isTracking: msg.payload.leftHand !== null || msg.payload.rightHand !== null,
    });
  }, []);

  // ── Frame capture & dispatch ─────────────────────────────────────────────────
  /**
   * captureAndSend
   *
   * Called once per video frame (from either rVFC or rAF).
   * Responsibilities:
   *  1. Guard checks (worker ready, not already processing, video has data).
   *  2. createImageBitmap with resize — downscales in a single GPU blit
   *     before handing off to the worker.
   *  3. postMessage with the bitmap as a Transferable so ownership is
   *     transferred to the worker with zero memory copy.
   *
   * Note: createImageBitmap returns a Promise. We use async/await here which
   * means we're NOT blocking the calling frame callback.  The
   * isProcessingRef guard ensures we don't fire a second capture before
   * the worker finishes the previous one.
   */
  const captureAndSend = useCallback(async (timestamp: number): Promise<void> => {
    const video = videoRef.current;

    // Guard: worker not ready or already busy
    if (!video || !isWorkerReadyRef.current || isProcessingRef.current) return;

    // Guard: video element doesn't have enough data yet
    // HAVE_CURRENT_DATA (2) = current frame data is available but no future frame
    if (video.readyState < 2) return;

    // Guard: avoid processing the same frame twice (important for rAF fallback
    // which fires ~60× per second while the camera may only deliver 30 fps)
    if (video.currentTime === lastVideoTimeRef.current) return;
    lastVideoTimeRef.current = video.currentTime;

    // Lock before the await so no second call sneaks in during bitmap creation
    isProcessingRef.current = true;

    try {
      /**
       * createImageBitmap with explicit dimensions resizes and converts the
       * video frame in a single step.  The resize happens on the GPU in
       * Chromium-based browsers, making it essentially free.
       *
       * resizeQuality: 'low' uses the fastest algorithm (nearest-neighbour-ish)
       * which is acceptable because we're feeding it to a neural network, not
       * displaying it.
       */
      const bitmap = await createImageBitmap(video, {
        resizeWidth: CAPTURE_WIDTH,
        resizeHeight: CAPTURE_HEIGHT,
        resizeQuality: 'low',
      });

      /**
       * Transfer the bitmap as a Transferable.
       * The second argument to postMessage is the transfer list.
       * After this call:
       *  - The main thread's `bitmap` reference is neutered (detached)
       *  - The worker owns the backing memory exclusively
       *  - Zero bytes are copied through the structured-clone algorithm
       *
       * The worker is responsible for calling bitmap.close() to release memory.
       */
      workerRef.current?.postMessage(
        { type: 'DETECT', bitmap, timestamp },
        [bitmap],
      );

      // Note: isProcessingRef stays true here — it is reset to false only when
      // the worker posts back { type: 'RESULT' } or { type: 'ERROR' }.
      // This is intentional: we want to hold the lock for the full round-trip.
    } catch (err) {
      // createImageBitmap can throw if the video element is in an invalid state.
      // Release the lock so the loop can recover on the next frame.
      console.warn('[useHandWorker] createImageBitmap failed:', err);
      isProcessingRef.current = false;
    }
  }, [videoRef]);

  // ── Frame loop (rVFC + rAF fallback) ────────────────────────────────────────
  /**
   * requestVideoFrameCallback (rVFC) is preferred over rAF because:
   *  - It fires exactly once per new decoded video frame (no duplicates)
   *  - The `now` parameter is the frame's actual presentation timestamp,
   *    which is more accurate than performance.now() captured in rAF
   *  - It's available in Chrome 83+, Edge 83+, Opera 69+
   *
   * We fall back to rAF for Firefox and Safari, using the currentTime guard
   * in captureAndSend() to deduplicate frames.
   */
  const startCaptureLoop = useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;

    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      // ── rVFC path ───────────────────────────────────────────────────────────
      const onVideoFrame = (now: DOMHighResTimeStamp): void => {
        captureAndSend(now);
        // Re-register for the next frame.  The returned handle is stored so
        // we can cancel it in the cleanup closure.
        rVFCIdRef.current = (video as HTMLVideoElement & {
          requestVideoFrameCallback: (cb: (now: number) => void) => number;
        }).requestVideoFrameCallback(onVideoFrame);
      };

      rVFCIdRef.current = (video as HTMLVideoElement & {
        requestVideoFrameCallback: (cb: (now: number) => void) => number;
      }).requestVideoFrameCallback(onVideoFrame);
    } else {
      // ── rAF fallback path ───────────────────────────────────────────────────
      const onAnimationFrame = (): void => {
        captureAndSend(performance.now());
        rafIdRef.current = requestAnimationFrame(onAnimationFrame);
      };
      rafIdRef.current = requestAnimationFrame(onAnimationFrame);
    }
  }, [videoRef, captureAndSend]);

  // ── Worker message handler ───────────────────────────────────────────────────
  const handleWorkerMessage = useCallback(
    (event: MessageEvent<WorkerOutboundMessage>): void => {
      const msg = event.data;

      switch (msg.type) {
        case 'READY':
          isWorkerReadyRef.current = true;
          // Worker is initialized — start pumping frames immediately
          startCaptureLoop();
          break;

        case 'RESULT':
          // ① Release the backpressure lock so the next frame can be captured
          isProcessingRef.current = false;
          // ② Write to Zustand (no React state update, no re-render)
          handleResult(msg);
          break;

        case 'ERROR':
          // Release lock on error so the pipeline doesn't permanently stall
          isProcessingRef.current = false;
          console.error('[useHandWorker]', msg.message);
          break;

        default:
          break;
      }
    },
    [startCaptureLoop, handleResult],
  );

  // ── Effect: spawn worker, wire up handlers, return cleanup ──────────────────
  useEffect(() => {
    /**
     * new Worker(new URL(...), { type: 'module' })
     *
     * The `new URL(...)` pattern is the webpack 5 / Next.js standard for
     * Worker URL resolution.  Webpack statically analyses this call at build
     * time to bundle the worker into a separate chunk.
     *
     * { type: 'module' } enables ESM imports inside the worker file,
     * which is required for the `import { HandLandmarker } from
     * '@mediapipe/tasks-vision'` statement to work.
     */
    const worker = new Worker(
      new URL('../workers/handTracking.worker.ts', import.meta.url),
      { type: 'module' },
    );

    workerRef.current = worker;
    worker.onmessage = handleWorkerMessage;

    /**
     * worker.onerror fires for uncaught exceptions INSIDE the worker that
     * were NOT caught by the worker's own self.onerror.  Belt-and-suspenders.
     * We release the processing lock so the pipeline can recover.
     */
    worker.onerror = (event: ErrorEvent) => {
      console.error('[useHandWorker] Fatal worker error:', event.message);
      isProcessingRef.current = false;
    };

    /**
     * INIT message kicks off MediaPipe WASM loading inside the worker.
     * We derive the wasmBasePath from window.location.origin so it works
     * across localhost, staging, and production Vercel deployments without
     * hardcoding a URL.
     */
    worker.postMessage({
      type: 'INIT',
      // Use CDN-hosted MediaPipe assets so tracking works without bundling
      // large wasm/model files into /public.
      wasmBasePath: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    });

    // ── Cleanup ────────────────────────────────────────────────────────────────
    return () => {
      // Cancel frame loops first so no more captureAndSend calls can fire
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }

      if (rVFCIdRef.current !== null && videoRef.current) {
        (videoRef.current as HTMLVideoElement & {
          cancelVideoFrameCallback: (handle: number) => void;
        }).cancelVideoFrameCallback(rVFCIdRef.current);
        rVFCIdRef.current = null;
      }

      // Ask the worker to clean up MediaPipe and call self.close()
      worker.postMessage({ type: 'DESTROY' });

      // Hard-terminate as a fallback — safe to call even if the worker
      // already closed itself.
      worker.terminate();

      // Reset local state
      isWorkerReadyRef.current = false;
      isProcessingRef.current = false;
      lastVideoTimeRef.current = -1;
      workerRef.current = null;

      // Clear Zustand store so stale landmarks aren't visible after unmount
      useHandStore.setState({
        leftHand: null,
        rightHand: null,
        lastTimestamp: 0,
        isTracking: false,
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Intentionally empty deps: this effect must run exactly once on mount.
    // handleWorkerMessage and startCaptureLoop are stable (useCallback with
    // ref-only deps), but listing them would risk re-spawning the worker on
    // any render cycle where React recreates the callback reference.
  }, []);
}
