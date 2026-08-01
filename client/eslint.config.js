import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from '@typescript-eslint/eslint-plugin'

export default [
  // Enable the standard TypeScript ruleset (unused vars, no-explicit-any,
  // no-floating-promises, prefer-const, no-var, etc.) — was installed but
  // never wired up before, so eslint only reported cognitive-complexity.
  ...tseslint.configs['flat/recommended'],

  {
    files: ['src/**/*.ts'],
    plugins: {
      sonarjs: sonarjs
    },
    rules: {
      // Keep cognitive-complexity as a warning (separate report filters on this)
      'sonarjs/cognitive-complexity': ['warn', 15],
      'sonarjs/no-nested-template-literals': 'off',
      'sonarjs/pseudo-random': 'off',

      // Tone down a few recommended rules that are too noisy for this codebase.
      // The codebase predates the linter and uses `any` deliberately in
      // network-handler glue; fix over time rather than blocking reports.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    }
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.js', 'src/**/*.ts.old', 'src/**/*.deprecated']
  }
]
