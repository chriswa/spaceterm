interface ToastItem {
  id: number
  message: string
  exiting?: boolean
}

interface ToastProps {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
}

export function Toast({ toasts, onDismiss }: ToastProps) {
  if (toasts.length === 0) return null

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast${t.exiting ? ' toast--exiting' : ''}`}
          onClick={() => onDismiss(t.id)}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
