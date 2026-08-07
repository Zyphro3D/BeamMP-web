import { X } from 'lucide-react'

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 flex items-center justify-between">
      <span>{message}</span>
      {onDismiss && <button onClick={onDismiss}><X size={12} /></button>}
    </div>
  )
}
