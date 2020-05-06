import { expect } from 'chai';

import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

describe('server/graphql/v2/mutation/PayoutMethodMutations', () => {
  beforeEach(utils.resetTestDB);

  describe('createPayoutMethod', () => {
    const createPayoutMethodMutation = `
      mutation createPayoutMethod($payoutMethod: PayoutMethodInput!, $account: AccountReferenceInput!) {
        createPayoutMethod(payoutMethod: $payoutMethod, account: $account) {
          data
          id
          name
          type
        }
      }
    `;

    let user, collective;
    beforeEach(async () => {
      user = await fakeUser();
      collective = await fakeCollective({
        admin: user.collective,
      });
    });

    it('should create a new payout method', async () => {
      const payoutMethod = {
        name: 'Test Bank',
        type: PayoutMethodTypes.BANK_ACCOUNT,
        data: {
          accountHolderName: 'Nicolas Cage',
          currency: 'EUR',
          type: 'IBAN',
          details: {
            iban: 'FR893219828398123',
          },
        },
      };

      const result = await graphqlQueryV2(
        createPayoutMethodMutation,
        {
          payoutMethod,
          account: { legacyId: collective.id },
        },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;
      expect(result.data.createPayoutMethod).to.deep.include(payoutMethod);
    });

    it('should upsert a existing payout method if data.isManualBankTransfer is passed', async () => {
      const payoutMethod = {
        name: 'Test Bank',
        type: PayoutMethodTypes.BANK_ACCOUNT,
        data: {
          isManualBankTransfer: true,
          accountHolderName: 'Nicolas Cage',
          currency: 'EUR',
          type: 'IBAN',
          details: {
            iban: 'FR893219828398123',
          },
        },
      };

      await graphqlQueryV2(
        createPayoutMethodMutation,
        {
          payoutMethod,
          account: { legacyId: collective.id },
        },
        user,
      );

      const updatedPayoutMethod = {
        ...payoutMethod,
        name: 'New Bank Account',
        data: {
          ...payoutMethod.data,
          accountHolderName: 'John Malkovich',
        },
      };

      const result = await graphqlQueryV2(
        createPayoutMethodMutation,
        {
          payoutMethod: updatedPayoutMethod,
          account: { legacyId: collective.id },
        },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;
      expect(result.data.createPayoutMethod).to.deep.include(updatedPayoutMethod);

      const existingPayoutMethods = await collective.getPayoutMethods();
      expect(existingPayoutMethods).to.have.length(1);
    });
  });
});
