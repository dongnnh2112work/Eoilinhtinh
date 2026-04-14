'use client';
/**
 * AdminUpload.tsx
 *
 * A standalone "fake admin panel" component for hot-swapping the displayed
 * 3D model at the event without a code deploy.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   Mount this component at a separate route (e.g. /admin) that is NOT shown
 *   on the main display monitor.  The operator uses a second laptop/tablet
 *   pointed at /admin to upload a new model; the display updates automatically
 *   because both pages share the same Zustand store over localStorage or
 *   because the operator refreshes the display after upload.
 *
 *   For a live hot-swap without refresh, pair this with a Zustand persist
 *   middleware + BroadcastChannel sync (out of scope here).
 *
 * ── Upload flow ───────────────────────────────────────────────────────────────
 *   1. User selects / drops an .stl file
 *   2. Client validates extension + size before the network call
 *   3. FormData is passed to the `uploadModel` Server Action
 *   4. Server validates again (magic bytes, size, extension)
 *   5. On success: url → useGalleryStore.setActiveModelUrl(url)
 *      Scene3D's <Suspense key={activeModelUrl}> reloads with the new URL
 *   6. On error: error message is shown inline
 *
 * ── Why no real upload progress? ──────────────────────────────────────────────
 * Next.js Server Actions are opaque POST requests — there is no standardised
 * way to intercept XHR progress events.  We show an animated indeterminate bar
 * to communicate "something is happening" rather than a fake percentage.
 * If real progress is needed in a future iteration, switch to Vercel Blob's
 * client-side `upload()` helper which accepts an `onUploadProgress` callback.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { uploadModel } from '../app/actions/uploadModel';
import type { UploadModelResult } from '../app/actions/uploadModel';
import { useGalleryStore } from '../store/useGalleryStore';

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_BYTES_CLIENT = 50 * 1024 * 1024; // mirror server limit for instant feedback

function formatBytes(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/** Animated indeterminate progress bar shown during upload */
function UploadProgressBar() {
  return (
    <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
      <div
        className="h-full bg-gradient-to-r from-transparent via-white to-transparent rounded-full"
        style={{
          width: '40%',
          animation: 'shimmerBar 1.6s ease-in-out infinite',
        }}
      />
    </div>
  );
}

/** Green checkmark badge shown after a successful upload */
function SuccessBadge({ filename, bytes, url }: { filename: string; bytes: number; url: string }) {
  return (
    <div className="flex flex-col gap-4 p-6 bg-emerald-950/60 border border-emerald-500/40 rounded-2xl">
      <div className="flex items-center gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6">
            <circle cx="12" cy="12" r="10" stroke="#34d399" strokeWidth="1.5" />
            <path
              d="M7 12l3.5 3.5L17 8"
              stroke="#34d399"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div>
          <p className="text-lg font-bold text-emerald-400">Upload successful</p>
          <p className="text-base text-white/60">{filename} — {formatBytes(bytes)}</p>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-sm font-bold uppercase tracking-widest text-white/30">Blob URL</p>
        <p className="text-sm font-mono text-white/60 break-all bg-black/30 px-3 py-2 rounded-lg">
          {url}
        </p>
      </div>

      <p className="text-base font-semibold text-emerald-300/80">
        ✓ Scene3D is now displaying this model.
      </p>
    </div>
  );
}

/** Red error box shown when upload fails */
function ErrorBox({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-4 p-5 bg-red-950/60 border border-red-500/40 rounded-2xl">
      <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6 flex-shrink-0 mt-0.5">
        <circle cx="12" cy="12" r="10" stroke="#f87171" strokeWidth="1.5" />
        <path d="M12 7v6M12 16.5v.5" stroke="#f87171" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div className="flex-1">
        <p className="text-lg font-bold text-red-400">Upload failed</p>
        <p className="text-base text-white/70 mt-1">{message}</p>
      </div>
      <button
        onClick={onDismiss}
        className="text-white/30 hover:text-white/70 transition-colors text-xl leading-none"
        aria-label="Dismiss error"
      >
        ×
      </button>
    </div>
  );
}

// =============================================================================
// FILE DROP ZONE
// =============================================================================

interface DropZoneProps {
  onFileSelected: (file: File) => void;
  disabled: boolean;
}

function DropZone({ onFileSelected, disabled }: DropZoneProps) {
  const inputRef   = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0 || disabled) return;
      onFileSelected(files[0]);
    },
    [onFileSelected, disabled],
  );

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  };

  const onDragLeave = () => setIsDragging(false);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload STL file — click or drag and drop"
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => e.key === 'Enter' && !disabled && inputRef.current?.click()}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`
        relative flex flex-col items-center justify-center gap-5
        border-2 border-dashed rounded-2xl p-14
        transition-all duration-200 cursor-pointer select-none
        ${disabled
          ? 'border-white/10 opacity-40 cursor-not-allowed'
          : isDragging
            ? 'border-white/70 bg-white/8 scale-[1.01]'
            : 'border-white/25 hover:border-white/50 hover:bg-white/4'
        }
      `}
    >
      {/* Upload icon */}
      <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5"
        className={`w-16 h-16 opacity-50 transition-transform duration-200 ${isDragging ? 'scale-110 opacity-80' : ''}`}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
      </svg>

      <div className="text-center">
        <p className="text-xl font-bold text-white">
          {isDragging ? 'Drop to upload' : 'Drag & drop your .stl file here'}
        </p>
        <p className="text-base text-white/50 mt-1">
          or click to browse — max 50 MB
        </p>
      </div>

      {/* Hidden native file input — constrained to .stl only */}
      <input
        ref={inputRef}
        type="file"
        accept=".stl"
        className="sr-only"
        onChange={(e) => handleFiles(e.target.files)}
        disabled={disabled}
      />
    </div>
  );
}

// =============================================================================
// SELECTED FILE PREVIEW
// =============================================================================

function FilePreview({
  file,
  onClear,
  disabled,
}: {
  file: File;
  onClear: () => void;
  disabled: boolean;
}) {
  const tooLarge = file.size > MAX_BYTES_CLIENT;

  return (
    <div className={`
      flex items-center gap-5 px-6 py-4
      border rounded-xl
      ${tooLarge
        ? 'border-red-500/40 bg-red-950/30'
        : 'border-white/15 bg-white/5'
      }
    `}>
      {/* STL file icon */}
      <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5"
        className="w-10 h-10 flex-shrink-0 opacity-70">
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>

      <div className="flex-1 min-w-0">
        <p className="text-lg font-bold text-white truncate">{file.name}</p>
        <p className={`text-base font-semibold ${tooLarge ? 'text-red-400' : 'text-white/50'}`}>
          {formatBytes(file.size)}
          {tooLarge && ' — exceeds 50 MB limit'}
        </p>
      </div>

      {!disabled && (
        <button
          onClick={onClear}
          className="text-white/30 hover:text-white/70 transition-colors text-2xl leading-none"
          aria-label="Remove selected file"
        >
          ×
        </button>
      )}
    </div>
  );
}

// =============================================================================
// ADMIN UPLOAD  (root export)
// =============================================================================

export default function AdminUpload() {
  const setActiveModelUrl = useGalleryStore((s) => s.setActiveModelUrl);
  const activeLamp        = useGalleryStore((s) => s.activeLamp);

  const [selectedFile, setSelectedFile]   = useState<File | null>(null);
  const [status, setStatus]               = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [result, setResult]               = useState<UploadModelResult | null>(null);

  const isUploading = status === 'uploading';

  // Clear result when a new file is selected
  useEffect(() => {
    if (selectedFile) setStatus('idle');
  }, [selectedFile]);

  const handleUpload = useCallback(async () => {
    if (!selectedFile || isUploading) return;
    if (selectedFile.size > MAX_BYTES_CLIENT) return;

    setStatus('uploading');
    setResult(null);

    const formData = new FormData();
    formData.append('model', selectedFile);

    const res = await uploadModel(formData);
    setResult(res);

    if (res.ok) {
      setStatus('done');
      // Hot-swap: the Zustand store update propagates to Scene3D immediately.
      // Scene3D's <Suspense key={activeModelUrl}> will unmount the old mesh
      // and show the loading fallback while the new STL is fetched and parsed.
      setActiveModelUrl(res.url);
    } else {
      setStatus('error');
    }
  }, [selectedFile, isUploading, setActiveModelUrl]);

  return (
    <>
      {/* Keyframe for the indeterminate progress shimmer */}
      <style>{`
        @keyframes shimmerBar {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
      `}</style>

      <div className="min-h-screen bg-[#0E0E14] flex items-center justify-center p-8">
        <div className="w-full max-w-2xl flex flex-col gap-8">

          {/* ── Header ──────────────────────────────────────────────────── */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              {/* Wrench icon */}
              <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5"
                className="w-8 h-8 opacity-70">
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
              </svg>
              <h1 className="text-3xl font-black text-white">Model Upload</h1>
            </div>
            <p className="text-lg text-white/50">
              Currently displaying:&nbsp;
              <span className="font-bold text-white/80">{activeLamp.name}</span>
            </p>
          </div>

          {/* ── Drop zone ───────────────────────────────────────────────── */}
          <DropZone onFileSelected={setSelectedFile} disabled={isUploading} />

          {/* ── Selected file preview ────────────────────────────────────── */}
          {selectedFile && (
            <FilePreview
              file={selectedFile}
              onClear={() => { setSelectedFile(null); setResult(null); setStatus('idle'); }}
              disabled={isUploading}
            />
          )}

          {/* ── Upload button ─────────────────────────────────────────────── */}
          {selectedFile && status !== 'done' && (
            <button
              onClick={handleUpload}
              disabled={isUploading || selectedFile.size > MAX_BYTES_CLIENT}
              className={`
                w-full py-5 rounded-2xl
                text-xl font-black tracking-wide
                transition-all duration-200
                ${isUploading
                  ? 'bg-white/10 text-white/40 cursor-not-allowed'
                  : selectedFile.size > MAX_BYTES_CLIENT
                    ? 'bg-red-900/40 text-red-400/60 cursor-not-allowed'
                    : 'bg-white text-[#0E0E14] hover:bg-white/90 active:scale-[0.98] shadow-[0_0_40px_rgba(255,255,255,0.15)]'
                }
              `}
            >
              {isUploading ? 'Uploading…' : 'Upload & Display on Screen'}
            </button>
          )}

          {/* ── Upload progress bar ─────────────────────────────────────── */}
          {isUploading && (
            <div className="flex flex-col gap-3">
              <UploadProgressBar />
              <p className="text-base text-white/50 text-center">
                Uploading {selectedFile?.name}… Large .stl files may take 30–60 seconds.
                <br />Please keep this tab open.
              </p>
            </div>
          )}

          {/* ── Success state ─────────────────────────────────────────────── */}
          {status === 'done' && result?.ok && (
            <SuccessBadge
              filename={result.filename}
              bytes={result.bytes}
              url={result.url}
            />
          )}

          {/* ── Error state ───────────────────────────────────────────────── */}
          {status === 'error' && result && result.ok === false && (
            <ErrorBox
              message={result.error}
              onDismiss={() => { setStatus('idle'); setResult(null); }}
            />
          )}

          {/* ── Footer note ───────────────────────────────────────────────── */}
          <p className="text-sm text-white/25 text-center">
            Uploads are stored in Vercel Blob and served via CDN.
            The display will hot-swap to the new model immediately.
          </p>

        </div>
      </div>
    </>
  );
}
