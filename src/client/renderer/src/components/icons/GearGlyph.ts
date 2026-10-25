/**
 * A spur gear: eight shallow teeth, each as wide at the pitch circle as the gap
 * beside it, with slightly tapered flanks and lightly softened corners, on one
 * solid body with a small round hole in the centre — the profile of a gear
 * that would mesh with another. One evenodd silhouette in a 100×100 box, used
 * only as a mask, so whoever draws it picks the colour.
 *
 * Its own module because two places draw it: the mark beside an automation's
 * run (`StampMark`) and the backdrop behind the automation card itself, so the
 * two read as the same thing.
 *
 * The path is precomputed rather than built at runtime: tooth flanks are lines,
 * the tip and root are arcs on two circles, and each corner is a quadratic
 * curve. Parameters it was generated from: 8 teeth, tip radius 47, root
 * radius 39 (teeth 17% of the radius deep), pitch radius 43 where tooth and gap
 * are equal; tooth half-width 8.4 there, tapering 1.8 either way to the root
 * and tip; corner radii 2.2; hole 10.
 */
export const GEAR_PATH = 'M37.7 12.99Q39.81 12.35 40.64 10.32L42.59 5.5Q43.41 3.46 45.6 3.21A47 47 0 0 1 54.4 3.21Q56.59 3.46 57.41 5.5L59.36 10.32Q60.19 12.35 62.3 12.99A39 39 0 0 1 67.48 15.14Q69.41 16.18 71.44 15.32L76.22 13.29Q78.25 12.44 79.97 13.8A47 47 0 0 1 86.2 20.03Q87.56 21.75 86.71 23.78L84.68 28.56Q83.82 30.59 84.86 32.52A39 39 0 0 1 87.01 37.7Q87.65 39.81 89.68 40.64L94.5 42.59Q96.54 43.41 96.79 45.6A47 47 0 0 1 96.79 54.4Q96.54 56.59 94.5 57.41L89.68 59.36Q87.65 60.19 87.01 62.3A39 39 0 0 1 84.86 67.48Q83.82 69.41 84.68 71.44L86.71 76.22Q87.56 78.25 86.2 79.97A47 47 0 0 1 79.97 86.2Q78.25 87.56 76.22 86.71L71.44 84.68Q69.41 83.82 67.48 84.86A39 39 0 0 1 62.3 87.01Q60.19 87.65 59.36 89.68L57.41 94.5Q56.59 96.54 54.4 96.79A47 47 0 0 1 45.6 96.79Q43.41 96.54 42.59 94.5L40.64 89.68Q39.81 87.65 37.7 87.01A39 39 0 0 1 32.52 84.86Q30.59 83.82 28.56 84.68L23.78 86.71Q21.75 87.56 20.03 86.2A47 47 0 0 1 13.8 79.97Q12.44 78.25 13.29 76.22L15.32 71.44Q16.18 69.41 15.14 67.48A39 39 0 0 1 12.99 62.3Q12.35 60.19 10.32 59.36L5.5 57.41Q3.46 56.59 3.21 54.4A47 47 0 0 1 3.21 45.6Q3.46 43.41 5.5 42.59L10.32 40.64Q12.35 39.81 12.99 37.7A39 39 0 0 1 15.14 32.52Q16.18 30.59 15.32 28.56L13.29 23.78Q12.44 21.75 13.8 20.03A47 47 0 0 1 20.03 13.8Q21.75 12.44 23.78 13.29L28.56 15.32Q30.59 16.18 32.52 15.14A39 39 0 0 1 37.7 12.99ZM50 40A10 10 0 1 0 50 60A10 10 0 1 0 50 40Z'

export const GEAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
  + `<path fill="#000" fill-rule="evenodd" d="${GEAR_PATH}"/>`
  + '</svg>'

/** The gear as a CSS mask image. Quoted: WebKit drops an unquoted data URL in a mask. */
export const GEAR_MASK = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(GEAR_SVG)}")`
