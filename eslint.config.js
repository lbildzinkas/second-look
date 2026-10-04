import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/coverage/',
      '**/node_modules/',
      '**/test/fixtures/',
      // Evaluation cases hold recorded pull requests' code, not ours.
      'packages/evaluation/cases/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The fake engine fixture is plain Node script with no types to read.
    files: ['packages/extension/test/fixtures/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
  {
    // The packaging script is plain Node script with no types to read.
    files: ['packages/extension/scripts/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
);
