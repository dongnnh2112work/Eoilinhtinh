import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { Lamp } from '../types';

// =============================================================================
// LAMP CATALOGUE
// =============================================================================
// modelPath now points to .3mf files for lighter transfer size and faster load.

const LAMP_CATALOGUE: Lamp[] = [
  {
    id: 'lamp-aurora',
    name: 'Aurora Bloom',
    tagline: 'Soft Spiral Canopy',
    description:
      'A gentle spiral shade tuned for warm ambient corners. This variant focuses on soft diffusion with minimal visual noise in the lattice profile.',
    modelPath: '/models/lamp-aurora.3mf',
    accentColor: '#7DF9FF',
    material: 'PLA+ Matte White',
    printTime: '8h 40m',
  },
  {
    id: 'lamp-helix',
    name: 'Helix Arc',
    tagline: 'Dynamic Twist Profile',
    description:
      'A more expressive twist ratio creates stronger highlights when rotating. This concept is intended for feature walls and high-contrast lighting scenes.',
    modelPath: '/models/lamp-helix.3mf',
    accentColor: '#FF6B35',
    material: 'PETG Satin',
    printTime: '9h 15m',
  },
  {
    id: 'lamp-strata',
    name: 'Strata Flow',
    tagline: 'Layered Ribbon Diffuser',
    description:
      'Alternating ribbon density provides a directional glow pattern. This version is balanced for tabletop displays and short viewing distance demos.',
    modelPath: '/models/lamp-strata.3mf',
    accentColor: '#C9A84C',
    material: 'PLA Silk Ivory',
    printTime: '7h 55m',
  },
];

// =============================================================================
// STORE SHAPE
// =============================================================================

export interface GalleryStoreState {
  // ── Lamp catalogue ───────────────────────────────────────────────────────
  lamps: Lamp[];
  activeLampIndex: number;
  activeLamp: Lamp;

  /**
   * The URL currently being rendered by Scene3D's STLLoader.
   *
   * Two sources can write this:
   *  1. Navigation (navigateTo / navigateNext / navigatePrev) resets it to
   *     the newly active lamp's `modelPath` (a static /public path).
   *  2. Admin upload (setActiveModelUrl) overrides it with a Vercel Blob URL,
   *     allowing the display to hot-swap to a freshly uploaded .stl without
   *     a page reload or a catalogue edit.
   *
   * Scene3D always reads from activeModelUrl — never directly from
   * activeLamp.modelPath — so both paths work transparently.
   */
  activeModelUrl: string;

  // ── Selection state ──────────────────────────────────────────────────────
  isSelected: boolean;

  // ── Live gesture states (written by useGestureDetector, read in useFrame) ─
  isGrabbing: boolean;
  pinchNormalized: number;
  /** Current rotation target from open-palm tracking.  Scene3D's useFrame
   *  damps toward this value each tick.  Written by useGestureDetector. */
  rotationTarget: { rotX: number; rotY: number };

  // ── Webhook one-shot lock ─────────────────────────────────────────────────
  webhookFired: boolean;

  // ── Actions ──────────────────────────────────────────────────────────────
  navigateTo: (index: number) => void;
  navigateNext: () => void;
  navigatePrev: () => void;
  setIsSelected: (value: boolean) => void;
  setIsGrabbing: (value: boolean) => void;
  setPinchNormalized: (value: number) => void;
  setRotationTarget: (target: { rotX: number; rotY: number }) => void;
  setWebhookFired: (value: boolean) => void;

  /**
   * Called by AdminUpload on successful blob upload.
   * Overrides the displayed model with the uploaded file URL.
   * Does NOT change activeLampIndex or any catalogue data.
   */
  setActiveModelUrl: (url: string) => void;
}

// =============================================================================
// STORE
// =============================================================================

export const useGalleryStore = create<GalleryStoreState>()(
  subscribeWithSelector((set, get) => ({
    lamps: LAMP_CATALOGUE,
    activeLampIndex: 0,
    activeLamp: LAMP_CATALOGUE[0],
    activeModelUrl: LAMP_CATALOGUE[0].modelPath,

    isSelected: false,
    isGrabbing: false,
    pinchNormalized: 1,
    rotationTarget: { rotX: 0, rotY: 0 },
    webhookFired: false,

    navigateTo: (index) => {
      const { lamps } = get();
      const clamped = Math.max(0, Math.min(lamps.length - 1, index));
      set({
        activeLampIndex: clamped,
        activeLamp: lamps[clamped],
        // Revert to the catalogue's static STL path for the new lamp.
        // Any admin-uploaded override is deliberately discarded on navigation
        // so the display always shows the correct product after a swipe.
        activeModelUrl: lamps[clamped].modelPath,
        isSelected: false,
        webhookFired: false,
      });
    },

    navigateNext: () => {
      const { lamps, activeLampIndex } = get();
      const next = (activeLampIndex + 1) % lamps.length;
      set({
        activeLampIndex: next,
        activeLamp: lamps[next],
        activeModelUrl: lamps[next].modelPath,
        isSelected: false,
        webhookFired: false,
      });
    },

    navigatePrev: () => {
      const { lamps, activeLampIndex } = get();
      const prev = (activeLampIndex - 1 + lamps.length) % lamps.length;
      set({
        activeLampIndex: prev,
        activeLamp: lamps[prev],
        activeModelUrl: lamps[prev].modelPath,
        isSelected: false,
        webhookFired: false,
      });
    },

    setIsSelected:       (value)  => set({ isSelected: value }),
    setIsGrabbing:       (value)  => set({ isGrabbing: value }),
    setPinchNormalized:  (value)  => set({ pinchNormalized: value }),
    setRotationTarget:   (target) => set({ rotationTarget: target }),
    setWebhookFired:     (value)  => set({ webhookFired: value }),
    setActiveModelUrl:   (url)    => set({ activeModelUrl: url }),
  })),
);
