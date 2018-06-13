import { expect } from 'chai';

import models from '../server/models';
import * as giftcard from '../server/paymentProviders/opencollective/giftcard';

/* Test tools */
import * as utils from './utils';
import * as store from './features/support/stores';

const createOrderQuery = `
  mutation createOrder($order: OrderInputType!) {
    createOrder(order: $order) { id }
  }
`;


describe('grahpql.createOrder.opencollective', () => {

  describe('giftcard', () => {

    describe('#getBalance', () => {

      it('should error if payment method is not a giftcard', async () => {
        expect(giftcard.getBalance({ service: 'opencollective', type: 'prepaid' }))
          .to.be.rejectedWith(Error, 'Expected opencollective.giftcard but got opencollective.prepaid');
      }); /* End of "should error if payment method is not a giftcard" */

      it('should return the monthlyLimitPerMember as amount', async () => {
        const paymentMethod = {
          monthlyLimitPerMember: 5000,
          currency: 'USD',
          service: 'opencollective',
          type: 'giftcard',
        };

        expect(await giftcard.getBalance(paymentMethod)).to.deep.equal({
          amount: 5000,
          currency: 'USD'
        });

      }); /* End of "should return the monthlyLimitPerMember as amount" */

    }); /* End of "#getBalance" */

    describe('#processOrder', async () => {

      beforeEach(utils.resetTestDB);

      let user, userCollective, collective, hostCollective, hostAdmin;

      beforeEach(async () => {
        // Given a user and an active collective
        ({ user, userCollective } = await store.newUser('user'));
        ({
          collective,
          hostCollective,
          hostAdmin,
        } = await store.newCollectiveWithHost('test', 'BRL', 'BRL', 5));
        await collective.update({ isActive: true });
      }); /* End of "beforeEach" */

      it('should error if the card does not have enough balance', async () => {
        // Given a giftcard with 30 BRL
        const [pm] = await giftcard.createGiftcards([{
          count: 1,
          expiryDate: new Date('2218-12-15 08:00:00'), // will break CI in 2218!!
        }], {
          name: 'test giftcard',
          currency: 'BRL',
          monthlyLimitPerMember: 3000,
          CollectiveId: hostCollective.id,
          CreatedByUserId: hostAdmin.id,
        });

        // And given an order
        const order = {
          collective: { id: collective.id },
          fromCollective: { id: userCollective.id },
          paymentMethod: {
            service: 'opencollective',
            type: 'giftcard',
            uuid: pm.uuid,
            token: pm.token,
          },
          quantity: 1,
          totalAmount: 5000
        };

        const result = await utils.graphqlQuery(createOrderQuery, { order }, user);

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal(
          'The total amount of this order (R$50) is higher than your monthly spending limit on this payment method (R$30)');
      }); /* End of "should error if the card does not have enough balance" */

      it('should error if the card does not have enough balance', async () => {
        // Given a giftcard with 50 BRL
        const [pm] = await giftcard.createGiftcards([{
          count: 1,
          expiryDate: new Date('2218-12-15 08:00:00'), // will break CI in 2218!!
        }], {
          name: 'test giftcard',
          currency: 'BRL',
          monthlyLimitPerMember: 5000,
          CollectiveId: hostCollective.id,
          CreatedByUserId: hostAdmin.id,
        });

        // And given an order
        const order = {
          collective: { id: collective.id },
          fromCollective: { id: userCollective.id },
          paymentMethod: {
            service: 'opencollective',
            type: 'giftcard',
            uuid: pm.uuid,
            token: pm.token,
          },
          quantity: 1,
          totalAmount: 5000
        };

        const result = await utils.graphqlQuery(createOrderQuery, { order }, user);
        result.errors && console.log(result.errors);
        expect(result.errors).to.not.exist;

        const transactions = await models.Transaction.findAll();
        expect(transactions.length).to.equal(4);

        const [tr1, tr2, tr3, tr4] = transactions;

        // Two first transactions are from host to user
        expect(tr1.FromCollectiveId).to.equal(userCollective.id);
        expect(tr1.CollectiveId).to.equal(hostCollective.id);
        expect(tr1.type).to.equal('DEBIT');
        expect(tr2.FromCollectiveId).to.equal(hostCollective.id);
        expect(tr2.CollectiveId).to.equal(userCollective.id);
        expect(tr2.type).to.equal('CREDIT');

        // Last two ones are from user to collective
        expect(tr3.FromCollectiveId).to.equal(collective.id);
        expect(tr3.CollectiveId).to.equal(userCollective.id);
        expect(tr3.type).to.equal('DEBIT');
        expect(tr4.FromCollectiveId).to.equal(userCollective.id);
        expect(tr4.CollectiveId).to.equal(collective.id);
        expect(tr4.type).to.equal('CREDIT');

        // Original payment method should be archived
        const originalPm = await models.PaymentMethod.findOne({ where: { token: pm.token } });
        expect(originalPm.archivedAt).to.not.be.null;

      }); /* End of "should error if the card does not have enough balance" */

    }); /* End of "#processOrder" */

  }); /* End of "giftcard" */

}); /* End of "grahpql.createOrder.opencollective" */
