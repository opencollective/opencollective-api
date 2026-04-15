import { expect } from 'chai';
import gql from 'fake-tag';
import { createSandbox } from 'sinon';

import { idDecode, idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import * as kycExpensesCheck from '../../../../../server/lib/kyc/expenses/kyc-expenses-check';
import { EntityPublicId, EntityShortIdPrefix } from '../../../../../server/lib/permalink/entity-map';
import { PayoutMethodTypes, PaypalPayoutMethodData } from '../../../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakePayoutMethod,
  fakeUser,
} from '../../../../test-helpers/fake-data';
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

    it('accepts publicId when removing a payout method', async () => {
      const payoutMethod = await fakePayoutMethod({ CollectiveId: adminUser.CollectiveId, isSaved: true });
      const publicId =
        `${EntityShortIdPrefix.PayoutMethod}_${payoutMethod.id}` as EntityPublicId<EntityShortIdPrefix.PayoutMethod>;
      await payoutMethod.update({ publicId });

      const result = await graphqlQueryV2(removePayoutMethodMutation, { id: publicId }, adminUser);

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      await payoutMethod.reload({ paranoid: false });
      expect(payoutMethod.deletedAt).to.not.be.null;
    });

    describe('PayPal OAuth disconnection', () => {
      let paypalAdminUser;

      before(async () => {
        paypalAdminUser = await fakeUser();
      });

      it('soft-deletes the linked ConnectedAccount when archiving (payout method has been used)', async () => {
        const connectedAccount = await fakeConnectedAccount({
          service: 'paypal',
          CollectiveId: paypalAdminUser.CollectiveId,
          token: 'paypal-access-token',
          refreshToken: 'paypal-refresh-token',
        });
        const pm = await fakePayoutMethod({
          CollectiveId: paypalAdminUser.CollectiveId,
          type: PayoutMethodTypes.PAYPAL,
          isSaved: true,
          data: {
            email: 'user@paypal.com',
            currency: 'USD',
            isPayPalOAuth: true,
            verifiedAt: new Date().toISOString(),
            connectedAccountId: connectedAccount.id,
            // eslint-disable-next-line camelcase
            paypalUserInfo: { payer_id: 'PAYERID123' },
          },
        });
        await fakeExpense({ PayoutMethodId: pm.id, status: 'PAID' });

        const result = await graphqlQueryV2(
          removePayoutMethodMutation,
          { id: idEncode(pm.id, IDENTIFIER_TYPES.PAYOUT_METHOD) },
          paypalAdminUser,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.removePayoutMethod.isSaved).to.be.false;

        await connectedAccount.reload({ paranoid: false });
        expect(connectedAccount.deletedAt).to.not.be.null;

        // PayoutMethod data (verification status, email, payee ID) is preserved
        await pm.reload({ paranoid: false });
        const paypalData = pm.data as PaypalPayoutMethodData;
        expect(paypalData.verifiedAt).to.exist;
        expect(paypalData.email).to.equal('user@paypal.com');
        expect(paypalData.connectedAccountId).to.equal(connectedAccount.id);
      });

      it('soft-deletes the linked ConnectedAccount when hard-deleting (payout method never used)', async () => {
        const connectedAccount = await fakeConnectedAccount({
          service: 'paypal',
          CollectiveId: paypalAdminUser.CollectiveId,
          token: 'paypal-access-token',
          refreshToken: 'paypal-refresh-token',
        });
        const pm = await fakePayoutMethod({
          CollectiveId: paypalAdminUser.CollectiveId,
          type: PayoutMethodTypes.PAYPAL,
          isSaved: true,
          data: {
            email: 'user@paypal.com',
            currency: 'USD',
            isPayPalOAuth: true,
            verifiedAt: new Date().toISOString(),
            connectedAccountId: connectedAccount.id,
          },
        });

        const result = await graphqlQueryV2(
          removePayoutMethodMutation,
          { id: idEncode(pm.id, IDENTIFIER_TYPES.PAYOUT_METHOD) },
          paypalAdminUser,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        await pm.reload({ paranoid: false });
        expect(pm.deletedAt).to.not.be.null;

        await connectedAccount.reload({ paranoid: false });
        expect(connectedAccount.deletedAt).to.not.be.null;
      });

      it('does not fail for non-OAuth PayPal payout methods (no connectedAccountId)', async () => {
        const pm = await fakePayoutMethod({
          CollectiveId: paypalAdminUser.CollectiveId,
          type: PayoutMethodTypes.PAYPAL,
          isSaved: true,
          data: {
            email: 'manual@paypal.com',
            currency: 'USD',
          },
        });

        const result = await graphqlQueryV2(
          removePayoutMethodMutation,
          { id: idEncode(pm.id, IDENTIFIER_TYPES.PAYOUT_METHOD) },
          paypalAdminUser,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        await pm.reload({ paranoid: false });
        expect(pm.deletedAt).to.not.be.null;
      });
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

    it('accepts publicId when editing a payout method', async () => {
      const publicId = `${EntityShortIdPrefix.PayoutMethod}_${payoutMethod.id}`;
      await payoutMethod.update({ publicId });

      const result = await graphqlQueryV2(
        editPayoutMethodMutation,
        {
          payoutMethod: { id: publicId, name: 'PublicId Name' },
        },
        adminUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      await payoutMethod.reload();
      expect(payoutMethod.name).to.equal('PublicId Name');
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

    it('Rejects setting isSaved true on an archived payout method (restore via edit)', async () => {
      const archivedPayoutMethod = await fakePayoutMethod({
        CollectiveId: adminUser.CollectiveId,
        isSaved: false,
        name: 'Archived Bank',
      });
      await fakeExpense({ PayoutMethodId: archivedPayoutMethod.id, status: 'PAID' });
      const mutationArgs = {
        payoutMethod: {
          id: idEncode(archivedPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD),
          isSaved: true,
        },
      };
      const result = await graphqlQueryV2(editPayoutMethodMutation, mutationArgs, adminUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Archived payout methods cannot be restored');
      await archivedPayoutMethod.reload();
      expect(archivedPayoutMethod.isSaved).to.be.false;
    });

    describe('isPayPalOAuth (verified PayPal accounts)', () => {
      const paypalOAuthData = {
        email: 'verified-oauth@paypal.com',
        currency: 'USD',
        isPayPalOAuth: true,
      };

      it('allows editing name', async () => {
        const pm = await fakePayoutMethod({
          CollectiveId: adminUser.CollectiveId,
          type: PayoutMethodTypes.PAYPAL,
          data: paypalOAuthData,
          isSaved: true,
          name: 'Original Name',
        });
        const result = await graphqlQueryV2(
          editPayoutMethodMutation,
          {
            payoutMethod: {
              id: idEncode(pm.id, IDENTIFIER_TYPES.PAYOUT_METHOD),
              name: 'Updated PayPal Name',
            },
          },
          adminUser,
        );
        expect(result.errors).to.not.exist;
        expect(result.data.editPayoutMethod.name).to.equal('Updated PayPal Name');
        await pm.reload();
        expect(pm.name).to.equal('Updated PayPal Name');
      });

      it('allows editing isSaved', async () => {
        const pm = await fakePayoutMethod({
          CollectiveId: adminUser.CollectiveId,
          type: PayoutMethodTypes.PAYPAL,
          data: paypalOAuthData,
          isSaved: true,
          name: 'My PayPal',
        });
        const result = await graphqlQueryV2(
          editPayoutMethodMutation,
          {
            payoutMethod: {
              id: idEncode(pm.id, IDENTIFIER_TYPES.PAYOUT_METHOD),
              isSaved: false,
            },
          },
          adminUser,
        );
        expect(result.errors).to.not.exist;
        expect(result.data.editPayoutMethod.isSaved).to.be.false;
        await pm.reload();
        expect(pm.isSaved).to.be.false;
      });

      it('allows editing currency in data', async () => {
        const pm = await fakePayoutMethod({
          CollectiveId: adminUser.CollectiveId,
          type: PayoutMethodTypes.PAYPAL,
          data: paypalOAuthData,
          isSaved: true,
          name: 'My PayPal',
        });
        const result = await graphqlQueryV2(
          editPayoutMethodMutation,
          {
            payoutMethod: {
              id: idEncode(pm.id, IDENTIFIER_TYPES.PAYOUT_METHOD),
              data: {
                ...paypalOAuthData,
                currency: 'EUR',
              },
            },
          },
          adminUser,
        );
        expect(result.errors).to.not.exist;
        expect(result.data.editPayoutMethod.data.currency).to.equal('EUR');
        await pm.reload();
        expect((pm.data as { currency?: string }).currency).to.equal('EUR');
      });

      it('rejects editing email in data', async () => {
        const pm = await fakePayoutMethod({
          CollectiveId: adminUser.CollectiveId,
          type: PayoutMethodTypes.PAYPAL,
          data: paypalOAuthData,
          isSaved: true,
          name: 'My PayPal',
        });
        const result = await graphqlQueryV2(
          editPayoutMethodMutation,
          {
            payoutMethod: {
              id: idEncode(pm.id, IDENTIFIER_TYPES.PAYOUT_METHOD),
              data: {
                ...paypalOAuthData,
                email: 'different@paypal.com',
              },
            },
          },
          adminUser,
        );
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.include(
          'Verified PayPal accounts can only be edited to change the name, saved status and currency',
        );
        await pm.reload();
        expect((pm.data as { email?: string }).email).to.equal('verified-oauth@paypal.com');
      });

      it('rejects editing isPayPalOAuth flag in data', async () => {
        const pm = await fakePayoutMethod({
          CollectiveId: adminUser.CollectiveId,
          type: PayoutMethodTypes.PAYPAL,
          data: paypalOAuthData,
          isSaved: true,
          name: 'My PayPal',
        });
        const result = await graphqlQueryV2(
          editPayoutMethodMutation,
          {
            payoutMethod: {
              id: idEncode(pm.id, IDENTIFIER_TYPES.PAYOUT_METHOD),
              data: {
                ...paypalOAuthData,
                isPayPalOAuth: false,
              },
            },
          },
          adminUser,
        );
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.include(
          'Verified PayPal accounts can only be edited to change the name, saved status and currency',
        );
      });

      it('is not fooled by extra fields in data not provided by the user (and does not modify them)', async () => {
        const pm = await fakePayoutMethod({
          CollectiveId: adminUser.CollectiveId,
          type: PayoutMethodTypes.PAYPAL,
          data: { ...paypalOAuthData, currency: 'USD', connectedAccountId: 4242 },
          isSaved: true,
        });
        const result = await graphqlQueryV2(
          editPayoutMethodMutation,
          {
            payoutMethod: {
              id: idEncode(pm.id, IDENTIFIER_TYPES.PAYOUT_METHOD),
              data: {
                ...paypalOAuthData,
                currency: 'EUR',
              },
            },
          },
          adminUser,
        );
        expect(result.errors).to.not.exist;
        expect(result.data.editPayoutMethod.data.currency).to.equal('EUR');
        await pm.reload();
        expect(pm.data.currency).to.equal('EUR');
        expect((pm.data as PaypalPayoutMethodData).connectedAccountId).to.equal(4242);
      });
    });

    describe('KYC handlers', () => {
      let sandbox: ReturnType<typeof createSandbox>;

      beforeEach(async () => {
        await utils.resetTestDB();
        sandbox = createSandbox();
      });

      afterEach(() => {
        sandbox.restore();
      });

      it('calls handleKycPayoutMethodEdited when payout method is edited in place', async () => {
        const handleKycPayoutMethodEditedStub = sandbox
          .stub(kycExpensesCheck, 'handleKycPayoutMethodEdited')
          .resolves();

        const user = await fakeUser();
        const collective = await fakeCollective({ admin: user.collective });
        const payoutMethod = await fakePayoutMethod({
          CollectiveId: collective.id,
          isSaved: true,
          name: 'Original Name',
        });
        // No expenses (or only PENDING/DRAFT) so canBeEdited() is true → in-place update
        const mutationArgs = {
          payoutMethod: {
            id: idEncode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD),
            name: 'Updated Name',
          },
        };

        const result = await graphqlQueryV2(editPayoutMethodMutation, mutationArgs, user);

        expect(result.errors).to.not.exist;
        expect(result.data.editPayoutMethod.name).to.equal('Updated Name');
        expect(result.data.editPayoutMethod.id).to.equal(mutationArgs.payoutMethod.id);
        expect(handleKycPayoutMethodEditedStub).to.have.been.calledOnce;
        const [oldDataValues, updatedPayoutMethod] = handleKycPayoutMethodEditedStub.firstCall.args;
        expect(oldDataValues.id).to.equal(payoutMethod.id);
        expect(updatedPayoutMethod.id).to.equal(payoutMethod.id);
        expect(updatedPayoutMethod.name).to.equal('Updated Name');
      });

      it('calls handleKycPayoutMethodReplaced when payout method is archived and replaced', async () => {
        const handleKycPayoutMethodReplacedStub = sandbox
          .stub(kycExpensesCheck, 'handleKycPayoutMethodReplaced')
          .resolves();

        const user = await fakeUser();
        const collective = await fakeCollective({ admin: user.collective });
        const payoutMethod = await fakePayoutMethod({
          CollectiveId: collective.id,
          isSaved: true,
          name: 'Old Bank',
        });
        // Expense with PAID status so canBeEdited() is false → archive and replace
        await fakeExpense({ PayoutMethodId: payoutMethod.id, status: 'PAID' });
        const mutationArgs = {
          payoutMethod: {
            id: idEncode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD),
            name: 'New Bank',
          },
        };

        const result = await graphqlQueryV2(editPayoutMethodMutation, mutationArgs, user);

        expect(result.errors).to.not.exist;
        expect(result.data.editPayoutMethod.name).to.equal('New Bank');
        expect(result.data.editPayoutMethod.id).to.not.equal(mutationArgs.payoutMethod.id);
        expect(handleKycPayoutMethodReplacedStub).to.have.been.calledOnce;
        const [oldPayoutMethod, newPayoutMethod] = handleKycPayoutMethodReplacedStub.firstCall.args;
        expect(oldPayoutMethod.id).to.equal(payoutMethod.id);
        expect(newPayoutMethod.id).to.not.equal(payoutMethod.id);
        expect(newPayoutMethod.name).to.equal('New Bank');
      });
    });
  });
});
