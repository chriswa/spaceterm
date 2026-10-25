/**
 * A classic cog: six chunky, tapered teeth with well-rounded corners on one
 * solid body, with a small round hole in the centre. One evenodd silhouette in
 * a 100×100 box, used only as a mask, so whoever draws it picks the colour.
 *
 * Its own module because two places draw it: the mark beside an automation's
 * run (`StampMark`) and the backdrop behind the automation card itself, so the
 * two read as the same thing.
 *
 * The path is precomputed rather than built at runtime: tooth flanks are lines,
 * the tip and root are arcs on two circles, and each corner is a quadratic
 * curve. Parameters it was generated from: 6 teeth, tip radius 47, root
 * radius 35, tooth 36% of the pitch at the root and 22% at the tip, corner
 * radii 5 (tip) and 4 (root), hole 10.
 */
export const GEAR_PATH = 'M33.49 19.14Q37.12 17.46 37.76 13.51L38.46 9.18Q39.27 4.24 44.19 3.36A47 47 0 0 1 55.81 3.36Q60.73 4.24 61.54 9.18L62.24 13.51Q62.88 17.46 66.51 19.14A35 35 0 0 1 68.47 20.27Q71.74 22.57 75.48 21.15L79.59 19.6Q84.26 17.83 87.48 21.65A47 47 0 0 1 93.3 31.71Q94.99 36.42 91.12 39.58L87.72 42.36Q84.62 44.89 84.98 48.87A35 35 0 0 1 84.98 51.13Q84.62 55.11 87.72 57.64L91.12 60.42Q94.99 63.58 93.3 68.29A47 47 0 0 1 87.48 78.35Q84.26 82.17 79.59 80.4L75.48 78.85Q71.74 77.43 68.47 79.73A35 35 0 0 1 66.51 80.86Q62.88 82.54 62.24 86.49L61.54 90.82Q60.73 95.76 55.81 96.64A47 47 0 0 1 44.19 96.64Q39.27 95.76 38.46 90.82L37.76 86.49Q37.12 82.54 33.49 80.86A35 35 0 0 1 31.53 79.73Q28.26 77.43 24.52 78.85L20.41 80.4Q15.74 82.17 12.52 78.35A47 47 0 0 1 6.7 68.29Q5.01 63.58 8.88 60.42L12.28 57.64Q15.38 55.11 15.02 51.13A35 35 0 0 1 15.02 48.87Q15.38 44.89 12.28 42.36L8.88 39.58Q5.01 36.42 6.7 31.71A47 47 0 0 1 12.52 21.65Q15.74 17.83 20.41 19.6L24.52 21.15Q28.26 22.57 31.53 20.27A35 35 0 0 1 33.49 19.14ZM50 40A10 10 0 1 0 50 60A10 10 0 1 0 50 40Z'

export const GEAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
  + `<path fill="#000" fill-rule="evenodd" d="${GEAR_PATH}"/>`
  + '</svg>'

/** The gear as a CSS mask image. Quoted: WebKit drops an unquoted data URL in a mask. */
export const GEAR_MASK = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(GEAR_SVG)}")`
