#!/usr/bin/env node
import '../../server/env';

import config from 'config';
import HelloWorks from 'helloworks-sdk';
import { uniqBy } from 'lodash';
import moment from 'moment';
import pThrottle from 'p-throttle';

import { reportErrorToSentry } from '../../server/lib/sentry';
import { findAccountsThatNeedToBeSentTaxForm, sendHelloWorksUsTaxForm } from '../../server/lib/tax-forms';
import { sequelize } from '../../server/models';

const MAX_REQUESTS_PER_SECOND = 1;
const ONE_SECOND_IN_MILLISECONDS = 1000;

const WORKFLOW_ID = config.get('helloworks.workflowId');
const CALLBACK_PATH = config.get('helloworks.callbackPath');
const CALLBACK_URL = `${config.get('host.api')}${CALLBACK_PATH}`;

const year = moment().year();

const client = new HelloWorks({
  apiKeyId: config.get('helloworks.key'),
  apiKeySecret: config.get('helloworks.secret'),
});

const throttle = pThrottle({ limit: MAX_REQUESTS_PER_SECOND, interval: ONE_SECOND_IN_MILLISECONDS });

const init = async () => {
  console.log('>>>> Running tax form job');

  // In January, we keep looking at tax forms for the previous year as they might have been missed because of the limit
  let accountsFromLastYear = [];
  if (moment().month() === 0) {
    accountsFromLastYear = await findAccountsThatNeedToBeSentTaxForm(year - 1);
    if (accountsFromLastYear.length > 0) {
      console.log(`>> Found ${accountsFromLastYear.length} accounts from last year that still need their tax form`);
    }
  }

  const accountsFromThisYear = await findAccountsThatNeedToBeSentTaxForm(year);
  const allAccounts = uniqBy([...accountsFromLastYear, ...accountsFromThisYear], 'id'); // The order is important here, we want to prioritize accounts from last year

  const throttledFunc = throttle(account => {
    console.log(`>> Sending tax form to account: ${account.name} (@${account.slug})`);
    if (!process.env.DRY_RUN) {
      return sendHelloWorksUsTaxForm(client, account, year, CALLBACK_URL, WORKFLOW_ID);
    }
  });

  return Promise.all(allAccounts.map(throttledFunc));
};

init()
  .catch(error => {
    console.error(error);
    reportErrorToSentry(error);
  })
  .finally(() => {
    sequelize.close();
  });
