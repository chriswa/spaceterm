/**
 * A CSS `url()` for any href, quoted.
 *
 * Vite inlines small assets as data URIs, and an inlined SVG's attributes are
 * single-quoted (`data:image/svg+xml,%3csvg xmlns='…'`). An unquoted `url()`
 * may not contain a quote, so the declaration is invalid: Chromium let it
 * through, WebKit drops it — and a mask that is dropped paints its element as
 * a solid block, which is how the model hats looked on the phone.
 */
export function cssUrl(href: string): string {
  return `url("${href.replace(/["\\]/g, '\\$&').replace(/\n/g, '%0A')}")`
}
