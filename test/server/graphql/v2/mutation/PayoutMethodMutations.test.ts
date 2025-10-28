import { expect } from 'chai';
import gql from 'fake-tag';

import { idDecode, idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import { fakeCollective, fakeExpense, fakePayoutMethod, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

describe('server/graphql/v2/mutation/PayoutMethodMutations', () => {
  describe('createPayoutMethod', () => {
    const createPayoutMethodMutation = gql`
      mutation CreatePayoutMethod($payoutMethod: PayoutMethodInput!, $account: AccountReferenceInput!) {
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
    const removePayoutMethodMutation = gql`
      mutation RemovePayoutMethod($id: String!) {
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
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it("Must be admin of the payout method's collective", async () => {
      const result = await graphqlQueryV2(removePayoutMethodMutation, mutationArgs, randomUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
    });

    it('Archives the payout method if it was already used', async () => {
      expect(payoutMethod.isSaved).to.be.true;
      await fakeExpense({ PayoutMethodId: payoutMethod.id, status: 'PAID' });
      const result = await graphqlQueryV2(removePayoutMethodMutation, mutationArgs, adminUser);
      expect(result.errors).to.not.exist;
      expect(result.data.removePayoutMethod.isSaved).to.be.false;
      await payoutMethod.reload();
      expect(payoutMethod.isSaved).to.be.false;
    });

    it('Deletes the payout method if it never used', async () => {
      const payoutMethod = await fakePayoutMethod({ CollectiveId: adminUser.CollectiveId, isSaved: true });
      const mutationArgs = { id: idEncode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) };

      expect(payoutMethod.isSaved).to.be.true;
      const result = await graphqlQueryV2(removePayoutMethodMutation, mutationArgs, adminUser);
      expect(result.errors).to.not.exist;
      await payoutMethod.reload({ paranoid: false });
      expect(payoutMethod.deletedAt).to.not.be.null;
    });

    it('Prevents removing STRIPE payout method', async () => {
      const payoutMethod = await fakePayoutMethod({
        CollectiveId: adminUser.CollectiveId,
        isSaved: true,
        type: PayoutMethodTypes.STRIPE,
      });
      const mutationArgs = { id: idEncode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) };

      expect(payoutMethod.isSaved).to.be.true;
      const result = await graphqlQueryV2(removePayoutMethodMutation, mutationArgs, adminUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eql('You are authenticated but forbidden to perform this action');
      await payoutMethod.reload({ paranoid: false });
      expect(payoutMethod.deletedAt).to.be.null;
    });
  });

  describe('editPayoutMethod', () => {
    const editPayoutMethodMutation = gql`
      mutation EditPayoutMethod($payoutMethod: PayoutMethodInput!) {
        editPayoutMethod(payoutMethod: $payoutMethod) {
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
      mutationArgs = {
        payoutMethod: { id: idEncode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD), name: 'New Name' },
      };
    });

    it('Must be authenticated', async () => {
      const result = await graphqlQueryV2(editPayoutMethodMutation, mutationArgs, null);
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it("Must be admin of the payout method's collective", async () => {
      const result = await graphqlQueryV2(editPayoutMethodMutation, mutationArgs, randomUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
    });

    it('Updates the payout method if it was never used', async () => {
      const result = await graphqlQueryV2(editPayoutMethodMutation, mutationArgs, adminUser);
      expect(result.errors).to.not.exist;

      await payoutMethod.reload();
      expect(payoutMethod.name).to.equal('New Name');
      expect(result.data.editPayoutMethod.id).to.equal(mutationArgs.payoutMethod.id);
    });

    it('Updates the payout method if it is only associated with pending expenses', async () => {
      mutationArgs.payoutMethod.name = 'IBAN 123';
      await fakeExpense({ PayoutMethodId: payoutMethod.id, status: 'PENDING' });
      const result = await graphqlQueryV2(editPayoutMethodMutation, mutationArgs, adminUser);
      expect(result.errors).to.not.exist;

      await payoutMethod.reload();
      expect(payoutMethod.name).to.equal('IBAN 123');
      expect(result.data.editPayoutMethod.id).to.equal(mutationArgs.payoutMethod.id);
    });

    it('Creates a new payout method and archive existing one if already associated with an expense', async () => {
      mutationArgs.payoutMethod.name = 'Offshore Bank';
      const oldExpense = await fakeExpense({ PayoutMethodId: payoutMethod.id, status: 'PAID' });
      const pendingExpense = await fakeExpense({ PayoutMethodId: payoutMethod.id, status: 'PENDING' });
      const result = await graphqlQueryV2(editPayoutMethodMutation, mutationArgs, adminUser);
      expect(result.errors).to.not.exist;

      await payoutMethod.reload();
      expect(result.data.editPayoutMethod.name).to.equal('Offshore Bank');
      expect(result.data.editPayoutMethod.data).to.deep.include(payoutMethod.data);
      expect(result.data.editPayoutMethod.id).to.not.equal(mutationArgs.payoutMethod.id);

      await oldExpense.reload();
      expect(oldExpense.PayoutMethodId).to.equal(payoutMethod.id);

      await pendingExpense.reload();
      expect(pendingExpense.PayoutMethodId).to.equal(
        idDecode(result.data.editPayoutMethod.id, IDENTIFIER_TYPES.EXPENSE),
      );
    });

    it('Prevents editing STRIPE payout method', async () => {
      const payoutMethod = await fakePayoutMethod({
        CollectiveId: adminUser.CollectiveId,
        type: PayoutMethodTypes.STRIPE,
        isSaved: true,
      });
      const mutationArgs = {
        payoutMethod: { id: idEncode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD), name: 'New Name' },
      };
      const result = await graphqlQueryV2(editPayoutMethodMutation, mutationArgs, adminUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eql('You are authenticated but forbidden to perform this action');
    });
  });
});
