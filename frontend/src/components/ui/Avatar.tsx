const COLORS = ['bg-orange-500', 'bg-blue-500', 'bg-green-500', 'bg-purple-500', 'bg-pink-500', 'bg-cyan-500', 'bg-yellow-500']

export function Avatar({ name, size = 7 }: { name: string; size?: number }) {
  const color = COLORS[name.charCodeAt(0) % COLORS.length]
  return (
    <div className={`w-${size} h-${size} rounded-full ${color} flex items-center justify-center text-xs font-bold text-white shrink-0 uppercase`}>
      {name[0]}
    </div>
  )
}
