/** check.ts — shared spec assertion helper (one line per check, fail → exit 1). */

let pass = 0;
export function check(ok: boolean, name: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
  else pass++;
}
export function checkCount(): number { return pass; }
