import type { ComponentType } from 'react'
import {
  EDGE_VERT_STATIC_SRC,
  EMBER_BG_FRAG,
  EMBER_EDGE_FRAG,
  CONCENTRIC_BG_FRAG,
  CONCENTRIC_EDGE_FRAG,
  MEDALLION_BG_FRAG,
  NEBULA_BG_FRAG,
  NEBULA_EDGE_FRAG,
} from './shaders'
import { DiscRootNode, OrbRootNode, ReticleRootNode, type RootNodeVisualProps } from './root-node'
import { NODE_TINTS, type NodeTintFacet } from './node-tint'
import { registerFacet } from './registry'

/**
 * The facets a theme is made of, and every implementation of each.
 *
 * A **facet** is one independently-swappable piece of the look: the canvas
 * background, the tree edges, the root node, the chrome around a card. A theme
 * is a *sparse* choice over these — it names the facets it cares about and the
 * rest fall through to `DEFAULT_FACETS`.
 *
 * ## Why sparse, and why the defaults are a theme
 *
 * The alternative — every theme spelling out every facet — means adding a
 * facet is an edit to every theme, and the compiler makes you do it. That is
 * the tax that stops a theme system growing. Here, adding a facet is one entry
 * in `ThemeFacets`, one entry in `DEFAULT_FACETS`, and nothing else: existing
 * themes pick up the default automatically and can opt in later.
 *
 * The catch with a default-plus-overrides model is that "the defaults" and
 * "the default theme" drift apart. They cannot here, because the default theme
 * is defined as the one with no overrides at all (see `./themes`) — the
 * fall-through *is* the theme, not a copy of it.
 *
 * ## Adding a facet
 *
 * 1. Define its value type below. Extend `FacetBase` so the picker can name it.
 * 2. Add the field to `ThemeFacets`.
 * 3. Add the implementation you want everyone to get to `DEFAULT_FACETS`.
 * 4. Read it where it is needed with `useFacet('yourFacet')`.
 *
 * Nothing in `./themes` has to change, and no existing theme breaks.
 */

/** Every facet implementation is nameable, so a theme can be described by parts. */
interface FacetBase {
  /** Stable within its facet. Not persisted — themes are, facets are not. */
  readonly id: string
  readonly label: string
}

/** A fragment shader for the full-screen canvas background. See `./shaders`. */
export interface BackgroundFacet extends FacetBase {
  readonly frag: string
  /**
   * How many times a second this shader's output actually changes.
   *
   * A promise, not a hint. `CanvasBackground` quantises `iTime` to this rate
   * (see `quantizeClock`), which hands the shader the *same* number across the
   * frames in between — so `CanvasFrameGate`, which skips a frame whose inputs
   * all match the last one, skips them too. Declaring a rate a shader exceeds
   * therefore does not look slightly wrong, it looks like a stutter; declaring
   * `0` for a shader that reads `iTime` freezes it outright.
   *
   * - **`0`** — output depends only on the camera. `iTime` is still bound (the
   *   uniform is free) but reading it makes the claim false.
   * - **omitted** — fully animated, redrawing as fast as `frame-policy` allows.
   *   The safe default, so a facet from a mod that has not thought about this
   *   looks right rather than being silently frozen.
   * - **a number** — the honest rate for motion far slower than the display.
   *   `ember`'s streaks drift at 0.03 units a second; ten steps a second is
   *   already thirty times finer than the eye can follow there, and costs a
   *   sixth of what 60 did.
   */
  readonly animatedHz?: number
}

/**
 * A shader pair for the chevron-textured tree edges. See `./shaders`.
 *
 * `vert` is optional and defaults to the scrolling `EDGE_VERT_SRC`. It exists
 * because the chevron crawl is applied to the V coordinate in the *vertex*
 * stage, so a theme that wants still edges cannot express that in its fragment
 * shader — the motion is already baked into `vUV` by the time it arrives.
 */
export interface EdgeFacet extends FacetBase {
  readonly frag: string
  readonly vert?: string
  /**
   * How many times a second this shader pair's output changes. See
   * `BackgroundFacet.animatedHz` — same promise, same safe default, same `0`
   * for "depends only on the camera and the edge geometry".
   *
   * Both halves have to hold for `0`. The default `vert` scrolls `vUV` with
   * `uTime`, so an edge facet is only static if it also supplies
   * `EDGE_VERT_STATIC_SRC`; and a fragment shader that samples the animated
   * background (as the nebula's does) is not static however still its own
   * geometry is.
   *
   * The chevron crawl is real motion rather than an imperceptible drift, so the
   * rates here are higher than the backgrounds': 30 reads as continuous for
   * something moving this slowly, and is half of what it cost before.
   */
  readonly animatedHz?: number
}

/** What is drawn in the circle at the world origin. */
export interface RootNodeFacet extends FacetBase {
  readonly Component: ComponentType<RootNodeVisualProps>
}

/**
 * CSS custom properties for card chrome.
 *
 * Values, not a stylesheet: the rules in `index.css` read these through
 * `var()`, so a theme changes the numbers without owning the layout. Keys must
 * be the full custom-property name including the leading `--`.
 */
export interface CardChromeFacet extends FacetBase {
  readonly vars: Readonly<Record<string, string>>
}

export { NODE_TINTS }
export type { NodeTintFacet }

/** The complete set. A theme supplies any subset; the rest come from `DEFAULT_FACETS`. */
export interface ThemeFacets {
  background: BackgroundFacet
  edges: EdgeFacet
  rootNode: RootNodeFacet
  cardChrome: CardChromeFacet
  nodeTint: NodeTintFacet
}

export type FacetId = keyof ThemeFacets

/** Facet ids, for iterating — `keyof` is a type and does not survive to runtime. */
export const FACET_IDS = ['background', 'edges', 'rootNode', 'cardChrome', 'nodeTint'] as const

/* ------------------------------------------------------------------ */
/*  Implementations                                                    */
/* ------------------------------------------------------------------ */

export const BACKGROUNDS = {
  // Both noise backgrounds drift far slower than they were being redrawn: the
  // ember streaks at 0.03 units a second, the nebula's field at 0.05/9. The
  // rates below are still an order of magnitude finer than either needs.
  ember: { id: 'ember', label: 'Ember', frag: EMBER_BG_FRAG, animatedHz: 10 },
  nebula: { id: 'nebula', label: 'Nebula', frag: NEBULA_BG_FRAG, animatedHz: 20 },
  // The static ones: patterns in world space, so they change when the camera
  // does and at no other time.
  concentric: { id: 'concentric', label: 'Concentric', frag: CONCENTRIC_BG_FRAG, animatedHz: 0 },
  medallion: { id: 'medallion', label: 'Medallion', frag: MEDALLION_BG_FRAG, animatedHz: 0 },
} as const satisfies Record<string, BackgroundFacet>

export const EDGES = {
  ember: { id: 'ember', label: 'Translucent', frag: EMBER_EDGE_FRAG, animatedHz: 30 },
  nebula: { id: 'nebula', label: 'Soft-light', frag: NEBULA_EDGE_FRAG, animatedHz: 30 },
  // The only edge facet that overrides the vertex shader, to hold still — and
  // therefore the only one that can promise `0`.
  concentric: {
    id: 'concentric',
    label: 'Static',
    frag: CONCENTRIC_EDGE_FRAG,
    vert: EDGE_VERT_STATIC_SRC,
    animatedHz: 0,
  },
} as const satisfies Record<string, EdgeFacet>

export const ROOT_NODES = {
  disc: { id: 'disc', label: 'Disc', Component: DiscRootNode },
  orb: { id: 'orb', label: 'Orb', Component: OrbRootNode },
  reticle: { id: 'reticle', label: 'Reticle', Component: ReticleRootNode },
} as const satisfies Record<string, RootNodeFacet>

/**
 * Card chrome sets.
 *
 * `standard` restates the values that were hard-coded in `index.css` — so
 * switching to it is a no-op, which is what makes it safe as the default.
 */
export const CARD_CHROMES = {
  standard: {
    id: 'standard',
    label: 'Standard',
    vars: {
      '--card-radius': '8px',
      '--card-border-width': '2px',
      '--card-border-color': '#313244',
      '--card-surface': '#1e1e2e',
      '--card-head-surface': '#181825',
      '--card-head-border-color': '#313244',
    },
  },
  hairline: {
    id: 'hairline',
    label: 'Hairline',
    vars: {
      '--card-radius': '10px',
      '--card-border-width': '1px',
      '--card-border-color': 'rgba(205, 214, 244, 0.22)',
      '--card-surface': 'rgba(24, 24, 37, 0.86)',
      '--card-head-surface': 'rgba(17, 17, 27, 0.7)',
      '--card-head-border-color': 'rgba(205, 214, 244, 0.14)',
    },
  },
  /** Squarer and flatter — reads as a panel rather than a floating pane. */
  technical: {
    id: 'technical',
    label: 'Technical',
    vars: {
      '--card-radius': '3px',
      '--card-border-width': '1px',
      '--card-border-color': 'rgba(154, 164, 189, 0.34)',
      '--card-surface': '#14161c',
      '--card-head-surface': '#1a1d25',
      '--card-head-border-color': 'rgba(154, 164, 189, 0.24)',
    },
  },
} as const satisfies Record<string, CardChromeFacet>

/**
 * What every facet resolves to unless a theme says otherwise — and, since the
 * default theme overrides nothing, what the default theme *is*.
 *
 * The background and edges here are the cheapest shaders in the file, chosen
 * after measurement rather than taste: they held 58–60 fps where the nebula
 * managed 27 on the same machine.
 */
export const DEFAULT_FACETS: ThemeFacets = {
  background: BACKGROUNDS.ember,
  edges: EDGES.ember,
  rootNode: ROOT_NODES.disc,
  cardChrome: CARD_CHROMES.standard,
  nodeTint: NODE_TINTS.angle,
}

// Core facets go into the same runtime registry a mod uses, derived from the
// literal above rather than restated — one source, so the typed record and the
// registry cannot disagree. Core ids are bare; `registerFacet` reserves the
// colon for mods.
for (const id of FACET_IDS) {
  registerFacet({ id, defaultValue: DEFAULT_FACETS[id] })
}
