# PROJECT CONTEXT — Eoilinhtinh Interactive 3D Landing Page
**Version:** MVP 1.0 — Architecture frozen as of April 2026
**Architect:** Factory Interactive
**Status:** Running end-to-end locally. Gesture pipeline, tutorial auto-advance, 3MF catalogue (5 models), and hydration guards are implemented.

---

## 1. Project Overview

A full-screen, touchless interactive product display for a 3D-printed lamp brand. Deployed on a **24-inch landscape monitor at an outdoor/covered event**. Users stand **1.0–1.5 m from the screen** and interact exclusively via **hand gestures tracked by webcam** — no mouse, no keyboard, no touch.

The system tracks hand landmarks in real time, classifies gestures (swipe, grab, rotate, pinch), animates a 3D lamp model in response, and fires a one-shot webhook payload to external hardware when a lamp is selected.

---

## 2. Tech Stack

| Layer | Library / Service | Version |
|---|---|---|
| Framework | Next.js (App Router) | ^15.3.0 |
| Deployment | Vercel | — |
| AI / Vision | `@mediapipe/tasks-vision` Hand Landmarker | ^0.10.14 |
| 3D Renderer | `@react-three/fiber` + `three` | ^9.6.0 / ^0.171.0 |
| 3D Helpers | `@react-three/drei` | ^10.7.7 |
| 3D Loaders | `three-stdlib` (ThreeMFLoader) | ^2.35.0 |
| Post-Processing | `@react-three/postprocessing` + `postprocessing` | ^3.0.4 / ^6.39.0 |
| State Management | `zustand` | ^5.0.3 |
| Cloud Storage | `@vercel/blob` | ^0.27.1 |
| Styling | TailwindCSS v4 + `@tailwindcss/postcss` | ^4.1.4 |
| Language | TypeScript | ^5.7.3 |

**WASM + model assets** for MediaPipe are loaded from CDN URLs in `useHandWorker.ts` (`jsDelivr` + Google Storage) and passed to the worker via `INIT`.

---

## 3. Repository Structure

```
src/
├── app/
│   ├── actions/
│   │   └── uploadModel.ts        # Server Action — Vercel Blob upload (server-only)
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
│
├── components/
│   ├── AdminUpload.tsx            # Operator CMS panel — file drop, loading states
│   ├── AppShellClient.tsx          # Client-only shell, dynamic scene/camera mount
│   ├── camera/
│   │   └── HandTrackingRuntime.tsx # Camera preview + tracking status + useHandWorker
│   ├── canvas/
│   │   └── Scene3D.tsx            # R3F Canvas — ThreeMFLoader, lighting, Bloom
│   └── ui/
│       ├── MainOverlay.tsx        # Post-tutorial UI — InfoPanel, LampCounter
│       └── TutorialOverlay.tsx    # Onboarding wizard — 5 guided steps
│
├── hooks/
│   ├── useGestureDetector.ts      # Frame-by-frame gesture interpretation + intent writes
│   └── useHandWorker.ts           # Worker lifecycle, rVFC capture loop, Zustand writes
│
├── lib/
│   └── gestures.ts                # PURE FUNCTIONS — all gesture math, zero side effects
│
├── store/
│   ├── useHandStore.ts            # Raw landmarks + isTracking (written by worker hook)
│   ├── useGalleryStore.ts         # Lamp catalogue, selection state, activeModelUrl
│   └── useTutorialStore.ts        # Tutorial phase state machine
│
├── types/
│   └── index.ts                   # Shared types: NormalizedLandmark, LM indices, Lamp, etc.
│
└── workers/
    └── handTracking.worker.ts     # Web Worker — ALL MediaPipe inference lives here
```

---

## 4. The Data Pipeline ("The Engine")

This is the most performance-critical part of the system. Understand it completely before modifying anything in this chain.

### 4.1 Thread Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  MAIN THREAD                                                             │
│                                                                          │
│  <video> element                                                         │
│      │                                                                   │
│  requestVideoFrameCallback (rVFC)  ←── fires once per decoded video frame│
│      │                                                                   │
│  createImageBitmap(video, { resizeWidth: 640, resizeHeight: 360 })      │
│      │  (GPU blit — zero CPU copy)                                       │
│      │                                                                   │
│  worker.postMessage({ type:'DETECT', bitmap, timestamp }, [bitmap])     │
│      │                              ↑ Transferable — ownership transferred│
│      │                              zero bytes copied through MessageChannel│
│      ↓                                                                   │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  WEB WORKER  (handTracking.worker.ts)                            │   │
│  │                                                                  │   │
│  │  HandLandmarker.detectForVideo(bitmap, timestamp)                │   │
│  │      CPU delegate only — WebGL not available inside workers      │   │
│  │                                                                  │   │
│  │  bitmap.close()  ← MUST happen here to free GPU/CPU memory      │   │
│  │                                                                  │   │
│  │  Resolve handedness labels (flip for CAMERA_IS_MIRRORED = true) │   │
│  │  Flatten landmarks to plain { x, y, z } objects                 │   │
│  │                                                                  │   │
│  │  postMessage({ type:'RESULT', payload: { leftHand, rightHand }})│   │
│  └──────────────────────────────────────────────────────────────────┘   │
│      │                                                                   │
│  useHandStore.setState({ leftHand, rightHand, isTracking })             │
│      ← BYPASSES React reconciler entirely (not useState)                │
│                                                                          │
│  R3F useFrame ──→ useHandStore.getState() ──→ gesture math              │
│  (60fps, no re-render)                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Frame Capture — rVFC + rAF Fallback

```typescript
// useHandWorker.ts — frame loop selection
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  // Preferred: fires exactly once per decoded video frame (Chrome 83+, Edge 83+)
  video.requestVideoFrameCallback(onVideoFrame);
} else {
  // Fallback: rAF at 60fps; currentTime guard deduplicates frames
  requestAnimationFrame(onAnimationFrame);
}
```

**rVFC is preferred** because it fires once per *decoded* frame, never on duplicate frames. The rAF fallback uses `video.currentTime === lastVideoTimeRef.current` to skip duplicates.

### 4.3 Backpressure Guard

`isProcessingRef` is a plain `useRef<boolean>` — **not state**. It is set to `true` before `createImageBitmap` and reset to `false` only when the worker posts `RESULT` or `ERROR`. This ensures the pipeline has exactly one frame in flight at all times, preventing queue pile-up under CPU load.

### 4.4 The Zero Re-render Contract

This is the single most important rule in the codebase:

| Operation | Pattern used | Why |
|---|---|---|
| Write hand coordinates from worker result | `useHandStore.setState(...)` | Zustand raw set — no React scheduler |
| Read coordinates in R3F render loop | `useHandStore.getState()` inside `useFrame` | Synchronous read, zero React scheduling |
| React to infrequent gesture events (tutorial) | `useHandStore.subscribe(selector, callback)` in `useEffect` | Fires only on value change, not every frame |
| Drive CSS transitions from gesture state | `useGalleryStore((s) => s.isGrabbing)` hook | Legitimate — `isGrabbing` changes ≤4×/interaction, not at frame rate |

**Never** call `useHandStore()` or `useGalleryStore()` inside a component that renders inside the R3F Canvas or at frame rate. Always use `getState()` inside `useFrame`.

### 4.5 Worker Message Protocol

Defined in `src/types/index.ts` as discriminated unions:

```typescript
// Main → Worker
type WorkerInboundMessage =
  | { type: 'INIT'; wasmBasePath: string }
  | { type: 'DETECT'; bitmap: ImageBitmap; timestamp: number }  // bitmap is Transferable
  | { type: 'DESTROY' }

// Worker → Main
type WorkerOutboundMessage =
  | { type: 'READY' }
  | { type: 'ERROR'; message: string }
  | { type: 'RESULT'; payload: HandTrackingPayload }
```

### 4.6 Handedness / Camera Mapping

`CAMERA_IS_MIRRORED = false` in `handTracking.worker.ts`.

The project currently runs with non-mirrored anatomical mapping (`false`) because the preview feed is calibrated to left/right as seen by the user in this setup.

```
MediaPipe "Left"  →  user's anatomical right hand
MediaPipe "Right" →  user's anatomical left hand
```

---

## 5. Gesture Recognition System

All gesture math lives in `src/lib/gestures.ts` as **pure, stateless functions**. This file has zero imports from React or Zustand. Every function is independently unit-testable with mock landmark arrays.

### 5.1 Coordinate System

MediaPipe landmarks use normalised image space:
- `x`: 0 = left edge, 1 = right edge
- `y`: 0 = top edge, 1 = bottom edge
- `z`: depth relative to wrist (negative = closer to camera)

The `LM` constant object in `src/types/index.ts` maps all 21 joint indices by name (e.g. `LM.INDEX_TIP = 8`) to eliminate magic numbers.

### 5.2 Distance-Invariant Grab Detection

The fundamental challenge: a user at 1 m produces larger landmarks than a user at 1.5 m. Fixed pixel thresholds fail. Solution:

```
handSize = dist3(WRIST, MIDDLE_MCP)   ← most scale-stable segment
palmCentre = centroid of {WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP}

fingerCurlRatio(TIP) = dist3(TIP, palmCentre) / handSize

isGrabbing = ALL four finger TIPs have fingerCurlRatio < GRAB_CURL_THRESHOLD (1.05)
```

The centroid of the knuckle row is used instead of the wrist alone because the wrist drifts significantly when the hand tilts — the centroid stays centred in the palm across all orientations.

**Thumb is excluded from the grab check** — users naturally keep the thumb in varying positions and it would produce false negatives on valid grabs.

### 5.3 Grab Confidence (Continuous Score)

`grabConfidence(landmarks): number` returns 0–1 (not boolean). Used by `Scene3D`'s `useFrame` to drive emissive intensity gradually as the fist forms, rather than snapping the glow on instantly.

```
GRAB_OPEN_RATIO   = 1.5   (mean curl ratio when fully open)
GRAB_CLOSED_RATIO = 0.55  (mean curl ratio when fully closed)
confidence = clamp( (OPEN - meanCurl) / (OPEN - CLOSED), 0, 1 )
```

### 5.4 Navigation Gesture (Index Point Left/Right)

```typescript
detectIndexPointDirection(landmarks): 'LEFT' | 'RIGHT' | 'NONE'
```

- Runtime behavior in `useGestureDetector.ts`:
  - Detect pointing direction from either hand (left is preferred unless grabbing).
  - Require **3 stable consecutive frames** before firing navigation.
  - Apply **700 ms cooldown** after each navigation.
  - Direction mapping:
    - `LEFT` point → `navigateNext()`
    - `RIGHT` point → `navigatePrev()`

Point validation uses normalized geometry checks (index extension, horizontal dominance, vertical rejection, middle-finger curl guard) so it remains stable across 1.0–1.5m distance and avoids accidental open-palm triggers.

Tutorial copy and iconography for this phase are aligned with the new interaction: **"Point to Explore"** with left/right index-point icons (no open-palm swipe icon).

### 5.5 Rotation Mapping (Current UX)

Rotation is now driven by **2D palm deltas** (camera plane), not absolute open-palm mapping:

- Condition to rotate: **left hand grab is active** AND right hand is tracked.
- `deltaX` (right hand moving left/right) integrates into `rotationTarget.rotX`.
- `deltaY` (right hand moving up/down) integrates into `rotationTarget.rotY` (inverted so moving hand up rotates positive Y).
- Deadzone + clamp + smoothing are applied per frame to reduce jitter.
- If lamp details are open (`isSelected`) and the user performs a **right-hand fist**, rotation is reset to origin (`rotX = 0`, `rotY = 0`) to quickly recover from extreme 360° turns.

### 5.6 Pinch Zoom

```
pinchNorm = clamp( (dist3(THUMB_TIP, INDEX_TIP)/handSize - 0.15) / (0.80 - 0.15), 0, 1 )
```

0 = fully pinched → zoom in (MIN_FOV = 22°)
1 = fully spread → zoom out (MAX_FOV = 52°)

---

## 6. 3D Rendering System

### 6.1 Critical Canvas Setting

```tsx
<Canvas flat ...>
```

`flat={true}` disables Three.js's ACESFilmic tone mapping. **This is not optional.** Without it, emissive values above 1.0 are clamped before the Bloom pass sees them, producing no visible glow halo. With `flat`, emissive intensity of 4.0 passes through to the `EffectComposer` unclamped.

### 6.2 3MF Loading Pipeline

3MF is the active model format for this project. The catalogue currently uses:
`/public/models/lamp-aurora.3mf`, `/public/models/lamp-helix.3mf`, `/public/models/lamp-strata.3mf`, `/public/models/main_rc1.3mf` (Cloud Glow / "Đèn đám mây"), `/public/models/lampshade.3mf` (Waves Designer Lamp).

```
ThreeMFLoader.load(url, onLoad, onProgress, onError)
  → Object3D scene graph (possibly multiple meshes)
  → traverse meshes → preserve source 3MF material/color when present
  → fallback: inject MeshStandardMaterial only if mesh has no valid material
  → Box3 normalization to TARGET_WORLD_SIZE(3.2)
  → recenter model to world origin
  → if parse/load fails: render procedural fallback mesh (keeps app interactive)
```

**Why bounding sphere, not box?**
The sphere gives a uniform scale factor accounting for the longest dimension across all three axes simultaneously. A long thin lamp and a compact round lamp both end up fitting the same viewport footprint.

### 6.3 Material Preservation + Fallback Injection

`LampModelMesh` now keeps material/color embedded in the source 3MF whenever available.
Fallback material is applied only when a mesh arrives without a valid material:

```tsx
new THREE.MeshStandardMaterial({
  color: '#9a9aae',
  roughness: 0.42,
  metalness: 0.55,
})
```

### 6.4 Grab Behavior

The previous emissive grab glow was removed to match the latest interaction requirement.
Left-hand grab now functions as a control-state trigger (select/open + enable rotation combo), not a visual glow effect.

### 6.5 All Damping Constants

| Constant | Value | Purpose |
|---|---|---|
| `ROTATION_LAMBDA` | 5 | Rotation tracking speed (absorbs MediaPipe jitter) |
| `RETURN_LAMBDA` | 2 | Drift back to origin when no hand present |
| `FOV_LAMBDA` | 4 | Camera FOV zoom via pinch |
| `OFFSET_LAMBDA` | 4 | Model X-offset when InfoPanel opens |

`THREE.MathUtils.damp(current, target, lambda, delta)` is used throughout — never raw `lerp` with a fixed coefficient, because `lerp` is frame-rate dependent and will feel different at 30fps vs 60fps. `damp` with delta time is frame-rate independent.

### 6.6 Post-Processing

```
EffectComposer (multisampling: 4)
  └── Bloom
        luminanceThreshold: 0.18   ← only emissive >1 triggers glow
        luminanceSmoothing: 0.85
        intensity: 1.8
        kernelSize: LARGE          ← wide soft halo, reads as "lamp emitting light"
        blendFunction: ADD
        mipmapBlur: true
  └── Vignette
        offset: 0.3, darkness: 0.6
        blendFunction: NORMAL      ← focuses viewer on centre-stage model
```

### 6.7 Key-Based Suspense Remount

```tsx
<Suspense key={activeModelUrl} fallback={<LoadingFallback />}>
  <LampSTLMesh url={activeModelUrl} ... />
</Suspense>
```

When `activeModelUrl` changes (navigation point-nav or admin upload), `key` forces React to **unmount and remount** the Suspense boundary. This ensures the old geometry is disposed, `LoadingFallback` reappears during the new fetch, and the loader's internal cache is keyed per URL.

---

## 7. UI/UX Design System — The 1.5m Outdoor Rule

### 7.1 Typography Scale (Non-Negotiable)

| Element | Tailwind class | Rendered size | Weight |
|---|---|---|---|
| Lamp name | `text-7xl font-black` | 72 px | 900 |
| Section headings | `text-6xl font-black` | 60 px | 900 |
| Tagline / subtitle | `text-3xl font-bold` | 30 px | 700 |
| Body / description | `text-2xl font-semibold` | 24 px | 600 |
| Metadata labels | `text-xl font-bold uppercase tracking-[0.2em]` | 20 px | 700 |
| Status indicators | `text-2xl font-bold` | 24 px | 700 |

**Nothing smaller than `text-xl` (20 px) ever appears in the primary viewing area.**

### 7.2 Colour System

| Token | Value | Usage |
|---|---|---|
| Background | `#141418` | Canvas clear colour, page background |
| Surface | `#1A1A24` | Info panels, cards |
| Primary text | `#FFFFFF` | All headings and body copy |
| Warm accent text | `#FFD580` | Tutorial progress, warm confirmation states |
| Per-lamp accent | `lamp.accentColor` | Glow, borders, tagline colour |

**Never use pure black (`#000000`) as a background** — it reads as a dead screen on outdoor displays. The slight purple-tinted charcoal (`#141418`) reads as intentional even in bright ambient light.

### 7.3 Safe Zone Rules

The screen is viewed by users of varying heights (children to adults) from 1–1.5 m. **Critical UI must never be placed near the bottom edge.** Enforced positioning:

- `LampCounter`: `fixed top-10 left-1/2 -translate-x-1/2`
- `GestureHints`: `fixed top-10 left-10`
- Skip button: `fixed top-10 right-10`
- Info panel: `fixed right-0 top-1/2 -translate-y-1/2` (vertically centred)
- Tutorial content: `justify-center` with `pb-24` offset — lands in top 60% of screen

### 7.4 Info Panel Layout

When `isGrabbing || isSelected`, the info panel slides in from the **right edge** of the screen. The 3D model simultaneously offsets **left** by `SELECTED_OFFSET_X = -1.05` world units (damped, handled in `Scene3D`'s `LampGroup.useFrame`). The two motions are coordinated purely through shared Zustand state — no prop drilling.

---

## 8. Tutorial State Machine

### 8.1 Phase Diagram

```
REQUESTING_CAMERA
      │  camera permission granted (getUserMedia resolves)
WAITING_FOR_HAND
      │  useHandStore.isTracking flips true
LEARN_SWIPE
      │  useGalleryStore.activeLampIndex changes (swipe executed)
LEARN_GRAB
      │  useGalleryStore.isGrabbing true for 1 continuous second
LEARN_ROTATE
      │  useHandStore.rightHand tracked for 3.5 continuous seconds
COMPLETED
      │  (all features unlocked)
```

`skip()` → jumps from ANY phase directly to `COMPLETED`.

### 8.2 guardedAdvance Pattern

```typescript
function guardedAdvance(requiredPhase: TutorialPhase, nextPhase: TutorialPhase) {
  return (state: TutorialStoreState): Partial<TutorialStoreState> => {
    if (state.phase !== requiredPhase) return {}; // no-op
    return { phase: nextPhase, ... };
  };
}
```

Each action is a no-op unless the store is in exactly the right preceding state. If two gesture events fire simultaneously (e.g., a fast swipe detected twice in a single tick), only the first `set()` call succeeds — the second hits a dead guard and returns `{}`. The machine **cannot** skip steps or reach an invalid state.

### 8.3 Advancement Mechanics (Zero Re-renders)

All gesture-based tutorial advancement uses `store.subscribe()` inside `useEffect` — **never** the React hook form of the store. The subscriber fires only on discrete value changes (e.g., `isGrabbing` flipping from `false` to `true`), not on every frame.

```typescript
// StepLearnGrab.tsx — correct pattern
useEffect(() => {
  const unsub = useGalleryStore.subscribe(
    (s) => s.isGrabbing,        // selector
    (isGrabbing) => {           // fires only on boolean flip
      if (isGrabbing) startHoldTimer();
      else cancelHoldTimer();
    },
  );
  return unsub;
}, []);
```

---

## 9. CMS / Upload System

### 9.1 Server Action Security Chain

`src/app/actions/uploadModel.ts` implements a **five-layer validation** before calling `put()`:

1. **Type check** — `file instanceof File` guard
2. **Extension check** — currently `.stl` suffix (legacy admin path)
3. **Size guard** — hard cap at 50 MB
4. **Magic-byte sniff** — reads first 8 bytes and rejects known foreign types (JPEG, PNG, GIF, PDF, ZIP) by their binary signatures. STL has no fixed magic bytes, so the approach is "deny known-bad"
5. **Filename sanitisation** — strips non-alphanumeric characters, caps at 64 chars, prepends `Date.now()` timestamp

**Return type:** `{ ok: true; url: string; filename: string; bytes: number } | { ok: false; error: string }` — discriminated union for exhaustive handling without try/catch at the call site.

### 9.2 Hot-Swap Flow

```
AdminUpload.tsx (client)
  → uploadModel(formData)  [Server Action]
  → blob.url returned
  → useGalleryStore.setActiveModelUrl(url)
  → Scene3D re-renders (low-frequency — one React render)
  → <Suspense key={url}> remounts → LoadingFallback shown
  → STLLoader fetches new blob URL
  → LampSTLMesh mounts with new geometry
```

### 9.3 URL Lifecycle

| Event | `activeModelUrl` value |
|---|---|
| Initial load | `activeLamp.modelPath` (static `/public` 3MF path) |
| Admin uploads new STL (legacy) | Vercel Blob CDN URL |
| User navigates by index-point gesture | New lamp's `modelPath` (Blob URL discarded) |

Navigation **always** resets `activeModelUrl` to the catalogue's static path. This is intentional — the display should always show the correct product after a gesture-based lamp change.

---

## 10. Active Configuration & Tuning Knobs

These constants are the primary knobs for calibrating the experience. They are **co-located with their logic** (not in a central config file) to keep changes close to their effects.

| Constant | File | Default | What it controls |
|---|---|---|---|
| `CAMERA_IS_MIRRORED` | `handTracking.worker.ts` | `false` | Handedness mapping mode |
| `CAPTURE_WIDTH/HEIGHT` | `useHandWorker.ts:19-20` | `640×360` | Frame downscale before worker |
| `GRAB_CURL_THRESHOLD` | `gestures.ts` | `1.05` | Grab detection sensitivity |
| `GRAB_OPEN_RATIO` | `gestures.ts` | `1.5` | Confidence score open endpoint |
| `GRAB_CLOSED_RATIO` | `gestures.ts` | `0.55` | Confidence score closed endpoint |
| `POINT_MIN_INDEX_EXTENSION` | `gestures.ts` | `0.6` | Minimum normalized index extension |
| `POINT_MIN_HORIZONTAL_COMPONENT` | `gestures.ts` | `0.18` | Minimum horizontal direction strength |
| `POINT_MAX_VERTICAL_COMPONENT` | `gestures.ts` | `0.14` | Max vertical drift allowed for point |
| `POINT_MIN_HORIZONTAL_DOMINANCE` | `gestures.ts` | `1.45` | Horizontal-vs-vertical dominance ratio |
| `POINT_MAX_MIDDLE_CURL` | `gestures.ts` | `1.2` | Reject open palm as pointing |
| `POINT_STABLE_FRAMES` | `useGestureDetector.ts` | `3` | Consecutive frames needed before nav fire |
| `SWIPE_COOLDOWN_MS` | `useGestureDetector.ts` | `700` | Cooldown between point-triggered navigations |
| `TARGET_WORLD_SIZE` | `Scene3D.tsx` | `3.2` | 3MF auto-scale target diameter |
| `ROTATE_X_SENSITIVITY` | `useGestureDetector.ts` | `π × 2.4` | Horizontal hand -> rotX |
| `ROTATE_Y_SENSITIVITY` | `useGestureDetector.ts` | `π × 2.4` | Vertical hand -> rotY |
| `GRAB_SELECT_HOLD_MS` | `useGestureDetector.ts` | `800` | Left-fist hold time before select |
| `SELECTED_OFFSET_X` | `Scene3D.tsx` | `-1.05` | Model left-shift when panel opens |
| `ROTATE_REQUIRED_SECONDS` | `TutorialOverlay.tsx` | `3.5` | Rotate step completion timer |

---

## 11. Current Status & Remaining Work

### ✅ Complete

- Web Worker + rVFC frame pipeline
- Zustand stores (hand, gallery, tutorial)
- Pure gesture math library (`lib/gestures.ts`)
- Scene3D: ThreeMFLoader, auto-scale, robust fallback mesh, Bloom
- Tutorial overlay (5-step state machine, `guardedAdvance`)
- Main overlay (InfoPanel, LampCounter, gesture feedback)
- Server Action + Vercel Blob upload
- AdminUpload component
- Gesture bridge (`useGestureDetector.ts`) wired and active
- Client shell (`AppShellClient.tsx`) with hydration guard + dynamic scene/camera loading

### 🔲 Remaining / Optional Improvements

- `useWebhook.ts` — one-shot POST hook with lock flag. Fires `{ action: 'turn_on', lampId }` exactly once per confirmed grab.
- `/admin` route — mounts `<AdminUpload>` for operator use.
- Migrate upload validation from STL-only to 3MF-aware if admin upload is required in production.

---

## 12. Critical Anti-Patterns — Do Not Introduce

These patterns will silently degrade performance or break the interaction pipeline. They are the primary things a new developer might accidentally introduce.

### ❌ useState for hand coordinates
```typescript
// WRONG — causes 30-60 re-renders per second, will freeze the browser
const [handPos, setHandPos] = useState({ x: 0, y: 0 });
```

### ❌ Zustand hook inside useFrame
```typescript
// WRONG — re-renders on every store update, even during R3F render
useFrame(() => {
  const { rightHand } = useHandStore(); // ← This is the hook form
});
```

### ❌ MediaPipe on the main thread
```typescript
// WRONG — blocks the JS thread, drops R3F frames to ~5fps
const result = handLandmarker.detectForVideo(video, performance.now());
```

### ❌ Sending ImageBitmap without Transferable
```typescript
// WRONG — copies the entire bitmap buffer (expensive structured-clone)
worker.postMessage({ type: 'DETECT', bitmap, timestamp });

// CORRECT — transfers ownership, zero copy
worker.postMessage({ type: 'DETECT', bitmap, timestamp }, [bitmap]);
```

### ❌ Not closing ImageBitmap in the worker
```typescript
// WRONG — VRAM/RAM leak. After ~30 minutes at an event, the tab will crash.
const result = handLandmarker.detectForVideo(bitmap, timestamp);
// missing: bitmap.close()
```

### ❌ GPU delegate in a Web Worker
```typescript
// WRONG — WebGL is not available in Web Workers
delegate: 'GPU'  // silently fails, noisy console warnings
// CORRECT:
delegate: 'CPU'  // explicit, no fallback noise
```

### ❌ Turning off the flat Canvas
```typescript
// WRONG — removes flat=true, re-enables ACESFilmic, clamps emissive to 1.0
<Canvas>          // emissiveIntensity: 4.0 becomes visually identical to 0.5
// CORRECT:
<Canvas flat>     // required for Bloom to see unclamped emissive values
```

### ❌ Skipping computeVertexNormals on STL
```typescript
// WRONG — flat-shaded triangles, looks like an unshaded mesh
const geometry = useLoader(STLLoader, url);
// missing: geometry.computeVertexNormals()
```

### ❌ Fixed lerp coefficient instead of delta-time damp
```typescript
// WRONG — frame-rate dependent: feels sluggish at 30fps, jittery at 120fps
mesh.rotation.y = lerp(mesh.rotation.y, target, 0.1);
// CORRECT — frame-rate independent exponential decay
mesh.rotation.y = THREE.MathUtils.damp(mesh.rotation.y, target, lambda, delta);
```

### ❌ Firing the webhook on every frame
```typescript
// WRONG — sends hundreds of POST requests per second while the fist is held
useFrame(() => {
  if (isGrabbing) fetch('/api/webhook', { method: 'POST', ... });
});
// CORRECT — useWebhook.ts uses a lock flag, fires exactly once per selection
```
