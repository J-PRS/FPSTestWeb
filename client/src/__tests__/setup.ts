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
if (typeof globalThis.sessionStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
}
if (typeof globalThis.window === 'undefined') {
  (globalThis as Record<string, unknown>).window = {
    location: { search: '', href: 'http://localhost/' },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
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
    createElement: () => ({
      style: {},
      children: [] as unknown[],
      firstChild: null,
      id: '',
      maxLength: 0,
      placeholder: '',
      addEventListener: () => {},
      append(..._nodes: unknown[]) {},
      appendChild() { return null; },
      remove() {},
    }),
    createTextNode: (s: string) => ({ textContent: s }),
    body: { appendChild: () => {}, removeChild: () => {} },
    hidden: false,
  };
}
// Element classes for `instanceof` guards (key routers skip typing targets).
if (typeof globalThis.HTMLInputElement === 'undefined') {
  // oxlint-disable-next-line no-extraneous-class — instanceof needs a ctor, not a value
  class HtmlStub {}
  (globalThis as Record<string, unknown>).HTMLInputElement = HtmlStub;
  (globalThis as Record<string, unknown>).HTMLTextAreaElement = HtmlStub;
  (globalThis as Record<string, unknown>).HTMLElement = HtmlStub;
}
