import sonarjs from 'eslint-plugin-sonarjs'
import tsparser from '@typescript-eslint/parser'

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module'
      }
    },
    plugins: {
      sonarjs: sonarjs
    },
    rules: {
      'sonarjs/cognitive-complexity': ['warn', 15],
      'sonarjs/no-nested-template-literals': 'off',
      'sonarjs/pseudo-random': 'off'
    }
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.js']
  }
]

