import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { roles } from '../../../../../server/constants';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

const addFundsMutation = gqlV2/* GraphQL */ `
  mutation AddFunds(
    $fromAccount: AccountReferenceInput!
    $account: AccountReferenceInput!
    $amount: AmountInput!
    $description: String!
    $hostFeePercent: Float!
  ) {
    addFunds(
      account: $account
      fromAccount: $fromAccount
      amount: $amount
      description: $description
      hostFeePercent: $hostFeePercent
    ) {
      id
      toAccount {
        id
        stats {
          balance {
            valueInCents
          }
        }
      }
    }
  }
`;

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
    it('cannot add funds as non-admin', async () => {
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.id },
          amount: { value: 20, currency: 'USD', valueInCents: 2000 },
          description: 'add funds as non-admin',
          hostFeePercent: 6,
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
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.id },
          amount: { value: 20, currency: 'USD', valueInCents: 2000 },
          description: 'add funds as admin',
          hostFeePercent: 6,
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
          account: { legacyId: collective.id },
          fromAccount: { legacyId: randomUser.id },
          amount: { value: 20, currency: 'USD', valueInCents: 2000 },
          description: 'add funds as admin',
          hostFeePercent: 6,
        },
        hostAdmin,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
    });
  });
});
