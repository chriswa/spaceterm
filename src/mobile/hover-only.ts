import type { AtRule, Plugin, Rule } from 'postcss'

/**
 * Hover styles only where something can hover: every `:hover` rule wrapped in
 * `@media (hover: hover)`, as the phone's bundle is built.
 *
 * iOS applies `:hover` to whatever a finger touched and leaves it there, so on
 * the phone a long press lit up the action button under the thumb, and a tap
 * left any button looking hovered until the next tap elsewhere. The desktop's
 * stylesheet is shared and its hover rules are right for the desktop, so they
 * are left as written and filtered here — which also covers every hover rule
 * added later.
 *
 * A rule whose selector list mixes hovered and plain selectors is split: the
 * plain ones stay as they are.
 */
const MEDIA = '(hover: hover)'

const insideHoverMedia = (rule: Rule): boolean => {
  for (let node = rule.parent; node; node = node.parent) {
    if (node.type === 'atrule' && (node as AtRule).name === 'media' && (node as AtRule).params === MEDIA) return true
  }
  return false
}

export function hoverOnly(): Plugin {
  return {
    postcssPlugin: 'spaceterm-hover-only',
    Rule(rule, { AtRule }) {
      if (!rule.selector.includes(':hover') || insideHoverMedia(rule)) return
      // Keyframe steps are not selectors.
      if (rule.parent?.type === 'atrule' && /keyframes$/.test((rule.parent as AtRule).name)) return
      const hovered = rule.selectors.filter((s) => s.includes(':hover'))
      const plain = rule.selectors.filter((s) => !s.includes(':hover'))
      const media = new AtRule({ name: 'media', params: MEDIA })
      if (plain.length) {
        media.append(rule.clone({ selectors: hovered }))
        rule.selectors = plain
        rule.after(media)
      } else {
        rule.replaceWith(media)
        media.append(rule)
      }
    }
  }
}
