import { expect } from 'chai';

import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import { fakeCollective, fakePayoutMethod, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

describe('server/graphql/v2/mutation/PayoutMethodMutations', () => {
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

    beforeEach(utils.resetTestDB);

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

  describe('removePayoutMethod', () => {
    const removePayoutMethodMutation = `
      mutation removePayoutMethod($id: String!) {
        removePayoutMethod(payoutMethodId: $id) {
          id
          data
          name
          type
          isSaved
        }
      }
    `;

    let adminUser, randomUser, payoutMethod;
    let mutationArgs;

    before(async () => {
      adminUser = await fakeUser();
      randomUser = await fakeUser();
      payoutMethod = await fakePayoutMethod({ CollectiveId: adminUser.CollectiveId, isSaved: true });
      mutationArgs = { id: idEncode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) };
    });

    it('Must be authenticated', async () => {
      const result = await graphqlQueryV2(removePayoutMethodMutation, mutationArgs, null);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('You need to be authenticated to perform this action');
    });

    it("Must be admin of the payout method's collective", async () => {
      const result = await graphqlQueryV2(removePayoutMethodMutation, mutationArgs, randomUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
    });

    it('Removes the payout method', async () => {
      expect(payoutMethod.isSaved).to.be.true;
      const result = await graphqlQueryV2(removePayoutMethodMutation, mutationArgs, adminUser);
      expect(result.errors).to.not.exist;
      expect(result.data.removePayoutMethod.isSaved).to.be.false;
      await payoutMethod.reload();
      expect(payoutMethod.isSaved).to.be.false;
    });
  });
});
