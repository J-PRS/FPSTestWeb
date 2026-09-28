// Minimal DOM stubs so modules that touch browser globals at import time
// (settings/localStorage, keybinds) load under vitest's node environment.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
}
if (typeof globalThis.window === 'undefined') {
  (globalThis as Record<string, unknown>).window = { location: { search: '', href: 'http://localhost/' } };
}
if (typeof globalThis.document === 'undefined') {
  // Enough of the DOM for module-level listeners/setup in Logger/hud-adjacent
  // modules; tests that exercise real DOM behavior should mount jsdom instead.
  (globalThis as Record<string, unknown>).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, addEventListener: () => {}, appendChild: () => {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
    hidden: false,
  };
}
