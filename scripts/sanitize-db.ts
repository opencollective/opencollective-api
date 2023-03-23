#!/usr/bin/env node
import '../server/env';

import config from 'config';

import channels from '../server/constants/channels';
import models, { Op, sequelize } from '../server/models';

const testStripeAccounts = {
  // Open Source Collective 501c6
  opensource: {
    service: 'stripe',
    username: 'acct_18KWlTLzdXg9xKNS',
    token: 'sk_test_iDWQubtz4ixk0FQg1csgCi6p',
    data: {
      publishableKey: 'pk_test_l7H1cDlh2AekeETfq742VJbC',
    },
    CollectiveId: 11004,
  },
  opensourceDvl: {
    // legacy for opencollective_dvl.pgsql
    service: 'stripe',
    username: 'acct_18KWlTLzdXg9xKNS',
    token: 'sk_test_iDWQubtz4ixk0FQg1csgCi6p',
    data: {
      publishableKey: 'pk_test_l7H1cDlh2AekeETfq742VJbC',
    },
    CollectiveId: 9805,
  },
  // Open Collective Inc. host for meetups
  other: {
    service: 'stripe',
    username: 'acct_18KWlTLzdXg9xKNS',
    token: 'sk_test_iDWQubtz4ixk0FQg1csgCi6p',
    data: {
      publishableKey: 'pk_test_l7H1cDlh2AekeETfq742VJbC',
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
};

const createConnectedAccount = hostname => {
  return models.ConnectedAccount.create(testStripeAccounts[hostname]).catch(e => {
    // will fail if the host is not present
    console.log(`[warning] Unable to create a connected account for ${hostname}`);
    if (process.env.DEBUG) {
      console.error(e);
    }
  });
};

const replaceHostStripeTokens = () => {
  return models.ConnectedAccount.destroy({ where: { service: 'stripe' }, force: true })
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

// Remove all webhooks to ensure we won't use users Zapier apps
const deleteWebhooks = () => {
  return models.Notification.destroy({
    where: { channel: [channels.WEBHOOK, channels.GITTER, channels.SLACK, channels.TWITTER] },
  }).catch(e => console.error('There was an error removing the webhooks. Please do it manually', e));
};

const deleteLegalDocuments = () => {
  return models.LegalDocument.destroy({ truncate: true, force: true })
    .then(() => models.RequiredLegalDocument.destroy({ truncate: true, force: true }))
    .catch(e => console.error('Cannot remove legal documents, please do it manually', e));
};

const replaceUploadedFiles = async () => {
  // Update all private images
  await sequelize.query(`UPDATE "ExpenseItems" SET "url" = :url`, {
    replacements: {
      url: `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/expense-item/ba69869c-c38b-467a-96f4-3623adfad784/My%20super%20invoice.jpg`,
    },
  });

  await sequelize.query(`UPDATE "ExpenseAttachedFiles" SET "url" = :url`, {
    replacements: {
      url: `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/expense-attached-file/31d9cf1f-80f4-49fa-8030-e546b7f2807b/invoice_4.jpg`,
    },
  });

  // Update UploadedFiles record: remove all private files then insert defaults
  await sequelize.query(`DELETE FROM "UploadedFiles" WHERE kind IN ('EXPENSE_ITEM', 'EXPENSE_ATTACHED_FILE')`);
  await models.UploadedFile.create({
    url: `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/expense-item/ba69869c-c38b-467a-96f4-3623adfad784/My%20super%20invoice.jpg`,
    kind: 'EXPENSE_ITEM',
    fileName: 'My super invoice.jpg',
    fileType: 'image/jpeg',
    fileSize: 100,
  });
  await models.UploadedFile.create({
    url: `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com/expense-attached-file/31d9cf1f-80f4-49fa-8030-e546b7f2807b/invoice_4.jpg`,
    kind: 'EXPENSE_ATTACHED_FILE',
    fileName: 'invoice_4.jpg',
    fileType: 'image/jpeg',
    fileSize: 100,
  });
};

export const sanitizeDB = async () => {
  return Promise.all([
    replaceHostStripeTokens(),
    replaceUsersStripeTokens(),
    removeConnectedAccountsTokens(),
    deleteWebhooks(),
    deleteLegalDocuments(),
    replaceUploadedFiles(),
  ]);
};

// Only run script if called directly (to allow unit tests)
if (!module.parent) {
  sanitizeDB().then(() => {
    console.log('Done!');
    process.exit();
  });
}
