'use client';
/**
 * MainOverlay.tsx
 *
 * The full-screen UI layer rendered once the tutorial is COMPLETED.
 * Contains no headers, no footers — nothing that competes with the 3D model.
 *
 * ── Layout regions ────────────────────────────────────────────────────────────
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │  [TOP-CENTRE SAFE ZONE]                              │
 *   │  Lamp counter  02 / 03                               │
 *   │                                                      │
 *   │                                                      │
 *   │          ← 3D MODEL (Scene3D behind) →               │
 *   │                                                  ┌──────┐
 *   │                                                  │ INFO │
 *   │                                                  │ PANEL│
 *   │                                                  └──────┘
 *   │                                                      │
 *   └──────────────────────────────────────────────────────┘
 *
 * Info Panel slides in from the RIGHT edge when a lamp is selected.
 * The 3D model offsets LEFT (handled in Scene3D.tsx's SELECTED_OFFSET_X).
 *
 * ── Re-render budget ──────────────────────────────────────────────────────────
 * React hook reads are only for low-frequency state:
 *   activeLamp    — changes on each swipe (~once per 2s at most)
 *   isSelected    — changes on confirm grab (~twice per interaction)
 *   isGrabbing    — changes on grab start/end (~2-4 times per interaction)
 *   lampCount     — constant
 *   activeLampIndex — changes on swipe
 *
 * None of these change at frame rate, so using the React hook form is correct
 * and won't cause performance issues.
 */

import { useEffect, useRef, useState } from 'react';
import { useTutorialStore }  from '../../store/useTutorialStore';
import { useGalleryStore }   from '../../store/useGalleryStore';
import type { Lamp }         from '../../types';

// =============================================================================
// LAMP COUNTER  (top-centre safe zone)
// =============================================================================
/**
 * Shows "02 / 03" style progress.  Positioned dead-centre at the top of the
 * screen — the safest zone, visible regardless of the user's height.
 */
function LampCounter({
  index,
  total,
}: {
  index: number;
  total: number;
}) {
  return (
    <div className="fixed top-10 left-1/2 -translate-x-1/2 z-30 flex items-center gap-5">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`
            rounded-full transition-all duration-500
            ${i === index
              ? 'w-10 h-4 bg-white shadow-[0_0_14px_rgba(255,255,255,0.7)]'
              : 'w-4 h-4 bg-white/25'
            }
          `}
        />
      ))}
    </div>
  );
}

// =============================================================================
// GESTURE HINT ICONS  (persistent corner hints once tutorial is done)
// =============================================================================
/**
 * Small persistent hint icons in the top-left corner that remind users of
 * the available gestures.  Subtle enough not to compete with the lamp model
 * but big enough to read from 1.5 m.
 */
function GestureHints() {
  return (
    <div className="fixed top-10 left-10 z-30 flex flex-col gap-5">
      <GestureHint icon="👈" label="Swipe to browse" />
      <GestureHint icon="✊" label="Fist to select"  />
      <GestureHint icon="🖐"  label="Palm to rotate"  />
    </div>
  );
}

function GestureHint({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="flex items-center gap-4 opacity-50 hover:opacity-80 transition-opacity">
      <span className="text-3xl">{icon}</span>
      <span className="text-xl font-bold text-white whitespace-nowrap">{label}</span>
    </div>
  );
}

// =============================================================================
// INFO PANEL  (slides in from right edge on selection)
// =============================================================================

/**
 * A stat row used inside the info panel.
 * Label is dimmed, value is full-white — clear hierarchy at distance.
 */
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xl font-bold uppercase tracking-[0.2em] text-white/45">
        {label}
      </span>
      <span className="text-2xl font-bold text-white">
        {value}
      </span>
    </div>
  );
}

/**
 * Animated checkmark that appears once the webhook has been fired.
 * Gives the user clear confirmation that the hardware system received the
 * "turn on" command.
 */
function ActivationBadge({ accentColor }: { accentColor: string }) {
  return (
    <div
      className="flex items-center gap-4 px-6 py-4 rounded-xl border"
      style={{
        borderColor: accentColor,
        backgroundColor: `${accentColor}18`,
        boxShadow: `0 0 24px ${accentColor}40`,
      }}
    >
      {/* Animated checkmark */}
      <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8 flex-shrink-0">
        <circle cx="12" cy="12" r="11" stroke={accentColor} strokeWidth="1.5" />
        <path
          d="M7 12l3.5 3.5L17 8"
          stroke={accentColor}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="animate-[dash_0.4s_ease-out_forwards]"
          style={{ strokeDasharray: 16, strokeDashoffset: 16,
                   animation: 'drawCheck 0.4s ease-out 0.1s forwards' }}
        />
      </svg>
      <span className="text-2xl font-black tracking-widest uppercase" style={{ color: accentColor }}>
        Lamp Activated
      </span>
    </div>
  );
}

/**
 * "Hold to Confirm" pulsing indicator shown while isGrabbing is true
 * but the webhook hasn't fired yet.
 */
function HoldIndicator({ accentColor }: { accentColor: string }) {
  return (
    <div className="flex items-center gap-4">
      <span
        className="w-4 h-4 rounded-full animate-ping"
        style={{ backgroundColor: accentColor }}
      />
      <span className="text-2xl font-bold text-white/70 animate-pulse">
        Hold to confirm…
      </span>
    </div>
  );
}

/**
 * The main info panel.  All typography follows the 1.5 m outdoor rule:
 *   Lamp name:    text-7xl font-black   (72px, weight 900)
 *   Tagline:      text-3xl font-bold    (30px, weight 700)
 *   Description:  text-2xl font-semibold (24px, weight 600)
 *   Meta labels:  text-xl font-bold     (20px, uppercase)
 *   Meta values:  text-2xl font-bold    (24px)
 */
interface InfoPanelProps {
  lamp: Lamp;
  visible: boolean;
  isGrabbing: boolean;
  webhookFired: boolean;
}

function InfoPanel({ lamp, visible, isGrabbing, webhookFired }: InfoPanelProps) {
  return (
    <div
      className={`
        fixed right-0 top-1/2 -translate-y-1/2 z-30
        w-[460px] max-h-[85vh] overflow-y-auto
        transition-transform duration-500 ease-out
        ${visible ? 'translate-x-0' : 'translate-x-[calc(100%+2rem)]'}
      `}
      aria-hidden={!visible}
    >
      {/*
        ── Panel card ──────────────────────────────────────────────────────────
        "Dark charcoal base, NOT transparent" (system prompt requirement).
        bg-[#1A1A24]/96 ≈ 96% opacity — essentially opaque from 1.5 m.
        backdrop-blur-md provides the glass edge effect at close range
        without compromising readability at distance.

        The left accent border uses the lamp's brand colour, creating a
        strong visual anchor that connects the panel to the glowing 3D model.
      */}
      <div
        className="
          mx-4 my-4
          bg-[#1A1A24]/96 backdrop-blur-md
          border border-white/10
          rounded-2xl
          overflow-hidden
        "
        style={{
          borderLeft: `5px solid ${lamp.accentColor}`,
          boxShadow: `
            0 0 0 1px rgba(255,255,255,0.06),
            0 40px 80px rgba(0,0,0,0.6),
            -20px 0 60px ${lamp.accentColor}20
          `,
        }}
      >
        <div className="p-10 flex flex-col gap-8">

          {/* ── Lamp name — the headline at 72px ─────────────────────────── */}
          <div>
            <h1
              className="text-7xl font-black leading-none tracking-tight text-white"
              style={{ textShadow: `0 0 40px ${lamp.accentColor}60` }}
            >
              {lamp.name}
            </h1>
            <p
              className="mt-3 text-3xl font-bold"
              style={{ color: lamp.accentColor }}
            >
              {lamp.tagline}
            </p>
          </div>

          {/* ── Divider ──────────────────────────────────────────────────── */}
          <div
            className="h-px w-full"
            style={{ background: `linear-gradient(to right, ${lamp.accentColor}80, transparent)` }}
          />

          {/* ── Description ──────────────────────────────────────────────── */}
          <p className="text-2xl font-semibold text-white/85 leading-relaxed">
            {lamp.description}
          </p>

          {/* ── Metadata grid ────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-6">
            <StatRow label="Material"   value={lamp.material}  />
            <StatRow label="Print Time" value={lamp.printTime} />
          </div>

          {/* ── Confirmation state ───────────────────────────────────────── */}
          {webhookFired ? (
            <ActivationBadge accentColor={lamp.accentColor} />
          ) : isGrabbing ? (
            <HoldIndicator accentColor={lamp.accentColor} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// NAVIGATION SWIPE FEEDBACK  (brief arrows flashing on swipe)
// =============================================================================
/**
 * Flashes a directional arrow in the relevant half of the screen for 600 ms
 * when the lamp index changes.  Pure CSS — no blocking state.
 */
function SwipeFeedback() {
  const [flashDir, setFlashDir] = useState<'left' | 'right' | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let lastIndex = useGalleryStore.getState().activeLampIndex;

    const unsub = useGalleryStore.subscribe(
      (s) => s.activeLampIndex,
      (index) => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setFlashDir(index > lastIndex ? 'right' : 'left');
        timeoutRef.current = setTimeout(() => setFlashDir(null), 600);
        lastIndex = index;
      },
    );
    return () => {
      unsub();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  if (!flashDir) return null;

  return (
    <div
      className={`
        fixed top-1/2 -translate-y-1/2 z-30
        pointer-events-none
        transition-opacity duration-300
        ${flashDir === 'left' ? 'left-12' : 'right-12'}
      `}
      style={{ opacity: flashDir ? 1 : 0 }}
    >
      <svg
        viewBox="0 0 24 24" fill="none" stroke="white"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className="w-24 h-24 opacity-70"
      >
        {flashDir === 'right'
          ? <path d="M5 12h14M13 6l6 6-6 6" />
          : <path d="M19 12H5M11 6L5 12l6 6" />
        }
      </svg>
    </div>
  );
}

// =============================================================================
// MAIN OVERLAY  (root export)
// =============================================================================
/**
 * Renders null until the tutorial phase is 'COMPLETED'.
 *
 * IMPORTANT: this component uses the React hook form of useGalleryStore for
 * isSelected, isGrabbing, and activeLamp.  These change at most a few times
 * per user interaction (not at frame rate), so causing React re-renders here
 * is intentional and correct.
 *
 * High-frequency hand coordinate reads remain in Scene3D's useFrame and never
 * reach this component.
 */
export default function MainOverlay() {
  const phase = useTutorialStore((s) => s.phase);

  const activeLamp      = useGalleryStore((s) => s.activeLamp);
  const activeLampIndex = useGalleryStore((s) => s.activeLampIndex);
  const lamps           = useGalleryStore((s) => s.lamps);
  const isSelected      = useGalleryStore((s) => s.isSelected);
  const isGrabbing      = useGalleryStore((s) => s.isGrabbing);
  const webhookFired    = useGalleryStore((s) => s.webhookFired);

  if (phase !== 'COMPLETED') return null;

  // Panel is visible when the user is actively grabbing OR has confirmed selection.
  const panelVisible = isGrabbing || isSelected;

  return (
    <>
      {/* CSS for the drawCheck animation in ActivationBadge */}
      <style>{`
        @keyframes drawCheck {
          to { stroke-dashoffset: 0; }
        }
      `}</style>

      {/* ── Top-centre safe zone: lamp counter ────────────────────────────── */}
      <LampCounter index={activeLampIndex} total={lamps.length} />

      {/* ── Top-left: persistent gesture reminder hints ───────────────────── */}
      <GestureHints />

      {/* ── Right edge: info panel ───────────────────────────────────────── */}
      <InfoPanel
        lamp={activeLamp}
        visible={panelVisible}
        isGrabbing={isGrabbing}
        webhookFired={webhookFired}
      />

      {/* ── Full-screen swipe direction flash ────────────────────────────── */}
      <SwipeFeedback />
    </>
  );
}
