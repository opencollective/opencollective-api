import { expect } from 'chai';

import {
  BEND_GRAPHQL_V1_AUTH_NAMES,
  decideGraphqlV1Auth,
  GraphqlV1AuthFacts,
  GraphqlV1AuthVerdict,
} from '../../../server/bend/graphql-v1-auth';
import { getBendConstructorNames } from '../../test-helpers/bend';

/**
 * The laws in `LAWS.bend` are proven on the Bend source, by `npm run bend:check`. These tests cover what the proofs
 * do not: the compilation to JavaScript and the TypeScript boundary.
 */
describe('server/bend/graphql-v1-auth', () => {
  const BOOLEANS = [true, false];

  const ALL_FACTS: GraphqlV1AuthFacts[] = BOOLEANS.flatMap(hasOAuthToken =>
    BOOLEANS.flatMap(isOAuthApplicationAllowListed =>
      BOOLEANS.flatMap(hasPersonalToken =>
        BOOLEANS.map(isPersonalTokenAllowListed => ({
          hasOAuthToken,
          isOAuthApplicationAllowListed,
          hasPersonalToken,
          isPersonalTokenAllowListed,
        })),
      ),
    ),
  );

  // The rule as it was written in the `/graphql/v1` middleware before it moved to Bend
  const reference = (facts: GraphqlV1AuthFacts): GraphqlV1AuthVerdict => {
    if (facts.hasOAuthToken && !facts.isOAuthApplicationAllowListed) {
      return 'RejectOAuthToken';
    } else if (facts.hasPersonalToken && !facts.isPersonalTokenAllowListed) {
      return 'RejectPersonalToken';
    } else {
      return 'Accept';
    }
  };

  it('uses the verdicts declared in graphql-v1-auth.bend', () => {
    expect(BEND_GRAPHQL_V1_AUTH_NAMES.Verdict).to.have.members(
      getBendConstructorNames('graphql-v1-auth.bend', 'Verdict'),
    );
  });

  it('decides like the previous TypeScript rule, for every combination of facts', () => {
    expect(ALL_FACTS).to.have.length(16);
    for (const facts of ALL_FACTS) {
      expect(decideGraphqlV1Auth(facts), JSON.stringify(facts)).to.equal(reference(facts));
    }
  });

  it('accepts requests without tokens, and tokens that are allow-listed', () => {
    const noToken = {
      hasOAuthToken: false,
      isOAuthApplicationAllowListed: false,
      hasPersonalToken: false,
      isPersonalTokenAllowListed: false,
    };
    expect(decideGraphqlV1Auth(noToken)).to.equal('Accept');
    expect(decideGraphqlV1Auth({ ...noToken, hasOAuthToken: true })).to.equal('RejectOAuthToken');
    expect(decideGraphqlV1Auth({ ...noToken, hasOAuthToken: true, isOAuthApplicationAllowListed: true })).to.equal(
      'Accept',
    );
    expect(decideGraphqlV1Auth({ ...noToken, hasPersonalToken: true })).to.equal('RejectPersonalToken');
    expect(decideGraphqlV1Auth({ ...noToken, hasPersonalToken: true, isPersonalTokenAllowListed: true })).to.equal(
      'Accept',
    );
  });

  it('refuses facts that are not booleans rather than reading them as false', () => {
    const facts = { ...ALL_FACTS[0], hasOAuthToken: undefined };
    expect(() => decideGraphqlV1Auth(facts)).to.throw('"hasOAuthToken" must be a boolean');
  });
});
