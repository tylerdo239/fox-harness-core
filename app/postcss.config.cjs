// Vite runs this on src/styles/app.css after inlining its @imports: Tailwind only (no autoprefixer — the
// stylesheets never had vendor prefixes added, and adding them would change the computed styles).
module.exports = { plugins: { tailwindcss: { config: './tailwind.config.cjs' } } }
