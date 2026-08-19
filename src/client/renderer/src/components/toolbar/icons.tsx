import type { ReactElement } from 'react'

/**
 * Inline SVG icons for the toolbar.
 *
 * Nine of these were interleaved with the toolbar's logic, which is most of
 * why the file could not be read in one sitting. They are pure markup with no
 * props and no state; grouping them is not a design, just tidiness.
 */

export function KeycastIcon() {
  // Vintage keyboard key from the front, slightly above.
  // Cap: front face (rectangle) + thin top surface strip visible from above.
  // Base is wider than the cap, so the back perspective lines peek out on
  // the sides — the "perspective trick" that makes it read as a 3D key.
  return (
    <svg viewBox="0 0 18 18" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      {/* Cap: front face + top surface (lit from above) */}
      <path d="M5 5 L4 3 L14 3 L13 5 L13 10 L5 10 Z" fill="currentColor" fillOpacity="0.2" />
      {/* Front slopes down to wider base front edge */}
      <path d="M5 10 L2 16 L16 16 L13 10" />
      {/* Back perspective lines + base back edge (visible outside cap because base is wider) */}
      <path d="M4 3 L1 14 L17 14 L14 3" />
      {/* Short base side connectors joining front and back base edges */}
      <line x1="1" y1="14" x2="2" y2="16" />
      <line x1="17" y1="14" x2="16" y2="16" />
    </svg>
  )
}

export function BugIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      {/* Body */}
      <ellipse cx="8" cy="10" rx="4" ry="4.5" fill="currentColor" fillOpacity="0.15" />
      {/* Head */}
      <circle cx="8" cy="4.5" r="2" />
      {/* Antennae */}
      <path d="M6.5 3 L4 1" />
      <path d="M9.5 3 L12 1" />
      {/* Legs */}
      <path d="M4 8 L1.5 6.5" />
      <path d="M4 11 L1.5 12.5" />
      <path d="M12 8 L14.5 6.5" />
      <path d="M12 11 L14.5 12.5" />
    </svg>
  )
}

export function ChipIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
      <rect x="6.75" y="6.75" width="2.5" height="2.5" rx="0.5" />
      {/* Pins, two per side */}
      <line x1="6.5" y1="4.5" x2="6.5" y2="2.5" />
      <line x1="9.5" y1="4.5" x2="9.5" y2="2.5" />
      <line x1="6.5" y1="11.5" x2="6.5" y2="13.5" />
      <line x1="9.5" y1="11.5" x2="9.5" y2="13.5" />
      <line x1="4.5" y1="6.5" x2="2.5" y2="6.5" />
      <line x1="4.5" y1="9.5" x2="2.5" y2="9.5" />
      <line x1="11.5" y1="6.5" x2="13.5" y2="6.5" />
      <line x1="11.5" y1="9.5" x2="13.5" y2="9.5" />
    </svg>
  )
}

export function GaugeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      {/* Dial: a half-circle open at the bottom */}
      <path d="M1.75 11.5a6.25 6.25 0 1 1 12.5 0" />
      {/* Needle, resting past three-quarters */}
      <line x1="8" y1="11.5" x2="11.5" y2="7.5" />
      <circle cx="8" cy="11.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function StopwatchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      {/* Top button */}
      <line x1="7" y1="1" x2="9" y2="1" />
      <line x1="8" y1="1" x2="8" y2="3" />
      {/* Clock face */}
      <circle cx="8" cy="9" r="5.5" />
      {/* Hand */}
      <line x1="8" y1="9" x2="8" y2="5.5" />
      <line x1="8" y1="9" x2="10.5" y2="9" />
    </svg>
  )
}

export function CameraIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      {/* Body */}
      <rect x="1" y="4.5" width="14" height="9" rx="1.5" />
      {/* Lens */}
      <circle cx="8" cy="9" r="2.8" />
      {/* Flash */}
      <rect x="5" y="2.5" width="6" height="2" rx="0.5" />
    </svg>
  )
}

export function ScrollIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      {/* Arrow down */}
      <line x1="8" y1="1" x2="8" y2="12" />
      <polyline points="4,8.5 8,12 12,8.5" />
      {/* Wave at bottom */}
      <path d="M2 15 Q5 13 8 15 Q11 17 14 15" />
    </svg>
  )
}

export function FitToMonitorIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      <polyline points="1,5 1,1 5,1" />
      <polyline points="11,1 15,1 15,5" />
      <polyline points="15,11 15,15 11,15" />
      <polyline points="5,15 1,15 1,11" />
    </svg>
  )
}

export function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      {/* Shackle */}
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
      {/* Body */}
      <rect x="3.5" y="7" width="9" height="7" rx="1.5" fill="currentColor" fillOpacity="0.2" />
    </svg>
  )
}

export function BellIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      <path d="M3 6.5a5 5 0 0 1 10 0c0 3 1.5 4.5 1.5 4.5H1.5S3 9.5 3 6.5" />
      <path d="M6 11a2 2 0 0 0 4 0" />
    </svg>
  )
}

export function DustpanIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" style={{ display: 'block' }}>
      {/* Pan + lip as a single outline so no horizontal seam separates them */}
      <path d="M5 7 L11 7 L14 12 L14 14.5 L2 14.5 L2 12 Z" fill="currentColor" fillOpacity="0.2" />
      {/* Handle */}
      <line x1="8" y1="7" x2="8" y2="3" strokeWidth="2" />
      {/* Grooves — small notches inset from the lip's bottom edge */}
      <line x1="5" y1="12.7" x2="5" y2="14.3" strokeWidth="0.8" />
      <line x1="7" y1="12.7" x2="7" y2="14.3" strokeWidth="0.8" />
      <line x1="9" y1="12.7" x2="9" y2="14.3" strokeWidth="0.8" />
      <line x1="11" y1="12.7" x2="11" y2="14.3" strokeWidth="0.8" />
    </svg>
  )
}
