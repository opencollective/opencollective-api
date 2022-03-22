import config from 'config';
import deepMerge from 'deepmerge';
import HelloWorks from 'helloworks-sdk';
import { truncate } from 'lodash';

import { US_TAX_FORM_THRESHOLD, US_TAX_FORM_THRESHOLD_FOR_PAYPAL } from '../constants/tax-form';
import models, { Op } from '../models';
import { LEGAL_DOCUMENT_REQUEST_STATUS, LEGAL_DOCUMENT_TYPE } from '../models/LegalDocument';

import emailLib from './email';
import logger from './logger';
import queries from './queries';
import { isEmailInternal } from './utils';

/**
 * @returns {Collective} all the accounts that need to be sent a tax form (both users and orgs)
 * @param {number} year
 */
export async function findAccountsThatNeedToBeSentTaxForm(year: number): Promise<typeof models.Collective[]> {
  const collectiveIds = await queries.getTaxFormsRequiredForAccounts(null, year);
  if (!collectiveIds.size) {
    return [];
  } else {
    return models.Collective.findAll({
      where: { id: Array.from(collectiveIds) },
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
    collectiveAttributes: null, // Will fetch all the attributes
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
const generateParticipantName = (account, mainUser): string => {
  if (account.legalName) {
    // If a legal name is set, use it directly
    return truncate(account.legalName, { length: 64 });
  } else if (account.id === mainUser.collective.id) {
    // If this is for a user, use the user name
    return truncate(account.name, { length: 64 });
  } else {
    // Otherwise use a combination of the account slug + user name
    return `${truncate(account.slug, { length: 30 })} (${truncate(mainUser.collective.name, { length: 30 })})`;
  }
};

const saveDocumentStatus = (account, year, requestStatus, data) => {
  return models.LegalDocument.findOrCreate({
    where: { documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM, year, CollectiveId: account.id },
  }).then(([doc]) => {
    return doc.update({ requestStatus, data });
  });
};

export async function sendHelloWorksUsTaxForm(
  client: HelloWorks,
  account: typeof models.Collective,
  year: number,
  callbackUrl: string,
  workflowId: string,
): Promise<typeof models.LegalDocument> {
  const host = await account.getHostCollective();
  const accountToSubmitRequestTo = host || account; // If the account has a fiscal host, it's its responsibility to fill the request
  const adminUsers = await getAdminsForAccount(accountToSubmitRequestTo);
  const mainUser = await getMainAdminToContact(accountToSubmitRequestTo, adminUsers);
  if (!mainUser) {
    logger.error(`No contact found for account #${account.id} (@${account.slug}). Skipping tax form.`);
    return;
  }

  const participants = {
    // eslint-disable-next-line camelcase
    participant_swVuvW: {
      type: 'email',
      value: mainUser.email,
      fullName: generateParticipantName(accountToSubmitRequestTo, mainUser),
    },
  };

  try {
    const instance = await client.workflowInstances.createInstance({
      callbackUrl,
      workflowId,
      documentDelivery: true,
      documentDeliveryType: 'link',
      // delegatedAuthentication: true, // See "authenticated link" below.
      participants,
      metadata: {
        accountType: accountToSubmitRequestTo.type,
        accountId: accountToSubmitRequestTo.id,
        adminEmails: adminUsers.map(u => u.email).join(', '),
        userId: mainUser.id,
        email: mainUser.email,
        year,
      },
    });

    // Save the full instance in the database (for debugging purposes)
    const document = await saveDocumentStatus(accountToSubmitRequestTo, year, LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED, {
      helloWorks: { instance },
    });

    // Get the authenticated link ("delegated authentication")
    // We currently don't have access to this feature with our pricing plan
    // try {
    //   documentLink = await client.workflowInstances.getAuthenticatedLinkForStep({
    //     instanceId: instance.id,
    //     step: step.step,
    //   });
    // } catch (e) {
    //   // Fallback to the default `step.url` (unauthenticated link)
    //   logger.warn(`Tax form: error getting authenticated link for ${instance.id}: ${e.message}`);
    // }

    // Save the authenticated link to the database, in case we want to send it again later
    const step = instance.steps[0];
    const documentLink = step.url;
    await document.update({ data: deepMerge(document.data, { helloWorks: { documentLink } }) });

    // Send the actual email
    const recipientName = mainUser.collective.name || mainUser.collective.legalName;
    const accountName =
      accountToSubmitRequestTo.legalName || accountToSubmitRequestTo.name || accountToSubmitRequestTo.slug;
    const emailData = { documentLink, recipientName, accountName };
    return emailLib.send('tax-form-request', mainUser.email, emailData);
  } catch (error) {
    logger.error(
      `Failed to initialize tax form for account #${accountToSubmitRequestTo.id} (${mainUser.email})`,
      error,
    );
    return saveDocumentStatus(accountToSubmitRequestTo, year, LEGAL_DOCUMENT_REQUEST_STATUS.ERROR, {
      error: {
        message: error.message,
        stack: error.stack,
      },
    });
  }
}

export const amountsRequireTaxForm = (paypalTotal: number, otherTotal: number): boolean => {
  return otherTotal >= US_TAX_FORM_THRESHOLD || paypalTotal >= US_TAX_FORM_THRESHOLD_FOR_PAYPAL;
};
