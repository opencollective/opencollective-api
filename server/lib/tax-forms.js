import config from 'config';

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
 * Because HelloWorks don't support sending to multiple recipants.
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

export async function sendHelloWorksUsTaxForm(client, account, year, callbackUrl, workflowId) {
  const adminUsers = await getAdminsForAccount(account);
  const mainUser = await getMainAdminToContact(account, adminUsers);

  if (!mainUser) {
    logger.error(`No contact found for account #${account.id} (@${account.slug}). Skipping tax form.`);
    return;
  }

  const isTaxFormForUser = account.id === mainUser.collective.id;
  const participants = {
    // eslint-disable-next-line camelcase
    participant_swVuvW: {
      type: 'email',
      value: mainUser.email,
      fullName: isTaxFormForUser ? account.name : `${account.slug} (${mainUser.collective.name})`,
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
