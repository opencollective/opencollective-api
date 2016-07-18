const app = require('../index');
const models = app.set('models');
const stripeGateway = require('../server/gateways').stripe;
const constants = require('../server/constants/transactions');

const done = (err) => {
  if (err) console.log('err', err);
  console.log('done!');
  process.exit();
}

var message = [];

// replace with real values
const OLD_STRIPE_ACCOUNT_ID = 3; // from StripeAccounts table
const NEW_STRIPE_ACCOUNT_ID = 2; // from StripeAccounts table

var oldStripeAccount = null;
var newStripeAccount = null;

return models.StripeAccount.findById(OLD_STRIPE_ACCOUNT_ID)
.tap(stripeAccount => oldStripeAccount = stripeAccount) // store old stripe account
.then(() => models.StripeAccount.findById(NEW_STRIPE_ACCOUNT_ID))
.tap(stripeAccount => newStripeAccount = stripeAccount) // store new stripe account
// fetch all active subscriptions for this account
.then(() => stripeGateway.getSubscriptionsList(oldStripeAccount, 10)) // get one at a time for now
.tap(stripeSubscriptionList => {
  console.log("Subscriptions fetched: ", stripeSubscriptionList.data.length);
})
.each(stripeSubscription => {
  console.log("---OLD SUBSCRIPTION----");
  console.log(stripeSubscription);
  console.log("---END OLD SUBSCRIPTION---");

  // create or get a plan
  const plan = {
    interval: stripeSubscription.plan.interval,
    amount: stripeSubscription.plan.amount,
    currency: stripeSubscription.plan.currency
  }

  // make sure that this subscription id is in our database
  return models.Subscription.find({stripeSubscriptionId: stripeSubscription.id})
    .then(ocSubscription => {
      if (ocSubscription && ocSubscription.isActive) {
        console.log("Subscription found in our DB: ", ocSubscription.id);
      } else {
        throw new Error("Subscription not found in our DB: ", stripeSubscription);
      }
    })
    // make sure the new customer is on the new account
    .then(() => stripeGateway.retrieveCustomer(newStripeAccount, stripeSubscription.customer))
    .then(customer => {
      if (customer) {
        console.log("Customer found: ", customer.id);
      } else {
        throw new Error("Customer not found in new account");
      }
      if (customer.default_source) {
        console.log("Payment Method found: ", customer.default_source);
      } else {
        throw new Error("No payment method for this customer");
      }
    })
    // start setting up the new subscription
    .then(() => stripeGateway.getOrCreatePlan(newStripeAccount, plan))
    .then(plan => {
      const subscription = {
        // carryover fields
        plan: plan.id,
        application_fee_percent: constants.OC_FEE_PERCENT,
        metadata: stripeSubscription.metadata,
        // needed to make sure we don't double charge them
        billing_cycle_anchor: stripeSubscription.current_period_end,
        prorate: false
      };
      return stripeGateway.createSubscription(
        newStripeAccount,
        stripeSubscription.customer,
        subscription);
    })
    .tap(console.log)

    // delete the old subscription
    .then(() => stripeGateway.cancelSubscription(oldStripeAccount, stripeSubscription.id))
    .catch(err => {
      console.log("ERROR: ", err, stripeSubscription)
      return;
    });
})
.then(() => done())
.catch(done)



/* QUERY to get all subscriptions from one host

models.sequelize.query(`
    SELECT
    d.id as donationid,
    d."UserId",
    d."GroupId",
    d.currency,
    d.title,
    d."SubscriptionId",
    d."createdAt",
    s.interval,
    s.data,
    s."stripeSubscriptionId",
    s."activatedAt",
    t.id as "TransactionId",
    pm."customerId"
  FROM "Donations" d

  LEFT JOIN "Subscriptions" s on d."SubscriptionId" = s.id
  LEFT JOIN "UserGroups" ug on d."GroupId" = ug."GroupId"
  LEFT JOIN "Transactions" t on (d.id = t."DonationId"
                  AND t.id = (SELECT MAX(id) FROM "Transactions" t WHERE t."SubscriptionId" = s.id))
  LEFT join "PaymentMethods" pm on t."PaymentMethodId" = pm.id

  WHERE d."SubscriptionId" IS NOT NULL
    AND d."deletedAt" IS NULL
    AND s."deletedAt" IS NULL
    AND t."deletedAt" IS NULL
    AND s."isActive" = true
    AND ug.role LIKE 'HOST'
    AND ug."UserId" = 40

  order by d."GroupId""
`)
*/

/*
.each(ocSubscription => {
  return stripeGateway.retrieveSubscription(
      oldStripeAccount.accessToken,
      ocSubscription.customerId,
      ocSubscription.stripeSubscriptionId)
    .then(stripeSubscription) => {
      console.log(stripeSubscription.id)
      subscriptionsList.push(stripeSubscription);
    }
    .catch(err => {
      console.log("ERROR: ", err, subscription)
      return;
    });
*/
/*  return stripeClient.customers.retrieveSubscription(
      subscription.customerId,
      subscription.stripeSubscriptionId)
    .then(stripeSubscription => {
      console.log(stripeSubscription.id)
      subscriptionsList.push(stripeSubscription);
    })
*/
