import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { NormalizedLandmark } from '../types';

// =============================================================================
// HAND STORE
//
// This store is the single source of truth for raw hand landmark data.
//
// CRITICAL USAGE RULES — read before consuming this store:
//
//  ✅ DO read inside R3F's useFrame():
//       useFrame(() => {
//         const { rightHand } = useHandStore.getState();  // zero re-render
//       });
//
//  ✅ DO subscribe for side-effect-only listeners:
//       useEffect(() => {
//         const unsub = useHandStore.subscribe(
//           (state) => state.isTracking,
//           (isTracking) => { ... }
//         );
//         return unsub;
//       }, []);
//
//  ❌ DON'T use the hook form for high-frequency reads:
//       // BAD — fires a React re-render every 30–60 ms
//       const { rightHand } = useHandStore();
//
//  The only components that may safely use the hook form are ones that render
//  at most once or twice (e.g. an onboarding overlay that just needs to know
//  if isTracking changed from false → true).
// =============================================================================

export interface HandStoreState {
  /** User's anatomical left hand landmarks (21 points), or null if not visible */
  leftHand: NormalizedLandmark[] | null;
  /** User's anatomical right hand landmarks (21 points), or null if not visible */
  rightHand: NormalizedLandmark[] | null;
  /** performance.now() timestamp of the last detection frame */
  lastTimestamp: number;
  /** True if at least one hand is currently detected */
  isTracking: boolean;
}

export const useHandStore = create<HandStoreState>()(
  subscribeWithSelector(() => ({
    leftHand: null,
    rightHand: null,
    lastTimestamp: 0,
    isTracking: false,
  })),
);
