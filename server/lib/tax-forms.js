import config from 'config';

import models, { Op } from '../models';

import logger from './logger';
import queries from './queries';
import { isEmailInternal } from './utils';

const { RequiredLegalDocument, LegalDocument } = models;
const {
  documentType: { US_TAX_FORM },
} = RequiredLegalDocument;

export async function findUsersThatNeedToBeSentTaxForm(year) {
  const results = await queries.getTaxFormsRequiredForAccounts(null, new Date(year, 1));

  if (!results.length) {
    return [];
  } else {
    return models.User.findAll({
      where: { CollectiveId: { [Op.in]: results.map(result => result.collectiveId) } },
    });
  }
}

export function SendHelloWorksTaxForm({ client, callbackUrl, workflowId, year }) {
  return async function sendHelloWorksUsTaxForm(user) {
    const userCollective = await user.getCollective();

    const participants = {
      // eslint-disable-next-line camelcase
      participant_swVuvW: {
        type: 'email',
        value: user.email,
        fullName: `${userCollective.name}`,
      },
    };

    const saveDocumentStatus = status => {
      return LegalDocument.findOrCreate({
        where: { documentType: US_TAX_FORM, year, CollectiveId: userCollective.id },
      }).then(([doc]) => {
        doc.requestStatus = status;
        return doc.save();
      });
    };

    try {
      // Don't send emails on dev/staging environments to ensure we never trigger a notification
      // from HelloWorks for users when we shouldn't.
      if (config.env === 'production' || isEmailInternal(user.email)) {
        await client.workflowInstances.createInstance({
          callbackUrl,
          workflowId,
          documentDelivery: true,
          participants,
          metadata: {
            userId: user.id,
            email: user.email,
            year,
          },
        });
        return saveDocumentStatus(LegalDocument.requestStatus.REQUESTED);
      } else {
        logger.info(`${user.email} is an external email address, skipping HelloWorks in development environment`);
      }
    } catch (error) {
      logger.info(`Failed to initialize tax form for user #${user.id} (${user.email})`);
      return saveDocumentStatus(LegalDocument.requestStatus.ERROR);
    }
  };
}
