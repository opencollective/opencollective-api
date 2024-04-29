import config from 'config';
import deepMerge from 'deepmerge';
import HelloWorks from 'helloworks-sdk';
import { get, truncate } from 'lodash';

import { activities } from '../constants';
import {
  TAX_FORM_IGNORED_EXPENSE_STATUSES,
  TAX_FORM_IGNORED_EXPENSE_TYPES,
  US_TAX_FORM_THRESHOLD,
  US_TAX_FORM_THRESHOLD_FOR_PAYPAL,
} from '../constants/tax-form';
import models, { Collective, Expense, Op } from '../models';
import LegalDocument, {
  LEGAL_DOCUMENT_REQUEST_STATUS,
  LEGAL_DOCUMENT_SERVICE,
  LEGAL_DOCUMENT_TYPE,
} from '../models/LegalDocument';

import { uploadToS3 } from './awsS3';
import logger from './logger';
import SQLQueries from './queries';
import { reportErrorToSentry, reportMessageToSentry } from './sentry';
import { isEmailInternal } from './utils';

export const getTaxFormsS3Bucket = (): string => {
  return get(config, 'taxForms.aws.s3.bucket');
};

/**
 * @returns {Collective} all the accounts that need to be sent a tax form (both users and orgs)
 * @param {number} year
 */
export async function findAccountsThatNeedToBeSentTaxForm(year: number): Promise<Collective[]> {
  const collectiveIds: Set<number> = await SQLQueries.getTaxFormsRequiredForAccounts({ year, ignoreReceived: true });
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
  } else if (account.id === mainUser.collective.id && account.name) {
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
  account: Collective,
  year: number,
  callbackUrl: string,
  workflowId: string,
): Promise<LegalDocument> {
  const host = await account.getHostCollective();
  const accountToSubmitRequestTo = host || account; // If the account has a fiscal host, it's its responsibility to fill the request
  const adminUsers = await getAdminsForAccount(accountToSubmitRequestTo);
  const mainUser = await getMainAdminToContact(accountToSubmitRequestTo, adminUsers);
  if (!mainUser) {
    logger.error(`No contact found for account #${account.id} (@${account.slug}). Skipping tax form.`);
    reportMessageToSentry('Tax form: No contact found', { extra: { collectiveId: account.id } });
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
    await models.Activity.create({
      type: activities.TAXFORM_REQUEST,
      UserId: mainUser.id,
      CollectiveId: accountToSubmitRequestTo.id,
      data: {
        service: LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS,
        documentLink,
        recipientName,
        accountName,
        isSystem: true,
      },
    });
    return document;
  } catch (error) {
    logger.error(
      `Failed to initialize tax form for account #${accountToSubmitRequestTo.id} (${mainUser.email})`,
      error,
    );
    reportErrorToSentry(error);
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

export const expenseMightBeSubjectToTaxForm = (expense: Expense): boolean => {
  return (
    !(TAX_FORM_IGNORED_EXPENSE_TYPES as readonly string[]).includes(expense.type) &&
    !(TAX_FORM_IGNORED_EXPENSE_STATUSES as readonly string[]).includes(expense.status)
  );
};

export function encryptAndUploadTaxFormToS3(
  buffer: Buffer,
  collective: Collective,
  year: number | string,
  valuesHash: string = 'none',
) {
  const bucket = getTaxFormsS3Bucket();
  const key = createTaxFormFilename({ collective, year, documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM, valuesHash });
  const encryptedBuffer = LegalDocument.encrypt(buffer);
  return uploadToS3({
    Body: encryptedBuffer,
    Bucket: bucket,
    Key: key,
    Metadata: { collectiveId: `${collective.id}`, valuesHash },
  });
}

function createTaxFormFilename({ collective, year, documentType, valuesHash }) {
  if (year >= 2023) {
    return valuesHash && valuesHash !== 'none'
      ? `${documentType}/${year}/${collective.name}_${valuesHash}.pdf`
      : `${documentType}/${year}/${collective.name}.pdf`;
  } else {
    return `${documentType}_${year}_${collective.name}.pdf`;
  }
}
