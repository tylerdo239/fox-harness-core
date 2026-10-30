// Tailwind for the app itself (src/styles/app.css). No preflight: the app's own base rules (src/styles/legacy.css,
// later @layer base) define element defaults, and the page must look exactly as before the move to Tailwind
// (docs/ui-performance-plan.md §8). The canvas panel and the Data Profile screens keep their own scoped builds
// (tailwind.canvas.config.cjs, tailwind.ref.config.cjs).
module.exports = {
  content: ['./src/**/*.{ts,tsx}', '!./src/ref/**'],
  corePlugins: { preflight: false, container: false },
  theme: { extend: {} },
}
