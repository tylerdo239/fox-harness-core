// Tailwind for the copied reference data-profile screens only (src/ref/, scripts/sync-ref-profile.mjs).
// Theme = the reference web's tailwind.config.ts. Ours: no preflight (src/ref/ref.css has a reset scoped to
// .fh-ref instead), every utility scoped to .fh-ref (`important`) so it neither leaks into the rest of the app
// nor loses to the app's global `button` / `input[type=text]` rules, and dark mode follows the app's own
// [data-theme] / prefers-color-scheme switch (src/useTheme.ts) instead of a `.dark` class.
module.exports = {
  content: ['./src/ref/**/*.{ts,tsx}', './src/components/features/data-studio/DataStudioProfile.tsx'],
  important: '.fh-ref',
  corePlugins: { preflight: false, container: false },
  darkMode: ['variant', ['&:is([data-theme="dark"] *)', '@media (prefers-color-scheme: dark) { &:is(:root:not([data-theme="light"]) *) }']],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
