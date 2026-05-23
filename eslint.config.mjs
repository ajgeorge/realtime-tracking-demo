import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'client/**', 'coverage/**', 'jest.config.js'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
