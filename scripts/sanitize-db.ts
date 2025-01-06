import '../server/env';

import channels from '../server/constants/channels';
import models, { Op, sequelize } from '../server/models';

export const testStripeAccounts = {
  // Open Source Collective 501c6
  opensource: {
    service: 'stripe',
    username: 'acct_17GUlBGSh14qHxZK',
    token: 'sk_test_DVhbUwvSoAvDfjlTRE0IrSPs',
    data: {
      publishableKey: 'pk_test_gwOTnKFLVpiYhsbXXfZcLPtR',
    },
    CollectiveId: 11004,
  },
  opensourceDvl: {
    // legacy for opencollective_dvl.pgsql
    service: 'stripe',
    username: 'acct_17GUlBGSh14qHxZK',
    token: 'sk_test_DVhbUwvSoAvDfjlTRE0IrSPs',
    data: {
      publishableKey: 'pk_test_gwOTnKFLVpiYhsbXXfZcLPtR',
    },
    CollectiveId: 9805,
  },
  // Open Collective Inc. host for meetups
  other: {
    service: 'stripe',
    username: 'acct_17GUlBGSh14qHxZK',
    token: 'sk_test_DVhbUwvSoAvDfjlTRE0IrSPs',
    data: {
      publishableKey: 'pk_test_gwOTnKFLVpiYhsbXXfZcLPtR',
    },
    CollectiveId: 8674,
  },
  brussesltogether: {
    service: 'stripe',
    username: 'acct_198T7jD8MNtzsDcg',
    token: 'sk_test_Hcsz2JJdMzEsU28c6I8TyYYK',
    data: {
      publishableKey: 'pk_test_OSQ8IaRSyLe9FVHMivgRjQng',
    },
    CollectiveId: 9802,
  },
} as const;

const createConnectedAccount = async (hostname: keyof typeof testStripeAccounts) => {
  const host = await models.Collective.findByPk(testStripeAccounts[hostname].CollectiveId);
  if (!host) {
    return;
  }

  return models.ConnectedAccount.create(testStripeAccounts[hostname]).catch(e => {
    // will fail if the host is not present
    console.log(`[warning] Unable to create a connected account for ${hostname}`);
    if (process.env.DEBUG) {
      console.error(e);
    }
  });
};

const replaceHostStripeTokens = () => {
  return models.ConnectedAccount.destroy({
    where: sequelize.literal(
      `service = 'stripe'
      AND (
        data->>'publishableKey' IS NULL
        OR data->>'publishableKey' NOT ILIKE 'pk_test_%'
      )`,
    ),
    force: true,
  })
    .then(() => createConnectedAccount('opensource'))
    .then(() => createConnectedAccount('opensourceDvl'))
    .then(() => createConnectedAccount('other'))
    .then(() => createConnectedAccount('brussesltogether'))
    .catch(e => console.error('There was an error replacing the hosts stripe tokens. Please do it manually', e));
};

const replaceUsersStripeTokens = () => {
  return models.PaymentMethod.update(
    { token: 'tok_mastercard' },
    { where: { service: 'stripe' }, paranoid: false },
  ).catch(e => console.error("Can't remove users stripe tokens. Please do it manually", e));
};

// Removes all tokens from connected accounts
const removeConnectedAccountsTokens = () => {
  return models.ConnectedAccount.update(
    { token: null },
    { where: { service: { [Op.ne]: 'stripe' } }, paranoid: false },
  ).catch(e => {
    console.error("Can't remove tokens from connected accounts. Please do it manually", e);
  });
};

// Remove all webhooks to ensure we won't ping user apps
const deleteWebhooks = () => {
  return models.Notification.destroy({
    where: { channel: [channels.WEBHOOK, channels.SLACK, channels.TWITTER] },
  }).catch(e => console.error('There was an error removing the webhooks. Please do it manually', e));
};

const deleteLegalDocuments = () => {
  return models.LegalDocument.destroy({ truncate: true, force: true })
    .then(() => models.RequiredLegalDocument.destroy({ truncate: true, force: true }))
    .catch(e => console.error('Cannot remove legal documents, please do it manually', e));
};

const sanitizeDB = async () => {
  return Promise.all([
    replaceHostStripeTokens(),
    replaceUsersStripeTokens(),
    removeConnectedAccountsTokens(),
    deleteWebhooks(),
    deleteLegalDocuments(),
  ]);
};

// Only run script if called directly (to allow unit tests)
if (!module.parent) {
  sanitizeDB().then(() => {
    console.log('Done!');
    process.exit();
  });
}
