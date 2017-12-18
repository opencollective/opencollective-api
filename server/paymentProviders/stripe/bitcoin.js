import config from 'config';

import models from '../../models';
import * as constants from '../../constants/transactions';
import roles from '../../constants/roles';
import * as stripeGateway from './gateway';
import activities from '../../constants/activities';
import errors from '../../lib/errors';
import emailLib from '../../lib/email';

export default {

  features: {
    recurring: false,
    waitToCharge: true
  },

  processOrder: (order) => {

    const {
      fromCollective,
      paymentMethod,
      createdByUser:user
    } = order;

    // we create a customer on platform account only
    // since this type of source on stripe is easier to use directly from 
    // platform account
    return stripeGateway.appStripe.customers.create({
      email: user.email
    })
    .then(customer => paymentMethod.update({ customerId: customer.id, CollectiveId: fromCollective.id}))

    // now we wait for the webhook to come through with source.chargeable
  },

  webhook: (requestBody, event) => {

    const createChargeAndTransactions = (order, { hostStripeAccount, source }) => {
  
      const { collective, createdByUser: user, paymentMethod } = order;
      let charge;      

      // We need to specify exactly the amount of money to send to host account
      // bitcoin transactions have a standard 0.8% fee charged by Stripe
      const destinationAmount = order.totalAmount - (order.totalAmount*0.008) - (order.totalAmount*0.05); // remove stripe fee and our fee

      return stripeGateway.appStripe.charges.create(
        {
          amount: order.totalAmount,
          currency: order.currency,
          source,
          description: order.description,
          customer: paymentMethod.customerId,
          destination: {
            account: hostStripeAccount,
            amount: destinationAmount
          },
        })
        .tap(c => charge = c)
        .then(charge => stripeGateway.retrieveBalanceTransaction(
          hostStripeAccount,
          charge.balance_transaction))
        .then(balanceTransaction => {
          // create a transaction
          const fees = stripeGateway.extractFees(balanceTransaction);
          const hostFeePercent = collective.hostFeePercent;
          const payload = {
            CreatedByUserId: user.id,
            FromCollectiveId: order.FromCollectiveId,
            CollectiveId: collective.id,
            PaymentMethodId: paymentMethod.id
          };
          payload.transaction = {
            type: constants.type.CREDIT,
            OrderId: order.id,
            amount: order.totalAmount,
            currency: order.currency,
            hostCurrency: balanceTransaction.currency,
            amountInHostCurrency: balanceTransaction.amount,
            hostCurrencyFxRate: order.totalAmount / balanceTransaction.amount,
            hostFeeInHostCurrency: parseInt(balanceTransaction.amount * hostFeePercent / 100, 10),
            platformFeeInHostCurrency: order.totalAmount*0.05,
            paymentProcessorFeeInHostCurrency: fees.stripeFee,
            description: order.description,
            data: { charge, balanceTransaction },
          };
          return models.Transaction.createFromPayload(payload);
        });
    };

    // based on the source, fetch order
    const sourceId = event.data.object.id;

    let order, hostStripeAccount;
    // create activity to record webhook
    return models.Activity.create({
      type: activities.WEBHOOK_STRIPE_RECEIVED,
      data: {
        event,
        stripeAccount: requestBody.user_id,
        eventId: requestBody.id,
        dashboardUrl: `https://dashboard.stripe.com/${requestBody.user_id}/events/${requestBody.id}`
      }
    })
    .then(() => models.Order.findOne({
      include: [{
        model: models.PaymentMethod, as: 'paymentMethod',
        where: {
          token: sourceId
        }
      },
        { model: models.Collective, as:'collective'},
        { model: models.Collective, as:'fromCollective'},
        { model: models.User, as: 'createdByUser'}]
    }))
    .then(o => order = o)
    .then(() => {
      if (!order) {
        // this handles a race condition where a user may transfer money before hitting submit on our site
        // we'll ignore any webhooks with unknown sources and count on 
        // stripe to try again
        throw new errors.BadRequest('Source not found');
      }
    })
    .then(() => order.collective.getHostStripeAccount())
    .then(stripeAccount => hostStripeAccount = stripeAccount)
    .then(() => createChargeAndTransactions(order, {
      hostStripeAccount: hostStripeAccount.username, 
      source: sourceId,
    }))
    // let's add that user as a member
    .tap(() => order.collective.findOrAddUserWithRole({ 
      id: order.createdByUser.id, 
      CollectiveId: order.fromCollective.id}, 
      roles.BACKER, 
      { CreatedByUserId: order.createdByUser.id, 
        TierId: order.TierId })
    )
    // now we send an email to confirm transaction
    .then(transaction => {
      const user = order.createdByUser || {};
      return order.collective.getRelatedCollectives(2, 0)
        .then(relatedCollectives => emailLib.send(
          'thankyou',
          user.email,
          { order: order.info,
            transaction: transaction.info,
            user: user.info,
            collective: order.collective.info,
            fromCollective: order.fromCollective.minimal,
            relatedCollectives,
            config: { host: config.host },
            subscriptionsLink: user.generateLoginLink('/subscriptions')
          }, {
            from: `${order.collective.name} <hello@${order.collective.slug}.opencollective.com>`
          }))
    })
    // Mark order row as processed
    .then(() => order.update({ processedAt: new Date() }))

    // Mark paymentMethod as confirmed
    .tap(() => order.paymentMethod.update({ archivedAt: new Date }))

  }
}