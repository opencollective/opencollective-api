import { expect } from 'chai';
import { ValidationError } from 'sequelize';

import models from '../../../server/models/index.js';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod.js';
import { randEmail } from '../../stores/index.js';
import { fakePayoutMethod, fakeUser } from '../../test-helpers/fake-data.js';
import { resetTestDB } from '../../utils.js';

describe('server/models/PayoutMethod', () => {
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
        await expect(promise).to.be.rejectedWith(ValidationError, 'Invalid PayPal email address');

        // Valid
        const pm = await models.PayoutMethod.create({ ...baseData, data: { email: randEmail() } });
        expect(pm).to.exist;
      });

      it('make sure only allowed fields are set', async () => {
        const user = await fakeUser();
        const baseData = { CollectiveId: user.collective.id, CreatedByUserId: user.id, type: PayoutMethodTypes.PAYPAL };
        const promise = models.PayoutMethod.create({ ...baseData, data: { email: randEmail(), hello: true } });
        await expect(promise).to.be.rejectedWith(
          ValidationError,
          'Data for this payout method contains too much information',
        );
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
});
