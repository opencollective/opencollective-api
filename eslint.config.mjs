import graphqlPlugin from '@graphql-eslint/eslint-plugin'; // eslint-disable-line import/no-unresolved
import openCollectiveConfig from 'eslint-config-opencollective/eslint-node.config.cjs';
import mocha from 'eslint-plugin-mocha';
import globals from 'globals';

export default [
  ...openCollectiveConfig,
  // Global ignores
  {
    ignores: [
      '**/node_modules/',
      '**/seeders/',
      'migrations/archives',
      '**/dist/',
      '**/coverage/',
      '**/.nyc_output',
      '**/.vscode',
      '**/.history',
      'config/collective-spam-bayes.json',
    ],
  },
  {
    files: ['**/*.{js,ts}'],

    processor: graphqlPlugin.processor,

    settings: {
      'import/resolver': {
        // You will also need to install and configure the TypeScript resolver
        // See also https://github.com/import-js/eslint-import-resolver-typescript#configuration
        typescript: true,
        node: true,
      },
    },

    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },

    rules: {
      'no-console': 'off',
      'import/no-commonjs': 'error',
      'import/no-named-as-default-member': 'off',
      'n/no-process-exit': 'off', // Applied only for CRON
      'node/shebang': 'off',
      'no-useless-escape': 'off',
      'prefer-rest-params': 'off',
      'require-atomic-updates': 'off',
      camelcase: 'error',
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
  // Disable some rules for migrations
  {
    files: ['migrations/**/*.{js,ts}'],
    rules: {
      'import/no-commonjs': 'off',
    },
  },
  // Disable some JS rules that are enforced in TS
  {
    files: ['**/*.js'],
    rules: {
      'no-unused-vars': 'error',
    },
  },
  // New TS rules
  {
    files: ['**/*.ts'],
    plugins: {
      'custom-errors': {
        rules: {
          'no-unthrown-errors': {
            create(context) {
              return {
                NewExpression(node) {
                  if (
                    node.callee.name &&
                    /^(Forbidden|ValidationFailed|NotFound|BadRequest|Unauthorized|SpamDetected|ServerError|Timeout|ConflictError|TooManyRequests|NotImplemented|CustomError|RateLimitExceeded|InvalidToken|FeatureNotSupportedForCollective|FeatureNotAllowedForUser|PlanLimit|TransferwiseError|ContentNotReady|UnexpectedError)$/.test(
                      node.callee.name,
                    )
                  ) {
                    const parent = node.parent;

                    // Allow if it's inside a ThrowStatement
                    if (parent.type === 'ThrowStatement') {
                      return;
                    }

                    // Allow if it's the second argument of an assert() call
                    if (
                      parent.type === 'CallExpression' &&
                      parent.callee.name === 'assert' &&
                      parent.arguments.length >= 2 &&
                      parent.arguments[1] === node
                    ) {
                      return;
                    }

                    context.report({
                      node,
                      message: `Error '${node.callee.name}' is created but not thrown. Add 'throw' before this statement.`,
                    });
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'error',
      'custom-errors/no-unthrown-errors': 'error',
    },
  },
  // Tests
  {
    files: ['test/**/*'],
    plugins: {
      mocha,
    },
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
    rules: {
      'n/no-unpublished-import': 'off',
      'n/no-missing-import': 'off', // We should configure it, but it's not working for now
      '@typescript-eslint/no-unused-expressions': 'off', // Doesn't play well with chai
      'mocha/no-exclusive-tests': 'error',
    },
  },
  // Mocks
  {
    files: ['test/mocks/**/*', 'test/nocks/**/*'],
    rules: {
      camelcase: 'off',
    },
  },
  // CRON jobs
  {
    files: ['cron/**/*.js'],
    rules: {
      'n/no-process-exit': 'off',
    },
  },
  {
    files: ['**/*.graphql'],

    languageOptions: {
      parser: graphqlPlugin.parser,
    },
    plugins: {
      '@graphql-eslint': graphqlPlugin,
    },

    settings: {
      'import/ignore': ['.d.ts$'],
    },

    rules: {
      '@graphql-eslint/no-deprecated': 'warn',
      '@graphql-eslint/fields-on-correct-type': 'error',
      '@graphql-eslint/no-duplicate-fields': 'error',
      '@graphql-eslint/naming-convention': [
        'error',
        {
          VariableDefinition: 'camelCase',

          OperationDefinition: {
            style: 'PascalCase',
            forbiddenPrefixes: ['get', 'fetch'],
            forbiddenSuffixes: ['Query', 'Mutation', 'Fragment'],
          },
        },
      ],
    },
  },
  {
    files: ['server/graphql/v2/**/*.+(js|ts)'],

    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/v1/types'],
              message: 'GraphQL V1 types should not be used with V2.',
            },
          ],
        },
      ],
    },
  },
];
