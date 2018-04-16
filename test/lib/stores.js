import models from '../../server/models';

/** Randomize email since it's a unique key in the database */
export function randEmail(email) {
  const [user, domain] = email.split('@');
  const rand = Math.random().toString(36).substring(2, 15);
  return `${user}-${rand}@${domain}`;
}

/** Create a new user with a collective */
export async function newUser(name) {
  const email = randEmail(`${name}@oc.com`);
  const user = await models.User.createUserWithCollective({
    email,
    name,
    username: name,
    description: `A user called ${name}`,
  });
  return { user, userCollective: user.collective };
}

/** Create a new collective with host */
export async function collectiveWithHost(name, currency, fee) {
  const email = randEmail(`${name}-host-${currency}@oc.com`);
  const hostOwner = await models.User.create({ email });
  const host = await models.Collective.create({
    CreatedByUserId: hostOwner.id,
    slug: `${name} Host`,
    hostFeePercent: fee ? parseInt(fee) : 0,
    currency,
  });
  const collective = await models.Collective.create({ name });
  await collective.addHost(host);
  await models.ConnectedAccount.create({
    service: 'stripe',
    token: 'sk_test_XOFJ9lGbErcK5akcfdYM1D7j',
    username: 'acct_198T7jD8MNtzsDcg',
    CollectiveId: host.id,
  });
  return { host, collective };
}

/** Create an order and set a paymentMethod for it */
export async function orderAndPaymentMethod(from, to, amount, currency) {
  const order = await models.Order.create({
    description: `Donation to ${to.slug}`,
    totalAmount: amount,
    currency,
    CreatedByUserId: from.CreatedByUserId,
    FromCollectiveId: from.id,
    CollectiveId: to.id,
  });
  await order.setPaymentMethod({
    token: "tok_123456781234567812345678",
  });
  return { order };
}
