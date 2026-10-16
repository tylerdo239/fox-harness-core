// Tailwind for the canvas side panel and the components ported with it from local-fox-harness-core (src/components/
// features/canvas/, src/tw/). Same arrangement as tailwind.ref.config.cjs: no preflight (src/tw/tw.css has a reset
// scoped to .fh-tw), every utility scoped to .fh-tw (`important`) so it neither leaks into the rest of the app nor
// loses to the app's global element rules. The colors are this app's own theme.css variables (the source app's
// tokens were copied from them, same names), so light/dark follow theme.css with no `dark:` variants.
const mix = (name) => `color-mix(in srgb, var(${name}) calc(<alpha-value> * 100%), transparent)`

module.exports = {
  content: ['./src/components/features/canvas/**/*.{ts,tsx}', './src/tw/**/*.{ts,tsx}'],
  important: '.fh-tw',
  corePlugins: { preflight: false, container: false },
  theme: {
    extend: {
      colors: {
        bg: mix('--fh-bg'),
        surface: mix('--fh-surface'),
        border: mix('--fh-border'),
        'border-subtle': 'var(--fh-alias-border-subtle)',
        fg: mix('--fh-text'),
        muted: mix('--fh-muted'),
        accent: mix('--fh-accent'),
        'accent-contrast': mix('--fh-accent-contrast'),
        'accent-text': mix('--fh-alias-accent-text'),
        'bubble-live': mix('--fh-bubble-live'),
        error: mix('--fh-error'),
        'status-success': mix('--fh-alias-status-success'),
        'status-danger': mix('--fh-alias-status-danger'),
        'bg-hover': mix('--fh-alias-bg-hover'),
        'bg-raised': mix('--fh-alias-bg-raised'),
      },
      boxShadow: {
        'fh-sm': 'var(--fh-shadow-sm)',
        'fh-md': 'var(--fh-shadow-md)',
        'fh-lv2': 'var(--fh-shadow-lv2)',
      },
      transitionTimingFunction: { fh: 'var(--fh-ease)' },
    },
  },
}
