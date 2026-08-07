interface Props {
  checked: boolean
  onChange: () => void
  disabled?: boolean
}

export function Toggle({ checked, onChange, disabled }: Props) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={`toggle ${checked ? 'bg-accent' : 'bg-zinc-700'}`}
    >
      <span className={`toggle-thumb ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  )
}
