'use server';
/**
 * uploadModel.ts — Next.js Server Action
 *
 * Receives a FormData payload from AdminUpload, validates the file,
 * and uploads it to Vercel Blob storage.
 *
 * ── Security model ────────────────────────────────────────────────────────────
 * 1. Extension check     — only .stl is accepted (client-side `accept` is not
 *                          a security boundary; we re-check here on the server).
 * 2. MIME sniff check    — inspect the first 5 bytes for the STL binary magic
 *                          sequence.  ASCII STL files start with "solid" so
 *                          we accept both binary and ASCII variants.
 * 3. Size cap            — hard server-side limit of 50 MB prevents abuse.
 * 4. Filename sanitise   — strip non-alphanumeric characters before composing
 *                          the Blob path to prevent path traversal.
 * 5. Timestamp prefix    — prevents collisions when the same filename is
 *                          re-uploaded after a redesign.
 *
 * ── Return contract ───────────────────────────────────────────────────────────
 * Always returns a discriminated union so the caller can exhaustively handle
 * both the happy path and any error without try/catch on the call site:
 *
 *   { ok: true;  url: string; filename: string; bytes: number }
 *   { ok: false; error: string }
 */

import { put } from '@vercel/blob';

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB — generous for complex CAD models

/**
 * STL binary files begin with an 80-byte ASCII header (content is arbitrary)
 * followed by a 4-byte little-endian triangle count.  There is no universal
 * magic number, but ASCII STL files always start with the ASCII string "solid".
 * We only need to rule out obviously wrong file types (JPEG, PNG, etc.).
 *
 * Strategy: accept the file if it does NOT begin with a known foreign magic
 * byte sequence.  This is a "deny-known-bad" approach rather than
 * "allow-known-good" because STL has no fixed magic bytes of its own.
 */
const REJECTED_MAGIC: Array<[number[], string]> = [
  [[0xff, 0xd8, 0xff],          'JPEG image'],
  [[0x89, 0x50, 0x4e, 0x47],    'PNG image'],
  [[0x47, 0x49, 0x46],          'GIF image'],
  [[0x25, 0x50, 0x44, 0x46],    'PDF document'],
  [[0x50, 0x4b, 0x03, 0x04],    'ZIP archive'],
];

async function isMagicRejected(file: File): Promise<string | null> {
  const slice = await file.slice(0, 8).arrayBuffer();
  const bytes = new Uint8Array(slice);

  for (const [magic, label] of REJECTED_MAGIC) {
    if (magic.every((b, i) => bytes[i] === b)) {
      return label;
    }
  }
  return null;
}

// =============================================================================
// RETURN TYPES
// =============================================================================

export type UploadModelSuccess = {
  ok: true;
  /** Fully-qualified public Vercel Blob URL — ready for STLLoader  */
  url: string;
  /** Sanitised filename as stored in Blob  */
  filename: string;
  /** File size in bytes  */
  bytes: number;
};

export type UploadModelError = {
  ok: false;
  /** Human-readable error message safe to display in the admin UI  */
  error: string;
};

export type UploadModelResult = UploadModelSuccess | UploadModelError;

// =============================================================================
// SERVER ACTION
// =============================================================================

export async function uploadModel(formData: FormData): Promise<UploadModelResult> {
  // ── 1. Extract file ─────────────────────────────────────────────────────────
  const raw = formData.get('model');

  if (!(raw instanceof File)) {
    return { ok: false, error: 'No file was provided in the request.' };
  }

  const file = raw as File;

  // ── 2. Extension check ──────────────────────────────────────────────────────
  if (!file.name.toLowerCase().endsWith('.stl')) {
    return {
      ok: false,
      error: `"${file.name}" is not an .stl file. Only STL models are accepted.`,
    };
  }

  // ── 3. Empty / size guard ───────────────────────────────────────────────────
  if (file.size === 0) {
    return { ok: false, error: 'The uploaded file is empty.' };
  }

  if (file.size > MAX_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      error: `File size ${mb} MB exceeds the 50 MB limit. Please export a decimated version.`,
    };
  }

  // ── 4. Magic-byte sniff ─────────────────────────────────────────────────────
  const foreignType = await isMagicRejected(file);
  if (foreignType) {
    return {
      ok: false,
      error: `File appears to be a ${foreignType}, not an STL model.`,
    };
  }

  // ── 5. Sanitise filename ────────────────────────────────────────────────────
  // Strip the extension, remove everything that is not alphanumeric, hyphen,
  // or underscore, then re-attach the .stl suffix.
  const baseName = file.name
    .replace(/\.stl$/i, '')
    .replace(/[^a-z0-9_-]/gi, '_')
    .slice(0, 64) // cap path segment length
    || 'model';

  const timestamp = Date.now();
  const blobPath  = `models/stl/${timestamp}-${baseName}.stl`;

  // ── 6. Upload to Vercel Blob ─────────────────────────────────────────────────
  // `access: 'public'` is required so Three.js can fetch the URL directly
  // from the browser without authentication headers.
  //
  // contentType: STL is not in IANA's official MIME registry, but
  // 'model/stl' is the widely-accepted de-facto type and is correctly
  // handled by browsers for download/preview purposes.
  //
  // addRandomSuffix: false — we already include a timestamp in the path,
  // so Blob's random suffix would just add noise to the URL.
  try {
    const blob = await put(blobPath, file, {
      access: 'public',
      contentType: 'model/stl',
      addRandomSuffix: false,
    });

    return {
      ok: true,
      url: blob.url,
      filename: `${baseName}.stl`,
      bytes: file.size,
    };
  } catch (err) {
    // Surface the underlying message for debugging while keeping the
    // user-facing string non-technical and actionable.
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[uploadModel] Blob put failed:', detail);

    return {
      ok: false,
      error: 'Upload failed. Check that BLOB_READ_WRITE_TOKEN is set and try again.',
    };
  }
}
