interface Props {
  checked: boolean
  onChange: () => void
  disabled?: boolean
  /** Announced by screen readers instead of a bare "switch" — pass what
   * this toggle controls (e.g. a mod's name) when it isn't next to visible
   * text that already says it. */
  label?: string
}

export function Toggle({ checked, onChange, disabled, label }: Props) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={`toggle ${checked ? 'bg-accent' : 'bg-zinc-700'}`}
    >
      <span className={`toggle-thumb ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  )
}
