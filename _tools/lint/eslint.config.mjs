import parser from '@typescript-eslint/parser';
export default [
  {
    files: ['**/src/**/*.ts'],
    languageOptions: { parser },
    rules: {
      'complexity': ['warn', { max: 15 }],
      'max-depth': ['warn', { max: 4 }],
      'max-params': ['warn', { max: 6 }],
      'max-lines-per-function': ['warn', { max: 120, skipBlankLines: true, skipComments: true }],
    },
  },
];
