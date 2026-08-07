/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#f97316',
          hover:   '#ea6c00',
          dim:     '#f9731620',
        },
        surface: {
          DEFAULT: 'var(--surface)',
          raised:  'var(--surface-raised)',
          card:    'var(--surface-card)',
          border:  'var(--surface-border)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
