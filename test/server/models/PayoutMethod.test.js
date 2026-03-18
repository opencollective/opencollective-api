/* eslint-disable camelcase */
import { expect } from 'chai';
import { SequelizeValidationError, ValidationError } from 'sequelize';

import models from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import { randEmail } from '../../stores';
import { fakeExpense, fakePayoutMethod, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/models/PayoutMethod', () => {
  describe('getFilteredData()', () => {
    it('filters PAYPAL data to safe fields only', () => {
      const pm = models.PayoutMethod.build({
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'test@example.com',
          verifiedAt: '2024-01-01T00:00:00Z',
          currency: 'USD',
          isPayPalOAuth: true,
          connectedAccountId: 123,
          paypalUserInfo: {
            name: 'John Doe',
            email: 'john@paypal.com',
            payer_id: 'PAYER123',
            'address.country': 'US',
            sensitiveField: 'should-be-filtered',
          },
        },
        CollectiveId: 1,
        CreatedByUserId: 1,
      });
      const filtered = pm.getFilteredData();
      expect(filtered).to.deep.equal({
        email: 'test@example.com',
        verifiedAt: '2024-01-01T00:00:00Z',
        currency: 'USD',
        isPayPalOAuth: true,
        paypalUserInfo: {
          name: 'John Doe',
          email: 'john@paypal.com',
          payer_id: 'PAYER123',
          'address.country': 'US',
        },
      });
      expect(filtered).to.not.have.property('connectedAccountId');
      expect(filtered.paypalUserInfo).to.not.have.property('sensitiveField');
    });

    it('filters OTHER data to currency and content', () => {
      const pm = models.PayoutMethod.build({
        type: PayoutMethodTypes.OTHER,
        data: {
          content: 'Wire transfer to Bank XYZ',
          currency: 'EUR',
        },
        CollectiveId: 1,
        CreatedByUserId: 1,
      });
      const filtered = pm.getFilteredData();
      expect(filtered).to.deep.equal({
        currency: 'EUR',
        content: 'Wire transfer to Bank XYZ',
      });
    });

    it('returns full data for BANK_ACCOUNT', () => {
      const bankData = {
        accountHolderName: 'Jane Smith',
        currency: 'GBP',
        type: 'sort_code',
        details: {
          sortCode: '12-34-56',
          accountNumber: '12345678',
        },
      };
      const pm = models.PayoutMethod.build({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        data: bankData,
        CollectiveId: 1,
        CreatedByUserId: 1,
      });
      const filtered = pm.getFilteredData();
      expect(filtered).to.deep.equal(bankData);
    });

    it('filters STRIPE data to stripeAccountId and publishableKey only', () => {
      const pm = models.PayoutMethod.build({
        type: PayoutMethodTypes.STRIPE,
        data: {
          stripeAccountId: 'acct_123',
          publishableKey: 'pk_test_xyz',
          connectedAccountId: 456,
        },
        CollectiveId: 1,
        CreatedByUserId: 1,
      });
      const filtered = pm.getFilteredData();
      expect(filtered).to.deep.equal({
        stripeAccountId: 'acct_123',
        publishableKey: 'pk_test_xyz',
      });
      expect(filtered).to.not.have.property('connectedAccountId');
    });

    it('returns empty object for unsupported types (ACCOUNT_BALANCE, CREDIT_CARD)', () => {
      const pm = models.PayoutMethod.build({
        type: PayoutMethodTypes.ACCOUNT_BALANCE,
        data: {},
        CollectiveId: 1,
        CreatedByUserId: 1,
      });
      expect(pm.getFilteredData()).to.deep.equal({});

      const ccPm = models.PayoutMethod.build({
        type: PayoutMethodTypes.CREDIT_CARD,
        data: { token: 'tok_123' },
        CollectiveId: 1,
        CreatedByUserId: 1,
      });
      expect(ccPm.getFilteredData()).to.deep.equal({});
    });

    it('filters provided data parameter instead of instance data', () => {
      const pm = models.PayoutMethod.build({
        type: PayoutMethodTypes.PAYPAL,
        data: { email: 'original@example.com', currency: 'USD' },
        CollectiveId: 1,
        CreatedByUserId: 1,
      });
      const customData = {
        email: 'custom@example.com',
        verifiedAt: '2024-06-01T00:00:00Z',
        currency: 'EUR',
      };
      const filtered = pm.getFilteredData(customData);
      expect(filtered).to.deep.include({
        email: 'custom@example.com',
        verifiedAt: '2024-06-01T00:00:00Z',
        currency: 'EUR',
      });
      expect(filtered.email).to.equal('custom@example.com');
    });
  });

  describe('findSimilar()', () => {
    before(async () => {
      await resetTestDB();
    });

    it('finds similar BANK_ACCOUNT payout methods', async () => {
      const pm = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        data: {
          type: 'aba',
          details: {
            email: 'will@dafoe.net',
            abartn: '123456',
            accountNumber: '1234567890',
          },
          accountHolderName: 'Willem Dafoe',
          currency: 'USD',
        },
      });
      const otherPm = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        data: {
          type: 'aba',
          details: {
            email: 'nic@cage.com',
            abartn: '123456',
            accountNumber: '1234567890',
          },
          accountHolderName: 'Nicolas Cage',
          currency: 'USD',
        },
      });
      await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        data: {
          type: 'aba',
          details: {
            email: 'john@cusack.com',
            abartn: '100000',
            accountNumber: '1234567890',
          },
          accountHolderName: 'John Cusack',
          currency: 'USD',
        },
      });

      const similarPayoutMethods = await pm.findSimilar();
      expect(similarPayoutMethods).to.have.length(1);
      expect(similarPayoutMethods[0]).to.have.property('id', otherPm.id);
    });

    it('finds similar PAYPAL payout methods', async () => {
      const pm = await fakePayoutMethod({
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'will@dafoe.net',
        },
      });
      const otherPm = await fakePayoutMethod({
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'will@dafoe.net',
        },
      });
      await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        email: 'john@cusack.com',
      });

      const similarPayoutMethods = await pm.findSimilar();
      expect(similarPayoutMethods).to.have.length(1);
      expect(similarPayoutMethods[0]).to.have.property('id', otherPm.id);
    });

    it('returns empty when account has no similar rows', async () => {
      const pm = await fakePayoutMethod({
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'nic@cage.org',
        },
      });

      const similarPayoutMethods = await pm.findSimilar();
      expect(similarPayoutMethods).to.have.length(0);
    });

    it('returns empty when there is not enough identifiable parameters', async () => {
      const pm = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        data: {
          type: 'aba',
          details: {
            email: 'will@dafoe.net',
          },
          accountHolderName: 'Willem Dafoe',
          currency: 'USD',
        },
      });

      const similarPayoutMethods = await pm.findSimilar();
      expect(similarPayoutMethods).to.have.length(0);
    });
  });

  describe('validate data', () => {
    describe('for PayPal', () => {
      it('check email', async () => {
        const user = await fakeUser();
        const baseData = { CollectiveId: user.collective.id, CreatedByUserId: user.id, type: PayoutMethodTypes.PAYPAL };

        // Invalid
        const promise = models.PayoutMethod.create({ ...baseData, data: { email: 'Nope' } });
        await expect(promise).to.be.rejectedWith(SequelizeValidationError, 'Invalid PayPal email address');

        // Valid
        const pm = await models.PayoutMethod.create({ ...baseData, data: { email: randEmail(), currency: 'USD' } });
        expect(pm).to.exist;
      });

      it('make sure only allowed fields are set', async () => {
        const user = await fakeUser();
        const baseData = { CollectiveId: user.collective.id, CreatedByUserId: user.id, type: PayoutMethodTypes.PAYPAL };
        const promise = models.PayoutMethod.create({
          ...baseData,
          data: { email: randEmail(), currency: 'USD', hello: true },
        });
        await expect(promise).to.be.rejectedWith(
          ValidationError,
          'Data for this payout method contains too much information',
        );
      });

      it('make sure only allowed currencies are set', async () => {
        const user = await fakeUser();
        const baseData = { CollectiveId: user.collective.id, CreatedByUserId: user.id, type: PayoutMethodTypes.PAYPAL };
        const promise = models.PayoutMethod.create({ ...baseData, data: { email: randEmail(), currency: 'Nope' } });
        await expect(promise).to.be.rejectedWith(ValidationError, 'Validation error: Invalid currency');
      });
    });

    describe('for "other"', () => {
      it('only allows content', async () => {
        const user = await fakeUser();
        const baseData = { CollectiveId: user.collective.id, CreatedByUserId: user.id, type: PayoutMethodTypes.OTHER };

        // Invalid
        const promise = models.PayoutMethod.create({ ...baseData, data: { content: 'Yep', nope: 'maybe' } });
        await expect(promise).to.be.rejectedWith(
          ValidationError,
          'Data for this payout method contains too much information',
        );

        // Valid
        const pm = await models.PayoutMethod.create({ ...baseData, data: { content: 'Yep' } });
        expect(pm).to.exist;
      });
    });
  });

  describe('canBeEdited', () => {
    it(`returns false for a payout method is attached to an approved or paid expense`, async () => {
      const pm = await fakePayoutMethod();
      await fakeExpense({ CollectiveId: pm.CollectiveId, PayoutMethodId: pm.id, status: 'PAID' });
      expect(await pm.canBeEdited()).to.be.false;
    });

    it('returns true for a payout method that is not attached to any expenses', async () => {
      const pm = await fakePayoutMethod();
      expect(await pm.canBeEdited()).to.be.true;
    });
  });

  describe('canBeDeleted', () => {
    it(`returns false for a payout method is attached to any expense`, async () => {
      const pm = await fakePayoutMethod();
      await fakeExpense({ CollectiveId: pm.CollectiveId, PayoutMethodId: pm.id });
      expect(await pm.canBeDeleted()).to.be.false;
    });

    it('returns true for a payout method that is not attached to any expenses', async () => {
      const pm = await fakePayoutMethod();
      expect(await pm.canBeDeleted()).to.be.true;
    });
  });

  describe('canBeArchived', () => {
    it(`returns false for STRIPE`, async () => {
      const pm = await fakePayoutMethod({
        type: PayoutMethodTypes.STRIPE,
      });
      expect(await pm.canBeArchived()).to.be.false;
    });

    Object.keys(PayoutMethodTypes)
      .filter(p => p !== PayoutMethodTypes.STRIPE)
      .forEach(t => {
        it(`return true for ${t}`, async () => {
          const pm = await fakePayoutMethod({
            type: t,
          });
          expect(await pm.canBeArchived()).to.be.true;
        });
      });
  });
});
