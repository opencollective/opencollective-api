import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { roles } from '../../../../../server/constants';
import { fakeCollective, fakeProject, fakeTier, fakeUser, fakeUserToken } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

const addFundsMutation = gqlV2/* GraphQL */ `
  mutation AddFunds(
    $fromAccount: AccountReferenceInput!
    $account: AccountReferenceInput!
    $amount: AmountInput!
    $description: String!
    $hostFeePercent: Float!
    $tier: TierReferenceInput
  ) {
    addFunds(
      account: $account
      fromAccount: $fromAccount
      amount: $amount
      description: $description
      hostFeePercent: $hostFeePercent
      tier: $tier
    ) {
      id
      amount {
        valueInCents
        currency
      }
      toAccount {
        id
        stats {
          balance {
            valueInCents
          }
        }
      }
      tier {
        id
        legacyId
      }
    }
  }
`;

const validMutationVariables = {
  amount: { value: 20, currency: 'USD', valueInCents: 2000 },
  description: 'add funds as admin',
  hostFeePercent: 6,
};

describe('server/graphql/v2/mutation/AddFundsMutations', () => {
  let hostAdmin, collectiveAdmin, randomUser, collective;

  before(async () => {
    await utils.resetTestDB();
    collectiveAdmin = await fakeUser();
    hostAdmin = await fakeUser();
    randomUser = await fakeUser();
    collective = await fakeCollective();
    await fakeCollective({
      id: 8686,
      slug: 'open-collective',
      HostCollectiveId: 8686,
    });

    await collective.addUserWithRole(collectiveAdmin, roles.ADMIN);
    await collective.host.addUserWithRole(hostAdmin, roles.ADMIN);
    await collectiveAdmin.populateRoles();
    await hostAdmin.populateRoles();
  });

  describe('addFunds', () => {
    it('verifies the scope', async () => {
      const userToken = await fakeUserToken({ scope: ['account'] });
      const result = await oAuthGraphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          amount: { value: 20, currency: 'USD', valueInCents: 2000 },
          description: 'add funds as non-admin',
          hostFeePercent: 6,
        },
        userToken,
        randomUser,
      );
      expect(result.errors[0]).to.eq('The User Token is not allowed for operations in scope "host".');
    });

    it('cannot add funds as non-admin', async () => {
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          ...validMutationVariables,
        },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Only an site admin or collective host admin can add fund/);
    });

    it('cannot add funds as a collective admin (not host admin)', async () => {
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          ...validMutationVariables,
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
        },
        collectiveAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(
        /You don't have enough permissions to use this payment method \(you need to be an admin of the collective that owns this payment method\)/,
      );
    });

    it('can add funds as host admin', async () => {
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          ...validMutationVariables,
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
        },
        hostAdmin,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
      expect(result.data.addFunds.amount.currency).to.equal('USD');
    });

    it('can add funds as host admin with authorization', async () => {
      const userToken = await fakeUserToken({ scope: ['host'] });
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.CollectiveId },
          amount: { value: 20, currency: 'USD', valueInCents: 2000 },
          description: 'add funds as admin',
          hostFeePercent: 6,
        },
        userToken,
        hostAdmin,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
      expect(result.data.addFunds.amount.currency).to.equal('USD');
    });

    describe('add funds from a collective', () => {
      it('is not allowed by default', async () => {
        const fromCollective = await fakeCollective({ HostCollectiveId: collective.HostCollectiveId });
        const toCollective = await fakeCollective({ HostCollectiveId: collective.HostCollectiveId });
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: toCollective.id },
            fromAccount: { legacyId: fromCollective.id },
          },
          hostAdmin,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(
          /Adding funds is only possible from the following types: USER,ORGANIZATION/,
        );
      });

      it('can be done if the target account is a parent', async () => {
        const fromCollective = await fakeCollective({ HostCollectiveId: collective.HostCollectiveId });
        const toCollective = await fakeProject({
          HostCollectiveId: collective.HostCollectiveId,
          ParentCollectiveId: fromCollective.id,
        });
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: toCollective.id },
            fromAccount: { legacyId: fromCollective.id },
          },
          hostAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
        expect(result.data.addFunds.amount.currency).to.equal('USD');
      });

      it('can be done if the target account is a child', async () => {
        const toCollective = await fakeCollective({ HostCollectiveId: collective.HostCollectiveId });
        const fromCollective = await fakeProject({
          HostCollectiveId: collective.HostCollectiveId,
          ParentCollectiveId: toCollective.id,
        });
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            ...validMutationVariables,
            account: { legacyId: toCollective.id },
            fromAccount: { legacyId: fromCollective.id },
          },
          hostAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addFunds.amount.valueInCents).to.equal(2000);
        expect(result.data.addFunds.amount.currency).to.equal('USD');
      });
    });

    describe('add funds to a specific tier', () => {
      it('works with valid params', async () => {
        const tier = await fakeTier({ CollectiveId: collective.id });
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            fromAccount: { legacyId: randomUser.CollectiveId },
            account: { legacyId: collective.id },
            tier: { legacyId: tier.id },
            amount: { value: 20, currency: 'USD', valueInCents: 2000 },
            description: 'add funds to tier as admin',
            hostFeePercent: 6,
          },
          hostAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.addFunds.tier.legacyId).to.equal(tier.id);

        // Should create a member with the right tier
        const members = await collective.getMembers({ where: { TierId: tier.id } });
        expect(members).to.have.length(1);
        expect(members[0].MemberCollectiveId).to.equal(randomUser.CollectiveId);
      });

      it('must belong to account', async () => {
        const tier = await fakeTier(); // Tier outside of collective
        const result = await graphqlQueryV2(
          addFundsMutation,
          {
            fromAccount: { legacyId: randomUser.CollectiveId },
            account: { legacyId: collective.id },
            tier: { legacyId: tier.id },
            amount: { value: 20, currency: 'USD', valueInCents: 2000 },
            description: 'add funds to tier as admin',
            hostFeePercent: 6,
          },
          hostAdmin,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/Tier #\d is not part of collective #\d/);
      });
    });
  });
});
