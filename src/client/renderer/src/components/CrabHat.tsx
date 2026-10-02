import { cssUrl } from '../lib/css-url'
import crownIcon from '../assets/hat-crown.svg'
import capIcon from '../assets/hat-cap.svg'
import dunceIcon from '../assets/hat-dunce.svg'
import { HAT_COLORS, type ModelHat } from '../lib/model-hat'

const HAT_ICONS: Record<ModelHat, string> = {
  crown: crownIcon,
  cap: capIcon,
  dunce: dunceIcon,
}

/**
 * A one-colour hat silhouette. It must be a sibling of the crab's masked mark,
 * not a child — a mask clips its descendants too — and the caller positions it
 * with `className`.
 */
export function CrabHat({ hat, className }: { hat: ModelHat; className: string }) {
  const url = cssUrl(HAT_ICONS[hat])
  return (
    <span
      className={`crab-hat ${className}`}
      data-hat={hat}
      aria-hidden="true"
      style={{ maskImage: url, WebkitMaskImage: url, backgroundColor: HAT_COLORS[hat] }}
    />
  )
}
