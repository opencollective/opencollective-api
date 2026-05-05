'use strict';

/**
 * Custom ESLint rule: private-accounts/require-account-visibility-check
 *
 * Ensures every `resolve` function in the top-level GraphQL query files that
 * loads a Collective from the database (via models.Collective.find* or
 * req.loaders.Collective.*.load*) also calls one of the four visibility
 * helpers exported from server/lib/private-accounts.ts:
 *
 *   assertCanSeeAccount        assertCanSeeAllAccounts
 *   canSeePrivateAccount       canSeeAllPrivateAccounts
 *
 * Exemption: a loader call whose first argument derives from req.remoteUser.*
 * is loading the currently-authenticated user's own account, which never
 * requires an explicit visibility gate.
 *
 * Only the IMMEDIATE body of the `resolve` function is analysed. Collective
 * loads that happen inside nested closures are intentionally ignored because
 * they represent deliberate encapsulation by the developer.
 */

const PRIVATE_ACCOUNTS_HELPERS = new Set([
  'assertCanSeeAccount',
  'assertCanSeeAllAccounts',
  'canSeePrivateAccount',
  'canSeeAllPrivateAccounts',
]);

const COLLECTIVE_FIND_METHODS = new Set(['findOne', 'findByPk', 'findBySlug', 'findAll']);

/**
 * Returns true for calls of the form  *.Collective.find*(...)
 * e.g. models.Collective.findOne({...})
 */
function isCollectiveFindCall(node) {
  if (node.type !== 'CallExpression') {
    return false;
  }
  const callee = node.callee;
  if (callee.type !== 'MemberExpression') {
    return false;
  }
  const method = callee.property;
  if (method.type !== 'Identifier' || !COLLECTIVE_FIND_METHODS.has(method.name)) {
    return false;
  }
  // callee.object must be *.Collective
  const obj = callee.object;
  if (obj.type !== 'MemberExpression') {
    return false;
  }
  const collectiveProp = obj.property;
  return collectiveProp.type === 'Identifier' && collectiveProp.name === 'Collective';
}

/**
 * Returns true for calls of the form  *.Collective.*.load*(...)
 * e.g. req.loaders.Collective.byId.load(id)
 *      req.loaders.Collective.byId.loadMany(ids)
 */
function isCollectiveLoaderCall(node) {
  if (node.type !== 'CallExpression') {
    return false;
  }
  const callee = node.callee;
  if (callee.type !== 'MemberExpression') {
    return false;
  }
  // The method must start with "load"
  const loadFn = callee.property;
  if (loadFn.type !== 'Identifier' || !loadFn.name.startsWith('load')) {
    return false;
  }
  // callee.object must be *.Collective.*  (e.g. loaders.Collective.byId)
  const loaderProp = callee.object;
  if (loaderProp.type !== 'MemberExpression') {
    return false;
  }
  // loaderProp.object must be *.Collective
  const collectiveObj = loaderProp.object;
  if (collectiveObj.type !== 'MemberExpression') {
    return false;
  }
  const collectiveProp = collectiveObj.property;
  return collectiveProp.type === 'Identifier' && collectiveProp.name === 'Collective';
}

/**
 * Returns true when an AST node is, or transitively reads from, remoteUser.
 * Handles patterns like:
 *   req.remoteUser.CollectiveId
 *   remoteUser.CollectiveId
 */
function referencesRemoteUser(node) {
  if (!node) {
    return false;
  }
  if (node.type === 'Identifier' && node.name === 'remoteUser') {
    return true;
  }
  if (node.type === 'MemberExpression') {
    if (node.property.type === 'Identifier' && node.property.name === 'remoteUser') {
      return true;
    }
    return referencesRemoteUser(node.object);
  }
  return false;
}

/**
 * Returns true when a collective loader call's first argument is derived from
 * req.remoteUser (e.g. req.remoteUser.CollectiveId). Such calls load the
 * currently-authenticated user's own account and don't need a visibility gate.
 */
function isLoadingCurrentUserAccount(node) {
  if (!isCollectiveLoaderCall(node)) {
    return false;
  }
  const firstArg = node.arguments[0];
  return firstArg ? referencesRemoteUser(firstArg) : false;
}

/**
 * Returns true for direct calls to any of the four private-accounts helpers.
 */
function isPrivateAccountsCall(node) {
  if (node.type !== 'CallExpression') {
    return false;
  }
  const callee = node.callee;
  return callee.type === 'Identifier' && PRIVATE_ACCOUNTS_HELPERS.has(callee.name);
}

/**
 * Returns true when `node` is a FunctionExpression or ArrowFunctionExpression
 * that is the direct value of an object property named `resolve`.
 */
function isResolveFunctionValue(node) {
  const parent = node.parent;
  if (!parent || parent.type !== 'Property') {
    return false;
  }
  if (parent.value !== node) {
    return false;
  }
  const key = parent.key;
  if (key.type === 'Identifier') {
    return key.name === 'resolve';
  }
  if (key.type === 'Literal') {
    return key.value === 'resolve';
  }
  return false;
}

// eslint-disable-next-line import/no-commonjs
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require GraphQL query resolvers that load Collective objects to call a visibility helper from server/lib/private-accounts.ts.',
    },
    schema: [],
    messages: {
      missingCheck:
        'This resolver loads a Collective but does not call a visibility helper ' +
        '(assertCanSeeAccount, assertCanSeeAllAccounts, canSeePrivateAccount, or canSeeAllPrivateAccounts) ' +
        'from server/lib/private-accounts.ts. ' +
        'Add the appropriate check, or use eslint-disable if the resolver is exempt (e.g. it only returns data the caller already owns).',
    },
  },
  create(context) {
    /**
     * Stack of function scopes. Each entry tracks whether the function is a
     * `resolve` property value, and whether Collective loads / privacy checks
     * were detected inside its IMMEDIATE body.
     *
     * Nested function scopes act as opaque barriers: calls inside them do not
     * affect the enclosing resolve scope.
     */
    const stack = [];

    function enterFunction(node) {
      stack.push({
        isResolve: isResolveFunctionValue(node),
        node,
        loadsCollective: false,
        checksPrivacy: false,
      });
    }

    function exitFunction() {
      const frame = stack.pop();
      if (frame && frame.isResolve && frame.loadsCollective && !frame.checksPrivacy) {
        context.report({
          node: frame.node,
          messageId: 'missingCheck',
        });
      }
    }

    return {
      FunctionExpression: enterFunction,
      ArrowFunctionExpression: enterFunction,
      'FunctionExpression:exit': exitFunction,
      'ArrowFunctionExpression:exit': exitFunction,

      CallExpression(callNode) {
        if (!stack.length) {
          return;
        }
        // Only update the innermost scope, and only when it is a resolve scope.
        // If the innermost scope is a nested function (not a resolve), calls
        // there belong to that nested scope and should not affect the outer one.
        const frame = stack[stack.length - 1];
        if (!frame.isResolve) {
          return;
        }

        if (isCollectiveFindCall(callNode)) {
          frame.loadsCollective = true;
        } else if (isCollectiveLoaderCall(callNode) && !isLoadingCurrentUserAccount(callNode)) {
          frame.loadsCollective = true;
        }

        if (isPrivateAccountsCall(callNode)) {
          frame.checksPrivacy = true;
        }
      },
    };
  },
};
