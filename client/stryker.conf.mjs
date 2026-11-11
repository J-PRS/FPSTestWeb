// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  reporters: ['clear-text', 'progress', 'html'],
  coverageAnalysis: 'perTest',
  mutate: ['src/game/blastForce.ts'],
  incremental: true,
  // ../../shared/ imports escape the client sandbox copy — mutate in
  // place instead (Stryker restores originals after the run).
  inPlace: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  concurrency: 4,
  timeoutMS: 10000,
  htmlReporter: { fileName: 'reports/mutation/index.html' },
};
