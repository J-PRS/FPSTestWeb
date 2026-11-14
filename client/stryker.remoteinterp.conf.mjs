// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
// Scoped mutation audit for the remote-interp netcode. Baseline:
// ~39% mutation score — the surviving tail is untested initializers,
// logging, and stryker-disable'd equivalent mutants (each carry an
// inline reason). thresholds.break fails the run below baseline, so a
// regression reads as a red run, not a quietly-dropped score.
// Run: ./node_modules/.bin/stryker run stryker.remoteinterp.conf.mjs
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  reporters: ['clear-text', 'progress', 'html'],
  coverageAnalysis: 'perTest',
  mutate: ['src/entities/remoteInterp.ts'],
  incremental: true,
  // ../../shared/ imports escape the client sandbox copy — mutate in
  // place instead (Stryker restores originals after the run).
  inPlace: true,
  incrementalFile: 'reports/mutation/stryker-remoteinterp-incremental.json',
  concurrency: 4,
  timeoutMS: 10000,
  htmlReporter: { fileName: 'reports/mutation/remoteinterp.html' },
  thresholds: { break: 38, high: 80, low: 38 },
};
