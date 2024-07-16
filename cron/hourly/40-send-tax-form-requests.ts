import '../../server/env';

import config from 'config';
import HelloWorks from 'helloworks-sdk';
import moment from 'moment';
import pThrottle from 'p-throttle';

import logger from '../../server/lib/logger';
import { findAccountsThatNeedToBeSentTaxForm, sendHelloWorksUsTaxForm } from '../../server/lib/tax-forms';
import { parseToBoolean } from '../../server/lib/utils';
import { Collective, LegalDocument } from '../../server/models';
import { runCronJob } from '../utils';

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

const run = async () => {
  logger.info('>>>> Running tax form job');
  if (parseToBoolean(config.taxForms.useInternal)) {
    await LegalDocument.sendRemindersForTaxForms();
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

runCronJob('send-tax-form-requests', run, 60 * 60 * 1000);
