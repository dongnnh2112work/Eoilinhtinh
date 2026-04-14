'use client';
/**
 * Scene3D.tsx — React Three Fiber canvas (refactored for STL / Vercel Blob)
 *
 * ── What changed from the GLB version ────────────────────────────────────────
 *   REMOVED  useGLTF, useGLTF.preload, LampGLB, LampGLBWithFallback
 *   REMOVED  shadeMaterialRef / stemMaterialRef from LampGroup (material is now
 *            injected manually inside LampSTLMesh)
 *   ADDED    STLLoader via useLoader(STLLoader, url) — from three-stdlib
 *   ADDED    Auto-scale: bounding-box normalisation so any CAD export fits
 *            the viewport regardless of its native unit scale
 *   ADDED    LoadingFallback — pulsing wireframe shown by Suspense while the
 *            STL file is being fetched and parsed (can take several seconds for
 *            dense meshes from a Vercel Blob CDN URL)
 *   ADDED    activeModelUrl — Scene3D reads this from useGalleryStore and passes
 *            it to LampSTLMesh; changing the URL (via AdminUpload) triggers a
 *            key-based Suspense remount so the new model loads cleanly
 *   CHANGED  Glow logic lives entirely in LampSTLMesh — LampGroup no longer
 *            manages materials at all
 *
 * ── Component hierarchy ───────────────────────────────────────────────────────
 *   Scene3D (Canvas wrapper, reads activeLamp + activeModelUrl from store)
 *     LightRig
 *     Shadow ground plane
 *     LampGroup (groupRef — rotation + X-offset in useFrame)
 *       Float (idle bob)
 *         Suspense key={activeModelUrl} (LoadingFallback while fetching)
 *           LampSTLMesh (STLLoader, auto-scale, Center, meshStandardMaterial,
 *                        emissive glow in useFrame)
 *     ZoomController (camera FOV driven by right-hand pinch)
 *     EffectComposer → Bloom + Vignette
 */

import { Suspense, useRef, useEffect, useMemo, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Center, Float }  from '@react-three/drei';
import { ThreeMFLoader }  from 'three-stdlib';
import {
  EffectComposer,
  Bloom,
  Vignette,
} from '@react-three/postprocessing';
import { BlendFunction, KernelSize } from 'postprocessing';
import * as THREE from 'three';

import { useHandStore }    from '../../store/useHandStore';
import { useGalleryStore } from '../../store/useGalleryStore';
import {
  calculatePinch,
  grabConfidence,
} from '../../lib/gestures';
import type { Lamp } from '../../types';

// =============================================================================
// TUNING CONSTANTS  (unchanged from GLB version)
// =============================================================================

const ROTATION_LAMBDA        = 5;
const RETURN_LAMBDA          = 2;
const GLOW_IN_LAMBDA         = 12;
const GLOW_OUT_LAMBDA        = 3;
const MAX_EMISSIVE_INTENSITY = 4.0;
const MIN_FOV                = 22;
const MAX_FOV                = 52;
const FOV_LAMBDA             = 4;
const SELECTED_OFFSET_X      = -1.6;
const OFFSET_LAMBDA          = 4;

/**
 * The target bounding-sphere diameter in Three.js world units.
 * CAD-exported STLs can be anything from 1 mm to 10 m depending on the
 * slicer's unit setting.  Normalising to this diameter guarantees every
 * model fills the same viewport-friendly footprint.
 */
const TARGET_WORLD_SIZE = 3.2;

// =============================================================================
// LightRig  (unchanged)
// =============================================================================

function LightRig() {
  return (
    <>
      <ambientLight intensity={0.08} />
      <spotLight
        position={[4, 6, 4]}
        angle={0.35}
        penumbra={0.6}
        intensity={80}
        distance={20}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.001}
      />
      <spotLight
        position={[-5, 3, -4]}
        angle={0.5}
        penumbra={0.8}
        intensity={25}
        distance={18}
        color="#b0c8ff"
      />
      <pointLight
        position={[0, -2, 1]}
        intensity={8}
        distance={6}
        color="#ffcc88"
      />
    </>
  );
}

// =============================================================================
// LoadingFallback  (shown by Suspense while STL is fetching + parsing)
// =============================================================================
/**
 * A wireframe lamp silhouette that pulses in opacity.
 * It floats gently so the display doesn't feel frozen during the load.
 *
 * A single shared MeshBasicMaterial instance is used for all wireframe
 * meshes so opacity can be updated in one useFrame call — no per-mesh refs.
 */
function LoadingFallback() {
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        wireframe: true,
        color: 'white',
        transparent: true,
        opacity: 0.15,
      }),
    [],
  );

  // Dispose the material when this component unmounts (when the real STL arrives)
  useEffect(() => () => { mat.dispose(); }, [mat]);

  useFrame(({ clock }) => {
    // Breathe between 10% and 23% opacity — visible but not distracting
    mat.opacity = 0.10 + 0.13 * Math.sin(clock.elapsedTime * 2.2);
  });

  return (
    <Float speed={1.5} floatIntensity={0.12} rotationIntensity={0.08}>
      <group>
        {/* Shade cone */}
        <mesh position={[0, 0.65, 0]} material={mat}>
          <coneGeometry args={[0.82, 1.0, 10, 1]} />
        </mesh>
        {/* Stem */}
        <mesh position={[0, -0.1, 0]} material={mat}>
          <cylinderGeometry args={[0.06, 0.06, 1.2, 8]} />
        </mesh>
        {/* Base */}
        <mesh position={[0, -0.72, 0]} material={mat}>
          <cylinderGeometry args={[0.38, 0.42, 0.10, 20]} />
        </mesh>
      </group>
    </Float>
  );
}

// =============================================================================
// LampSTLMesh  (the hot-swappable model mesh)
// =============================================================================
/**
 * LampSTLMesh loads the STL geometry via useLoader (suspends while fetching),
 * normalises its scale, centres it in world space, and injects a full PBR
 * material with a glow emissive that's driven in useFrame.
 *
 * Key design decisions:
 *
 * 1. useLoader(STLLoader, url)
 *    Returns a THREE.BufferGeometry when resolved.  STLLoader does NOT return
 *    a scene graph — that's why we wrap it in <mesh> manually.
 *
 * 2. computeVertexNormals()
 *    STL binary format stores per-face normals (one per triangle).  Three.js's
 *    STLLoader imports them as face normals.  Without calling
 *    computeVertexNormals(), each triangle's three vertices share the same
 *    normal, producing flat-shaded hard edges — fine for some aesthetics but
 *    unusable for smooth-looking organic lamp shapes.
 *    We call this in a useMemo (synchronous, runs before first render) so the
 *    model is always smooth-shaded from frame 0.
 *
 * 3. Auto-scale via bounding box
 *    We compute the geometry's bounding sphere radius and derive a scale factor
 *    so the sphere diameter equals TARGET_WORLD_SIZE.  This is more robust than
 *    a fixed 0.05 because Fusion 360 defaults to mm (1 unit = 1 mm) while
 *    Blender defaults to m (1 unit = 1 m).
 *    A 200 mm tall lamp and a 0.2 unit tall lamp will both render at ~3.2 units
 *    after normalisation.
 *
 * 4. Material injection — critical for STL
 *    STL files have NO material, colour, or texture data whatsoever.  The
 *    entire appearance is defined here.  We use MeshStandardMaterial with:
 *      - A neutral mid-grey base colour that reads well under our spotlights
 *      - emissive set to the active lamp's accent colour
 *      - emissiveIntensity damped from 0 → MAX in useFrame on grab detection
 *    The Bloom post-process picks up the emissive contribution and creates the
 *    glow halo (possible because flat=true on the Canvas disables tone-mapping
 *    so emissive values >1 are not clamped before the Bloom pass).
 *
 * 5. key={url} on the Suspense boundary (in LampGroup)
 *    Forces React to unmount LampSTLMesh when the URL changes, triggering a
 *    fresh useLoader call with the new URL and showing LoadingFallback again
 *    during the hot-swap.  Without the key, React would try to patch the
 *    existing component and useLoader might serve the old cached geometry.
 */
interface LampModelMeshProps {
  url: string;
}

function LampModelMesh({ url }: LampModelMeshProps) {
  const [model, setModel] = useState<THREE.Object3D | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setModel(null);
    setFailed(false);

    const loader = new ThreeMFLoader();
    loader.load(
      url,
      (loaded) => {
        if (cancelled) return;
        const cloned = loaded.clone(true);

        cloned.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.material = new THREE.MeshStandardMaterial({
            color: '#9a9aae',
            roughness: 0.42,
            metalness: 0.55,
          });
        });

        const box = new THREE.Box3().setFromObject(cloned);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = TARGET_WORLD_SIZE / maxDim;
        cloned.scale.setScalar(scale);

        box.setFromObject(cloned);
        const center = new THREE.Vector3();
        box.getCenter(center);
        cloned.position.sub(center);

        setModel(cloned);
      },
      undefined,
      (error) => {
        console.error(`[Scene3D] Failed to parse 3MF: ${url}`, error);
        if (!cancelled) {
          setFailed(true);
          setModel(null);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    if (!model) return;
    return () => {
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
    };
  }, [model]);

  if (model) {
    return <primitive object={model} />;
  }

  // Fallback mesh keeps the scene interactive even if 3MF parsing fails.
  return (
    <Center>
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[0.65, 0.75, 1.4, 48, 1, true]} />
        <meshStandardMaterial
          color={failed ? '#8b3a3a' : '#6e6e78'}
          roughness={0.5}
          metalness={0.25}
          wireframe={failed}
        />
      </mesh>
    </Center>
  );
}

// =============================================================================
// LampGroup  (rotation + X-offset — no longer manages materials)
// =============================================================================

interface LampGroupProps {
  lamp: Lamp;
  modelUrl: string;
}

function LampGroup({ lamp, modelUrl }: LampGroupProps) {
  const groupRef = useRef<THREE.Group>(null);

  // ── Per-frame: rotation tracking + selected X-offset ─────────────────────
  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;

    // Read pre-computed rotation target from the gallery store.
    // useGestureDetector writes rotationTarget on every frame when the
    // right palm is open; it stays at {0,0} when tracking is inactive,
    // which causes the model to spring back to its rest orientation.
    const { rotationTarget, isSelected, isGrabbing } = useGalleryStore.getState();

    // ── Rotation ────────────────────────────────────────────────────────────
    // Use a slow return lambda when no rotation is active (target = {0,0})
    // so the model springs back gently.  While grabbing the rotation target
    // is driven by accumulated right-wrist movement via useGestureDetector.
    const isActivelyRotating = rotationTarget.rotX !== 0 || rotationTarget.rotY !== 0;
    const rotLambda = isActivelyRotating ? ROTATION_LAMBDA : RETURN_LAMBDA;

    group.rotation.x = THREE.MathUtils.damp(
      group.rotation.x, rotationTarget.rotX, rotLambda, delta,
    );
    group.rotation.y = THREE.MathUtils.damp(
      group.rotation.y, rotationTarget.rotY, rotLambda, delta,
    );

    // ── X-offset when InfoBox is open ────────────────────────────────────────
    const targetX = isSelected ? SELECTED_OFFSET_X : 0;
    group.position.x = THREE.MathUtils.damp(group.position.x, targetX, OFFSET_LAMBDA, delta);
  });

  return (
    <group ref={groupRef}>
      <Float speed={1.4} floatIntensity={0.12} rotationIntensity={0}>
        {/*
          key={modelUrl} — forces Suspense to unmount + remount LampSTLMesh
          whenever the URL changes (navigation swipe or admin upload).
          This ensures:
            • Old geometry is disposed (no VRAM leak)
            • LoadingFallback reappears during the new fetch + parse
            • useLoader's internal cache is keyed per URL so both the
              old and new model can exist in cache simultaneously
        */}
        <Suspense key={modelUrl} fallback={<LoadingFallback />}>
          <LampModelMesh url={modelUrl} />
        </Suspense>
      </Float>
    </group>
  );
}

// =============================================================================
// ZoomController  (unchanged)
// =============================================================================

function ZoomController() {
  useFrame(({ camera }, delta) => {
    const { rightHand } = useHandStore.getState();
    if (!rightHand) return;

    const pinch     = calculatePinch(rightHand);
    const targetFov = THREE.MathUtils.lerp(MIN_FOV, MAX_FOV, pinch);

    const cam = camera as THREE.PerspectiveCamera;
    cam.fov   = THREE.MathUtils.damp(cam.fov, targetFov, FOV_LAMBDA, delta);
    cam.updateProjectionMatrix();
  });
  return null;
}

// =============================================================================
// Scene3D  (public export)
// =============================================================================

interface Scene3DProps {
  className?: string;
}

export default function Scene3D({ className = '' }: Scene3DProps) {
  // Low-frequency reads — only re-renders on swipe or admin upload.
  // This is correct: we need a React re-render here to pass the new lamp/URL
  // props down to LampGroup, which then re-keys the Suspense boundary.
  const activeLamp     = useGalleryStore((s) => s.activeLamp);
  const activeModelUrl = useGalleryStore((s) => s.activeModelUrl);

  return (
    <div className={`relative w-full h-full ${className}`}>
      <Canvas
        flat        // Disables ACESFilmicToneMapping so emissive >1 feeds Bloom unclamped
        shadows
        camera={{ fov: 40, position: [0, 0, 4], near: 0.1, far: 100 }}
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
          logarithmicDepthBuffer: true,
        }}
        onCreated={({ gl }) => {
          gl.setClearColor(new THREE.Color('#141418'), 1);
        }}
      >
        {/* ── Lights ──────────────────────────────────────────────── */}
        <LightRig />

        {/* ── Shadow-receiving ground (invisible) ─────────────────── */}
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -1.8, 0]}
          receiveShadow
        >
          <planeGeometry args={[20, 20]} />
          <shadowMaterial opacity={0.25} />
        </mesh>

        {/* ── Lamp: rotation group + STL mesh ─────────────────────── */}
        <LampGroup lamp={activeLamp} modelUrl={activeModelUrl} />

        {/* ── Camera zoom ─────────────────────────────────────────── */}
        <ZoomController />

        {/* ── Post-processing ─────────────────────────────────────── */}
        {/*
          EffectComposer is intentionally placed OUTSIDE LampGroup's Suspense.
          Bloom must be active at all times — the LoadingFallback's wireframe
          material does not emit, but once the STL loads the glow needs to
          work without waiting for a second component to mount.
        */}
        <EffectComposer multisampling={4}>
          <Bloom
            luminanceThreshold={0.18}
            luminanceSmoothing={0.85}
            intensity={1.8}
            kernelSize={KernelSize.LARGE}
            blendFunction={BlendFunction.ADD}
            mipmapBlur
          />
          <Vignette
            offset={0.3}
            darkness={0.6}
            blendFunction={BlendFunction.NORMAL}
          />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
