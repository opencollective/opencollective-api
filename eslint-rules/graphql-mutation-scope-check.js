'use strict';

/**
 * Custom ESLint rule: graphql-mutations/require-scope-check
 *
 * Ensures every GraphQL mutation resolver in the v2 mutation files contains
 * a direct call to one of the scope-check functions from
 * server/graphql/common/scope-check.ts (e.g. enforceScope, checkRemoteUserCanUseExpenses).
 *
 * This guarantees that OAuth / personal token scopes are always validated
 * before a mutation's business logic runs.
 *
 * Applied only to server/graphql/v2/mutation/** via eslint.config.mjs.
 *
 * To opt out (e.g. for public / guest mutations that genuinely need no scope),
 * add an eslint-disable comment on the `resolve` property with an explanation:
 *
 *   // eslint-disable-next-line graphql-mutations/require-scope-check -- public guest mutation
 *   resolve: async (_, args, req) => { ... }
 */

const SCOPE_CHECK_FUNCTIONS = new Set([
  'checkRemoteUserCanUseKYC',
  'checkRemoteUserCanUseVirtualCards',
  'checkRemoteUserCanUseAccount',
  'checkRemoteUserCanUseExportRequests',
  'checkRemoteUserCanUseHost',
  'checkRemoteUserCanUseTransactions',
  'checkRemoteUserCanUseOrders',
  'checkRemoteUserCanUseApplications',
  'checkRemoteUserCanUseConversations',
  'checkRemoteUserCanUseExpenses',
  'checkRemoteUserCanUseUpdates',
  'checkRemoteUserCanUseConnectedAccounts',
  'checkRemoteUserCanUseWebhooks',
  'checkRemoteUserCanUseComment',
  'checkRemoteUserCanRoot',
  'checkScope',
  'enforceScope',
]);

/**
 * Returns true when the node (or any of its non-function descendants) contains
 * a direct call to a scope-check function.
 *
 * We deliberately do NOT descend into nested function definitions
 * (FunctionExpression / ArrowFunctionExpression / FunctionDeclaration) so that
 * a scope check inside a callback like `ids.map(id => enforceScope(...))` is
 * NOT counted – the check must live in the resolver's own code path.
 */
function containsScopeCheck(node) {
  if (!node || typeof node !== 'object') {
    return false;
  }

  if (node.type === 'CallExpression') {
    const callee = node.callee;
    if (callee.type === 'Identifier' && SCOPE_CHECK_FUNCTIONS.has(callee.name)) {
      return true;
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'parent') {
      continue;
    }
    const child = node[key];
    if (!child || typeof child !== 'object') {
      continue;
    }

    if (Array.isArray(child)) {
      for (const item of child) {
        if (!item || typeof item !== 'object' || !item.type) {
          continue;
        }
        if (isNestedFunctionNode(item)) {
          continue;
        }
        if (containsScopeCheck(item)) {
          return true;
        }
      }
    } else if (child.type) {
      if (isNestedFunctionNode(child)) {
        continue;
      }
      if (containsScopeCheck(child)) {
        return true;
      }
    }
  }

  return false;
}

function isNestedFunctionNode(node) {
  return (
    node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
  );
}

// eslint-disable-next-line import/no-commonjs
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ensure every GraphQL mutation resolver calls a scope-check function from graphql/common/scope-check.ts.',
      url: 'https://github.com/opencollective/opencollective-api/blob/main/server/graphql/common/scope-check.ts',
    },
    schema: [],
    messages: {
      missingScopeCheck:
        'Mutation resolver is missing a scope check. Call one of the scope-check functions from ' +
        'server/graphql/common/scope-check.ts (e.g. enforceScope, checkRemoteUserCanUseExpenses, ' +
        'checkRemoteUserCanRoot, …) at the start of the resolver. If no scope check is needed ' +
        '(e.g. public/guest mutation), disable this rule with an explanatory comment.',
    },
  },

  create(context) {
    return {
      Property(node) {
        // Match `resolve: <function>` and `async resolve() {}` (shorthand method).
        const key = node.key;
        const keyName = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : null;
        if (keyName !== 'resolve') {
          return;
        }

        const value = node.value;
        if (value.type !== 'FunctionExpression' && value.type !== 'ArrowFunctionExpression') {
          return;
        }

        // Walk the function body. For arrow functions with an expression body the
        // body itself is the expression node (not a BlockStatement).
        if (containsScopeCheck(value.body)) {
          return;
        }

        context.report({ node, messageId: 'missingScopeCheck' });
      },
    };
  },
};
