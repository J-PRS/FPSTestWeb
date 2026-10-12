/* oxlint-disable no-extend-native -- deliberate Array.prototype shims for engines < Chrome 110 */
// Copying array methods landed in Chrome 110 (toSorted/toReversed) and
// 112 (toSpliced/with) — older engines throw "x is not a function" deep
// in HUD/diag paths. Shim the four we use; mutating under the hood is
// fine, these sites only read the result.
if (!Array.prototype.toSorted) {
  Array.prototype.toSorted = function <T>(this: T[], cmp?: (a: T, b: T) => number): T[] {
    return this.slice().toSorted(cmp);
  };
}
if (!Array.prototype.toReversed) {
  Array.prototype.toReversed = function <T>(this: T[]): T[] {
    return this.slice().toReversed();
  };
}
if (!Array.prototype.toSpliced) {
  Array.prototype.toSpliced = function <T>(this: T[], start: number, deleteCount: number, ...items: T[]): T[] {
    const c = this.slice();
    c.splice(start, deleteCount, ...items);
    return c;
  };
}
if (!Array.prototype.with) {
  Array.prototype.with = function <T>(this: T[], index: number, value: T): T[] {
    const c = this.slice();
    c[index < 0 ? c.length + index : index] = value;
    return c;
  };
}


