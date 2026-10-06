// Ours: radix portals (dialogs, select menus) render at the end of <body>, outside the page's `.fh-ref` style
// scope (src/ref/ref.css). They render into this one `.fh-ref` element instead.
let container: HTMLElement | null = null;

export function refPortal(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  if (!container || !container.isConnected) {
    container = document.createElement("div");
    container.className = "fh-ref";
    document.body.appendChild(container);
  }
  return container;
}
