import type { NextConfig } from 'next';

// Derive webpack param types from NextConfig itself — no direct `webpack`
// import needed, and this stays in sync with whatever version Next.js bundles.
type WebpackConfig = NonNullable<Parameters<NonNullable<NextConfig['webpack']>>[0]>;
type WebpackContext = NonNullable<Parameters<NonNullable<NextConfig['webpack']>>[1]>;

const nextConfig: NextConfig = {
  // ── Web Worker support ──────────────────────────────────────────────────────
  // Webpack 5 (bundled with Next.js 13+) natively understands:
  //
  //   new Worker(new URL('../workers/handTracking.worker.ts', import.meta.url), { type: 'module' })
  //
  // It statically analyses that call at build time, splits the worker into its
  // own output chunk, and rewrites the URL to the hashed asset path.
  // No extra loader (worker-loader, workerize-loader, etc.) is required.
  webpack(config: WebpackConfig, { isServer }: WebpackContext): WebpackConfig {
    if (!isServer) {
      // Ensure worker output chunks use import-scripts loading so that
      // ES module `import` statements inside the worker are handled correctly
      // by the browser's module-worker runtime.
      config.output = {
        ...config.output,
        workerChunkLoading: 'import-scripts',
      };
    }
    return config;
  },

  // ── Image optimization ──────────────────────────────────────────────────────
  // Disabled — all visuals are Three.js-loaded GLB textures or inline SVG.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
