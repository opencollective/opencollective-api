import models from '../server/models';
import * as stripeGateway from '../server/paymentProviders/stripe/gateway';
import * as constants from '../server/constants/transactions';


/*
  - Find all subscriptions on oldStripeAccount
  - For each one that exists in our database, create new customer based on:
    case 1: Old data 
      only has pm.customerId
    case 2: Post-v2 migration data
      has pm.customerId and data.CustomerIdForHost
    case 3: Post-v2 already created a CustomerIdFor this host
      has pm.customerId and data.CustomerIdForHost[newStripeAccount.username]

  - Record new customer info
  - Create plan and add new subscription.
  - Cancel old subscription

*/


const done = (err) => {
  if (err) console.log('err', err);
  console.log('done!');
  process.exit();
}

// replace with real values
const OLD_STRIPE_ACCOUNT_ID = 2090; // id1486 in prod
const NEW_STRIPE_ACCOUNT_ID = 2091; // id1943 in prod

let oldStripeAccount = null;
let newStripeAccount = null;
let currentOCSubscription;

const dryrun = process.argv[2] ? process.argv[2] !== 'production' : true;
const limit = process.argv[3] || 1;

const migrateSubscriptions = () => {
  // fetch old stripe account
  return models.ConnectedAccount.findById(OLD_STRIPE_ACCOUNT_ID)
  .then(stripeAccount => oldStripeAccount = stripeAccount)

  // fetch new stripe account
  .then(() => models.ConnectedAccount.findById(NEW_STRIPE_ACCOUNT_ID))
  .then(stripeAccount => newStripeAccount = stripeAccount)

  // fetch subscriptions from old stripe account
  .then(() => stripeGateway.getSubscriptionsList(oldStripeAccount, limit))

  .then(oldStripeSubscriptionList => {
    console.log("Subscriptions fetched: ", oldStripeSubscriptionList.data.length);
    return oldStripeSubscriptionList.data;
  })
  .each(oldStripeSubscription => {
    console.log("---OLD SUBSCRIPTION---")
    console.log(oldStripeSubscription);
    console.log("---------END----------")

    let platformCustomerId, customerIdOnOldStripeAccount, customerIdOnNewStripeAccount;

    // fetch the subscription from our database
    return models.Subscription.findOne({where: { stripeSubscriptionId: oldStripeSubscription.id}})
      .then(ocSubscription => {
        if (ocSubscription && ocSubscription.isActive) {
          console.log("Subscription found in our DB:", ocSubscription.id)
          currentOCSubscription = ocSubscription;
        } else {
          throw new Error("Subscription not found in our DB: ", oldStripeSubscription.id)
        }
      })

      // now deal with customerId

      /*if case 1:
      - use token to create a new customerId on platform
      - store that in PM
      - store old customerId in data.CustomerIdForHost (using old stripe account)
      - use token to create a third customerId for new host
      - store new customerId in data.CustomerIdForHost (under new stripe account)*/

      // fetch paymentMethod used for this subscription
      .then(() => {
        return models.Order.find({
          where: {
            SubscriptionId: currentOCSubscription.id
          },
          include: [
          { model: models.Subscription },
          { model: models.PaymentMethod, as: 'paymentMethod'},
          { model: models.User, as: 'createdByUser' }
          ]
        })
      })
      .then(order => {
        // figure out which of the three cases this payment method falls into
        /*
          Case 1: old subscription
            -- pm.data.CustomerIdForHost is null
          Case 2: post-v2 subscription
            -- pm.data.CustomerIdForHost[oldStripeAccount.username] is not null
          Case 3: post-v2 subscription and user already has a customer Id on new stripe account
            -- pm.data.CustomerIdForHost[oldStripeAccount.username] is not null and pm.data.CustomerIdForHost[newStripeAccount.username] is not null
        */

        const pm = order.paymentMethod;
        const customerIdForHostsList = pm.data && pm.data.CustomerIdForHost;
        platformCustomerId = pm.customerId;
        customerIdOnOldStripeAccount = customerIdForHostsList && customerIdForHostsList[oldStripeAccount.username];
        customerIdOnNewStripeAccount = customerIdForHostsList && customerIdForHostsList[newStripeAccount.username];

        let customerPromise = Promise.resolve();
        // const pmData = (pm && pm.data) || {};
        const pmDataCustomerIdForHost = {};

        // we shouldn't have any active subscriptions on stripe without customerId
        // on paymentMethod
        if (!platformCustomerId) {
          throw new Error("Payment Method found without Customer Id: ", pm.id);
        }

        // now figure out various customerId cases
        if (customerIdOnOldStripeAccount && customerIdOnNewStripeAccount) {
          // case 3 above
          // this payment method has been used for both hosts already
          // so no need to create new customer id
          console.log("Customer Id found on both old and new stripe accounts");

        } else if (customerIdOnOldStripeAccount && !customerIdOnNewStripeAccount) {
          // case 2 above
          // this payment method has only been used for old host
          // need to create a customer Id for new host
          console.log("Customer id found on old stripe account, creating one on new stripe acount")

          customerPromise = customerPromise.then(() => stripeGateway.createCustomer(newStripeAccount, pm.token, {
            email: order.createdByUser.email
          }))
          .then(stripeCustomer => {
            customerIdOnNewStripeAccount = stripeCustomer.id;
            pmDataCustomerIdForHost[newStripeAccount.username] = stripeCustomer.id;
          })

        } else if (!customerIdOnOldStripeAccount && !customerIdOnNewStripeAccount) {
          // case 1 above
          // old payment method, only used one-time and customerId only created on host
          // need to create a customerId on platform and customerId on new host 
          console.log("Customer id found on old Stripe account, creating on platform and new stripe account")

          
          // This is only if you can take a token from a connected account and use it 
          // on platform and other connected accounts
          customerPromise = customerPromise.then(() => stripeGateway.createCustomer(null, pm.token,{
            email: order.createdByUser.email
          }))
          .then(stripePlatformCustomer => platformCustomerId = stripePlatformCustomer.id)
          .then(() => stripeGateway.createCustomer(newStripeAccount, pm.token, {
            email: order.createdByUser.email
          }))
          .then(stripeCustomer => {
            customerIdOnNewStripeAccount = stripeCustomer.id;
            pmDataCustomerIdForHost[newStripeAccount.username] = stripeCustomer.id;
            pmDataCustomerIdForHost[oldStripeAccount.username] = pm.customerId; // store the original customer id with the correct host
          })
          
        }

        if (dryrun) {
          return Promise.reject('Dry run: Exiting without making any changes on Stripe');
        }

        // now create customerIds
        return customerPromise
          
          // store new customer Ids if needed
          .then(() => {
            if (pmDataCustomerIdForHost) {
              const pmData = pm.data || {};
              pmData.customerIdForHost = Object.assign({}, pmData.customerIdForHost, ...pmDataCustomerIdForHost);
              return pm.update({data: pmData})
            }
            return Promise.resolve();
          })
          .then(() => {
            // define subscription plan
            const plan = {
              interval: oldStripeSubscription.plan.interval,
              amount: oldStripeSubscription.plan.amount,
              currency: oldStripeSubscription.plan.currency
            }
            return stripeGateway.getOrCreatePlan(newStripeAccount, plan)

            // add a new subscription
            .then(stripeSubscriptionPlan => {
              const subscription = {
                // carryover fields
                plan: stripeSubscriptionPlan.id,
                application_fee_percent: constants.OC_FEE_PERCENT,
                metadata: oldStripeSubscription.metadata,
                // needed to make sure we don't double charge them
                billing_cycle_anchor: oldStripeSubscription.current_period_end,
                prorate: false
              };
              return stripeGateway.createSubscription(
                newStripeAccount,
                customerIdOnNewStripeAccount,
                subscription);
            })

            // store the new stripeSubscription info in our table
            .then(newStripeSubscription => {
              const preMigrationData = currentOCSubscription.data;

              return currentOCSubscription.updateAttributes({
                data: Object.assign({}, newStripeSubscription, { preMigrationData }),
                stripeSubscriptionId: newStripeSubscription.id
              });
            })
            // delete new subscription from stripe
            .then(() => stripeGateway.cancelSubscription(
              oldStripeAccount, oldStripeSubscription.id))
            .catch(err => {
              console.log("ERROR: ", err, oldStripeSubscription)
              return err;
            })
          })
      })


  })
}

const run = () => {
  console.log('\nStarting migrate_subscriptions_in_stripe...')

  return migrateSubscriptions()
  .catch(done)
}

run();
