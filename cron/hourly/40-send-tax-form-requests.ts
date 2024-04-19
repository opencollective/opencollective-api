#!/usr/bin/env node

import '../../server/env';

import config from 'config';
import HelloWorks from 'helloworks-sdk';
import { uniq } from 'lodash';
import moment from 'moment';
import pThrottle from 'p-throttle';

import { activities } from '../../server/constants';
import logger from '../../server/lib/logger';
import { notify } from '../../server/lib/notifications/email';
import SQLQueries from '../../server/lib/queries';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { findAccountsThatNeedToBeSentTaxForm, sendHelloWorksUsTaxForm } from '../../server/lib/tax-forms';
import { parseToBoolean } from '../../server/lib/utils';
import { Activity, Collective, LegalDocument, Op } from '../../server/models';
import {
  LEGAL_DOCUMENT_REQUEST_STATUS,
  LEGAL_DOCUMENT_SERVICE,
  LEGAL_DOCUMENT_TYPE,
} from '../../server/models/LegalDocument';

const MAX_REQUESTS_PER_SECOND = 1;
const ONE_SECOND_IN_MILLISECONDS = 1000;

const WORKFLOW_ID = config.get('helloworks.workflowId');
const CALLBACK_PATH = config.get('helloworks.callbackPath');
const CALLBACK_URL = `${config.get('host.api')}${CALLBACK_PATH}`;

const client = new HelloWorks({
  apiKeyId: config.get('helloworks.key'),
  apiKeySecret: config.get('helloworks.secret'),
});

const throttle = pThrottle({ limit: MAX_REQUESTS_PER_SECOND, interval: ONE_SECOND_IN_MILLISECONDS });

export const run = async () => {
  logger.info('>>>> Running tax form job');
  if (parseToBoolean(config.taxForms.useInternal)) {
    // With the internal tax form system, we only send the email as a reminder in case they don't fill
    // their tax forms right away.
    const requestedLegalDocuments = await LegalDocument.findAll({
      where: {
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        data: { reminderSentAt: null },
        createdAt: {
          [Op.lt]: moment().subtract(48, 'hours').toDate(),
          [Op.gt]: moment().subtract(7, 'days').toDate(),
        },
      },
    });

    // Filter out all the legal docs where a tax form is not needed anymore (e.g. because the expense amount was updated)
    const allAccountIds = uniq(requestedLegalDocuments.map(d => d.CollectiveId));
    const accountIdsWithPendingTaxForm = await SQLQueries.getTaxFormsRequiredForAccounts(allAccountIds);
    const filteredDocuments = requestedLegalDocuments.filter(d => accountIdsWithPendingTaxForm.has(d.CollectiveId));

    for (const legalDocument of filteredDocuments) {
      const correspondingActivity = await Activity.findOne({
        where: {
          type: activities.TAXFORM_REQUEST,
          CollectiveId: legalDocument.CollectiveId,
          data: { service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE, legalDocument: { id: legalDocument.id } },
        },
      });

      if (correspondingActivity) {
        logger.info(`>> Sending tax form reminder email to @${correspondingActivity.data?.collective?.slug}`);
        await notify.user(correspondingActivity);
        await legalDocument.update({ data: { ...legalDocument.data, reminderSentAt: new Date() } });
      }
    }
  } else {
    const year = moment().year();
    const accounts = await findAccountsThatNeedToBeSentTaxForm(year);
    const throttledFunc = throttle((account: Collective) => {
      logger.info(`>> Sending tax form to account: ${account.name} (@${account.slug})`);
      if (!process.env.DRY_RUN) {
        return sendHelloWorksUsTaxForm(client, account, year, CALLBACK_URL, WORKFLOW_ID);
      }
    });

    return Promise.all(accounts.map(throttledFunc));
  }
};

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(e => {
      logger.error('Error while sending tax forms reminders');
      console.error(e);
      reportErrorToSentry(e);
      process.exit(1);
    });
}
