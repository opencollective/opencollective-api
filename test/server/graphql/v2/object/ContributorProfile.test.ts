import { expect } from 'chai';
import gql from 'fake-tag';

import { SupportedCurrency } from '../../../../../server/constants/currencies';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import {
  fakeActiveHost,
  fakeCollective,
  fakeIncognitoProfile,
  fakeMember,
  fakeOrganization,
  fakeTransaction,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const query = gql`
  query Account($slug: String!, $collectiveSlug: String!) {
    account(slug: $slug) {
      id
      legacyId
      slug
      ... on Individual {
        contributorProfiles(forAccount: { slug: $collectiveSlug }) {
          account {
            id
            name
            legacyId
            slug
            type
            isIncognito
            ... on Individual {
              email
              isGuest
            }
          }
          totalContributedToHost(inCollectiveCurrency: true) {
            valueInCents
            currency
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/ContributorProfile', () => {
  let user, collective, incognitoCollective;
  before(async () => {
    collective = await fakeCollective();
    user = await fakeUser();
    incognitoCollective = await fakeIncognitoProfile(user);
    await fakeTransaction(
      {
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: collective.HostCollectiveId,
        amount: 10000,
        kind: TransactionKind.CONTRIBUTION,
      },
      { createDoubleEntry: true },
    );
  });

  it('should return empty list if the request is not from the actual user', async () => {
    const result = await graphqlQueryV2(query, { slug: user.collective.slug, collectiveSlug: collective.slug });
    expect(result.data.account.contributorProfiles).to.be.empty;
  });

  it('should return individual and incognito profiles', async () => {
    const result = await graphqlQueryV2(query, { slug: user.collective.slug, collectiveSlug: collective.slug }, user);
    expect(result.data.account.contributorProfiles).to.containSubset([
      { account: { type: 'INDIVIDUAL', isIncognito: false } },
      { account: { type: 'INDIVIDUAL', isIncognito: true } },
    ]);
  });

  it('should return the total amount contributed to the host by this contributor', async () => {
    const result = await graphqlQueryV2(query, { slug: user.collective.slug, collectiveSlug: collective.slug }, user);
    expect(result.data.account.contributorProfiles).to.containSubset([
      { account: { type: 'INDIVIDUAL', isIncognito: false }, totalContributedToHost: { valueInCents: 10000 } },
    ]);
  });

  it('should contain the summed contributed amount between INDIVIDUAL and INCOGNITO profiles', async () => {
    let result = await graphqlQueryV2(query, { slug: user.collective.slug, collectiveSlug: collective.slug }, user);
    expect(result.data.account.contributorProfiles).to.containSubset([
      { account: { type: 'INDIVIDUAL', isIncognito: false }, totalContributedToHost: { valueInCents: 10000 } },
      { account: { type: 'INDIVIDUAL', isIncognito: true }, totalContributedToHost: { valueInCents: 10000 } },
    ]);

    await fakeTransaction(
      {
        CollectiveId: collective.id,
        FromCollectiveId: incognitoCollective.id,
        HostCollectiveId: collective.HostCollectiveId,
        amount: 5000,
        kind: TransactionKind.CONTRIBUTION,
      },
      { createDoubleEntry: true },
    );

    result = await graphqlQueryV2(query, { slug: user.collective.slug, collectiveSlug: collective.slug }, user);
    expect(result.data.account.contributorProfiles).to.containSubset([
      { account: { type: 'INDIVIDUAL', isIncognito: false }, totalContributedToHost: { valueInCents: 15000 } },
      { account: { type: 'INDIVIDUAL', isIncognito: true }, totalContributedToHost: { valueInCents: 15000 } },
    ]);
  });

  it('should only count transactions in the current host currency', async () => {
    const host = await fakeActiveHost({ currency: 'EUR' });
    const eurCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'EUR' });
    const contributor = await fakeUser();
    const contribute = (hostCurrency: SupportedCurrency, amount: number) =>
      fakeTransaction(
        {
          CollectiveId: eurCollective.id,
          FromCollectiveId: contributor.collective.id,
          HostCollectiveId: host.id,
          amount,
          currency: hostCurrency,
          hostCurrency,
          kind: TransactionKind.CONTRIBUTION,
        },
        { createDoubleEntry: true },
      );

    // Contributions received before the host switched from USD to EUR must be ignored
    await contribute('USD', 7000);
    await contribute('EUR', 3000);
    await contribute('USD', 1000);

    const result = await graphqlQueryV2(
      query,
      { slug: contributor.collective.slug, collectiveSlug: eurCollective.slug },
      contributor,
    );
    expect(result.data.account.contributorProfiles).to.containSubset([
      {
        account: { legacyId: contributor.collective.id },
        totalContributedToHost: { valueInCents: 3000, currency: 'EUR' },
      },
    ]);
  });

  it('should include contributions from organizations', async () => {
    const org = await fakeOrganization();
    await fakeMember({ CollectiveId: org.id, MemberCollectiveId: user.collective.id });
    const result = await graphqlQueryV2(query, { slug: user.collective.slug, collectiveSlug: collective.slug }, user);
    expect(result.data.account.contributorProfiles).to.containSubset([
      { account: { legacyId: org.id, type: 'ORGANIZATION' } },
    ]);
  });
});
