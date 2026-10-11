// Minimal DOM stubs so modules that touch browser globals at import time
// (settings/localStorage, keybinds) load under vitest's node environment.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
    clear: (): void => store.clear(),
    get length(): number { return store.size; },
    key: (i: number): string => [...store.keys()][i] ?? null,
  };
}
if (typeof globalThis.sessionStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
    clear: (): void => store.clear(),
  };
}
if (typeof globalThis.window === 'undefined') {
  (globalThis as Record<string, unknown>).window = {
    location: { search: '', href: 'http://localhost/' },
    addEventListener: (): void => { return; },
    removeEventListener: (): void => { return; },
    dispatchEvent: (): boolean => true,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}
if (typeof globalThis.CustomEvent === 'undefined') {
  class CustomEventStub<T> {
    type: string;
    detail: T | undefined;
    constructor(type: string, init?: { detail?: T }) { this.type = type; this.detail = init?.detail; }
  }
  (globalThis as Record<string, unknown>).CustomEvent = CustomEventStub;
}
if (typeof globalThis.document === 'undefined') {
  // Enough of the DOM for module-level listeners/setup in Logger/hud-adjacent
  // modules; tests that exercise real DOM behavior should mount jsdom instead.
  (globalThis as Record<string, unknown>).document = {
    addEventListener: (): void => { return; },
    removeEventListener: (): void => { return; },
    getElementById: (): null => null,
    querySelector: (): null => null,
    querySelectorAll: (): never[] => [],
    // Test seam — every element the stub makes, so tests can find module-
    // cached nodes (shotFeed's stack) that never reach document.body.
    _all: [] as unknown[],
    createElement: (): Record<string, unknown> & { children: unknown[]; } => {
      const el: Record<string, unknown> & { children: unknown[] } = {
        style: {},
        // Canvas 2d is drawn into, never read back — a bare ctx suffices
        // for procedural-texture builders under the node environment.
        getContext: () => ({
          createImageData: (w: number, h: number): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer>; } => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          getImageData: (_x: number, _y: number, w: number, h: number): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer>; } => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: (): void => { return; },
          createRadialGradient: (): { addColorStop: () => void; } => ({ addColorStop: (): void => { return; } }),
          createLinearGradient: (): { addColorStop: () => void; } => ({ addColorStop: (): void => { return; } }),
          fillRect: (): void => { return; },
          clearRect: (): void => { return; },
          drawImage: (): void => { return; },
        }),
        children: [] as unknown[],
        firstChild: null,
        get lastElementChild(): {} | null { return el.children.at(-1) ?? null; },
        innerHTML: '',
        id: '',
        maxLength: 0,
        placeholder: '',
        width: 0,
        height: 0,
        _parent: null as { children: unknown[] } | null,
        addEventListener: (): void => { return; },
        append(...nodes: unknown[]): void { for (const n of nodes) { el.children.push(n); if (n && typeof n === 'object') {(n as Record<string, unknown>)._parent = el;} } },
        prepend(n: unknown): void { el.children.unshift(n); (n as Record<string, unknown>)._parent = el; },
        appendChild(n: unknown): unknown { el.children.push(n); (n as Record<string, unknown>)._parent = el; return n; },
        remove(): void {
          const p = el._parent as { children: unknown[] } | null;
          if (p) { const i = p.children.indexOf(el); if (i !== -1) {p.children.splice(i, 1);} }
        },
      };
      (globalThis.document as unknown as { _all: unknown[] })._all.push(el);
      return el;
    },
    createTextNode: (s: string): { textContent: string; } => ({ textContent: s }),
    body: { append: (): void => { return; }, appendChild: (): void => { return; }, removeChild: (): void => { return; } },
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
