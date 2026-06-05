import type { GraphQLFieldConfig, GraphQLFieldResolver } from 'graphql';
import { Kind } from 'graphql/language';
import type { ConstDirectiveNode, ConstValueNode, FieldDefinitionNode } from 'graphql/language/ast';

import OAuthScopes from '../../constants/oauth-scopes';
import { Forbidden, Unauthorized } from '../errors';

import { enforceScope } from './scope-check';

type OAuthScope = keyof typeof OAuthScopes;

export type ProtectedFieldAccessControl = {
  scopes: OAuthScope[];
  requiresAuthentication: boolean;
  forbidOAuth?: boolean;
  forbidPersonalTokens?: boolean;
};

type ResolvedProtectedFieldAccessControl = {
  scopes: OAuthScope[];
  requiresAuthentication: boolean;
  forbidOAuth: boolean;
  forbidPersonalTokens: boolean;
};

const REQUIRES_OAUTH_SCOPE_DIRECTIVE = 'requiresOAuthScope';

function resolveAccessControl(access: ProtectedFieldAccessControl): ResolvedProtectedFieldAccessControl {
  return {
    scopes: access.scopes,
    requiresAuthentication: access.requiresAuthentication,
    forbidOAuth: access.forbidOAuth ?? false,
    forbidPersonalTokens: access.forbidPersonalTokens ?? false,
  };
}

function buildStringListValue(scopes: OAuthScope[]): ConstValueNode {
  return {
    kind: Kind.LIST,
    values: scopes.map(scope => ({
      kind: Kind.STRING,
      value: scope,
    })),
  };
}

function buildRequiresOAuthScopeDirectiveNode(scopes: OAuthScope[]): ConstDirectiveNode {
  return {
    kind: Kind.DIRECTIVE,
    name: { kind: Kind.NAME, value: REQUIRES_OAUTH_SCOPE_DIRECTIVE },
    arguments: [
      {
        kind: Kind.ARGUMENT,
        name: { kind: Kind.NAME, value: 'scopes' },
        value: buildStringListValue(scopes),
      },
    ],
  };
}

function buildFieldAstNode(fieldName: string, scopes: OAuthScope[]): FieldDefinitionNode {
  return {
    kind: Kind.FIELD_DEFINITION,
    name: { kind: Kind.NAME, value: fieldName },
    type: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: 'Transaction' } },
    directives: scopes.length > 0 ? [buildRequiresOAuthScopeDirectiveNode(scopes)] : [],
  };
}

function enforceAccessControl(req: Express.Request, access: ResolvedProtectedFieldAccessControl): void {
  if (access.forbidOAuth && req.userToken) {
    throw new Forbidden('OAuth tokens cannot be used for this operation.');
  }

  if (access.forbidPersonalTokens && req.personalToken) {
    throw new Forbidden('Personal tokens cannot be used for this operation.');
  }

  if (access.requiresAuthentication && !req.remoteUser) {
    throw new Unauthorized('You need to be logged in.');
  }

  for (const scope of access.scopes) {
    enforceScope(req, scope);
  }
}

function withAccessControl<TSource>(
  access: ResolvedProtectedFieldAccessControl,
  resolve: GraphQLFieldResolver<TSource, Express.Request>,
): GraphQLFieldResolver<TSource, Express.Request> {
  return async (source, args, req, info) => {
    enforceAccessControl(req, access);
    return resolve(source, args, req, info);
  };
}

/**
 * Declares access control requirements on a GraphQL field and enforces them at runtime.
 *
 * - `requiresAuthentication`: reject unauthenticated callers
 * - `scopes`: OAuth/personal token scope requirements (session auth is unaffected)
 * - `forbidOAuth` / `forbidPersonalTokens`: reject specific token auth methods
 * - Attaches `@requiresOAuthScope` on the field AST when scopes are declared
 */
export function defineProtectedField<TSource = unknown>(
  fieldName: string,
  access: ProtectedFieldAccessControl,
  config: GraphQLFieldConfig<TSource, Express.Request>,
): GraphQLFieldConfig<TSource, Express.Request> {
  const { resolve, ...rest } = config;
  const resolvedAccess = resolveAccessControl(access);

  if (!resolve) {
    throw new Error(`defineProtectedField: field "${fieldName}" must define a resolve function`);
  }

  return {
    ...rest,
    extensions: {
      ...rest.extensions,
      accessControl: resolvedAccess,
    },
    astNode: buildFieldAstNode(fieldName, resolvedAccess.scopes),
    resolve: withAccessControl(resolvedAccess, resolve),
  };
}
