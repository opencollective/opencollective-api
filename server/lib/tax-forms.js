import config from 'config';
import { truncate } from 'lodash';

import models, { Op } from '../models';

import logger from './logger';
import queries from './queries';
import { isEmailInternal } from './utils';

const { RequiredLegalDocument, LegalDocument } = models;
const {
  documentType: { US_TAX_FORM },
} = RequiredLegalDocument;

/**
 * @returns {Collective} all the accounts that need to be sent a tax form (both users and orgs)
 * @param {number} year
 */
export async function findAccountsThatNeedToBeSentTaxForm(year) {
  const results = await queries.getTaxFormsRequiredForAccounts(null, year);
  if (!results.length) {
    return [];
  } else {
    return models.Collective.findAll({
      where: { id: { [Op.in]: results.map(result => result.collectiveId) } },
      include: [{ association: 'legalDocuments', required: false, where: { year } }],
    }).then(collectives => {
      return collectives.filter(
        collective =>
          !collective.legalDocuments.length ||
          collective.legalDocuments.some(legalDocument => legalDocument.shouldBeRequested()),
      );
    });
  }
}

const getAdminsForAccount = async account => {
  const adminUsers = await account.getAdminUsers({
    userQueryParams: { include: [{ association: 'collective', required: true }] },
  });

  if (config.env === 'production') {
    return adminUsers;
  } else {
    // Don't send emails on dev/staging environments to ensure we never trigger a notification
    // from HelloWorks for users when we shouldn't.
    return adminUsers.filter(user => {
      if (isEmailInternal(user.email)) {
        return true;
      } else {
        logger.info(
          `Tax form: skipping user ${user.id} (${user.email}) because it's not an internal Open Collective email and we're not in production`,
        );
        return false;
      }
    });
  }
};

/**
 * From an admins list, try to detect which one is the most appropriate to contact.
 * Because HelloWorks doesn't support sending to multiple recipients.
 */
const getMainAdminToContact = async (account, adminUsers) => {
  if (adminUsers.length > 1) {
    const latestExpense = await models.Expense.findOne({
      order: [['createdAt', 'DESC']],
      where: {
        FromCollectiveId: account.id,
        UserId: { [Op.in]: adminUsers.map(u => u.id) },
      },
    });

    const mainUser = latestExpense && adminUsers.find(u => u.id === latestExpense.UserId);
    if (mainUser) {
      return mainUser;
    }
  }

  return adminUsers[0];
};

/**
 * Generate a name for the participant, combining the account name with the user name
 * if it's a group (organization, collective, etc). Strings are truncated if too long
 * to match the `64` characters limit from HelloWorks.
 */
const generateParticipantName = (account, mainUser) => {
  if (account.id === mainUser.collective.id) {
    return truncate(account.name, { length: 64 });
  } else {
    return `${truncate(account.slug, { length: 30 })} (${truncate(mainUser.collective.name, { length: 30 })})`;
  }
};

export async function sendHelloWorksUsTaxForm(client, account, year, callbackUrl, workflowId) {
  const adminUsers = await getAdminsForAccount(account);
  const mainUser = await getMainAdminToContact(account, adminUsers);

  if (!mainUser) {
    logger.error(`No contact found for account #${account.id} (@${account.slug}). Skipping tax form.`);
    return;
  }

  const participants = {
    // eslint-disable-next-line camelcase
    participant_swVuvW: {
      type: 'email',
      value: mainUser.email,
      fullName: generateParticipantName(account, mainUser),
    },
  };

  const saveDocumentStatus = status => {
    return LegalDocument.findOrCreate({
      where: { documentType: US_TAX_FORM, year, CollectiveId: account.id },
    }).then(([doc]) => {
      doc.requestStatus = status;
      return doc.save();
    });
  };

  try {
    await client.workflowInstances.createInstance({
      callbackUrl,
      workflowId,
      documentDelivery: true,
      participants,
      metadata: {
        accountType: account.type,
        accountId: account.id,
        adminEmails: adminUsers.map(u => u.email).join(', '),
        userId: mainUser.id,
        email: mainUser.email,
        year,
      },
    });

    return saveDocumentStatus(LegalDocument.requestStatus.REQUESTED);
  } catch (error) {
    logger.error(`Failed to initialize tax form for account #${account.id} (${mainUser.email})`, error);
    return saveDocumentStatus(LegalDocument.requestStatus.ERROR);
  }
}
