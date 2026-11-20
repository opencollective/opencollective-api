/**
 * Typed access to the GraphQL v1 authentication gate.
 *
 * The rule itself is written in Bend (`./graphql-v1-auth.bend`), where it is proven to obey the laws in
 * `/LAWS.bend`, and compiled to `./generated/graphql-v1-auth.mjs`. This file only translates values at the boundary:
 * it must never decide anything. See `docs/bend-laws.md`.
 */

/* eslint-disable camelcase -- field names are the ones declared in the Bend source */

import generatedKernel from './generated/graphql-v1-auth.mjs';
import { toBendBool } from './interop';

export type GraphqlV1AuthFacts = {
  /** The request carries an OAuth access token */
  hasOAuthToken: boolean;
  /** The application of that token has `data.enableGraphqlV1` */
  isOAuthApplicationAllowListed: boolean;
  /** The request carries a personal token */
  hasPersonalToken: boolean;
  /** That personal token has `data.allowGraphQLV1` */
  isPersonalTokenAllowListed: boolean;
};

/** Mirrors `Verdict` in `graphql-v1-auth.bend` */
const GRAPHQL_V1_AUTH_VERDICTS = ['Accept', 'RejectOAuthToken', 'RejectPersonalToken'] as const;

export type GraphqlV1AuthVerdict = (typeof GRAPHQL_V1_AUTH_VERDICTS)[number];

/** Exposed for the test that keeps these names in sync with the Bend source */
export const BEND_GRAPHQL_V1_AUTH_NAMES = { Verdict: GRAPHQL_V1_AUTH_VERDICTS };

const kernel = generatedKernel as { gate: (request: unknown) => { $: string } };

/** Whether GraphQL v1 accepts the way this request is authenticated */
export const decideGraphqlV1Auth = (facts: GraphqlV1AuthFacts): GraphqlV1AuthVerdict => {
  const verdict = kernel.gate({
    $: 'Request',
    oauth_token: toBendBool(facts.hasOAuthToken, 'hasOAuthToken'),
    oauth_app_allow_listed: toBendBool(facts.isOAuthApplicationAllowListed, 'isOAuthApplicationAllowListed'),
    personal_token: toBendBool(facts.hasPersonalToken, 'hasPersonalToken'),
    personal_token_allow_listed: toBendBool(facts.isPersonalTokenAllowListed, 'isPersonalTokenAllowListed'),
  });

  if (!GRAPHQL_V1_AUTH_VERDICTS.includes(verdict.$ as GraphqlV1AuthVerdict)) {
    throw new Error(`Unexpected verdict from the GraphQL v1 auth kernel: ${JSON.stringify(verdict)}`);
  }

  return verdict.$ as GraphqlV1AuthVerdict;
};
