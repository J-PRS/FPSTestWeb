// kindMake - client-side factory registry for world-model kinds (C5 pilot).
//
// The shared WorldKindDecl describes data (fields/channels); construction
// needs client-only deps (scene, terrain, deps). So the factory is
// registered here by kind name and looked up by the net* handlers instead
// of calling `new X(...)` directly. This is the first slice of the
// Room-as-replica upheaval: a kind's replica becomes declaration-driven
// (registered factory) rather than a hand-written constructor call at
// every spawn site. The old construction path stays as the fallback when
// no factory is registered, so this is purely additive until soak-proven.
const factories = new Map<string, (row: unknown, ctx: unknown) => unknown>();

export function registerMake(kind: string, fn: (row: unknown, ctx: unknown) => unknown): void {
  factories.set(kind, fn);
}

export function makeKind(kind: string, row: unknown, ctx: unknown): unknown {
  const f = factories.get(kind);
  return f ? f(row, ctx) : null;
}

export function hasMake(kind: string): boolean {
  return factories.has(kind);
}
