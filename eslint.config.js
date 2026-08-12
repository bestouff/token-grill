import tseslint from 'typescript-eslint';

export default [
    {
        ignores: ['node_modules/**', 'dist/**', 'build/**'],
    },
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts', 'tools/**/*.mjs'],
        languageOptions: {parser: tseslint.parser},
        rules: {
            'no-console': 'off',
            'no-unused-vars': 'off',
            'no-constant-condition': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
        },
    },
];
