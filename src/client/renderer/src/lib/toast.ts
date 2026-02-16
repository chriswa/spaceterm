type ToastListener = (message: string) => void

let listener: ToastListener | null = null

export function onToast(fn: ToastListener): () => void {
  listener = fn
  return () => { listener = null }
}

export function showToast(message: string): void {
  console.log('[toast]', message)
  if (listener) listener(message)
}
