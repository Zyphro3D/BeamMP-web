import type { ReactNode } from 'react'

type Color = 'green' | 'red' | 'blue' | 'yellow' | 'gray'

export function Badge({ color, children }: { color: Color; children: ReactNode }) {
  return <span className={`badge-${color}`}>{children}</span>
}
