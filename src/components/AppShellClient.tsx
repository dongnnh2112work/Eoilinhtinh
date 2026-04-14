'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import MainOverlay from './ui/MainOverlay';
import TutorialOverlay from './ui/TutorialOverlay';

const HandTrackingRuntime = dynamic(
  () => import('./camera/HandTrackingRuntime'),
  { ssr: false },
);

const Scene3D = dynamic(() => import('./canvas/Scene3D'), {
  ssr: false,
});

export default function AppShellClient() {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  if (!hydrated) {
    return (
      <main style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: '#141418',
            color: '#fff',
          }}
        >
          <p style={{ opacity: 0.8 }}>Initializing interactive scene...</p>
        </div>
      </main>
    );
  }

  return (
    <main style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <HandTrackingRuntime />
      <Scene3D className="w-full h-full" />
      <TutorialOverlay />
      <MainOverlay />
    </main>
  );
}
