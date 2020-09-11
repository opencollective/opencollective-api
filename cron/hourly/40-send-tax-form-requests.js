#!/usr/bin/env node
import '../../server/env';

import config from 'config';
import HelloWorks from 'helloworks-sdk';
import moment from 'moment';
import pThrottle from 'p-throttle';

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

const init = async () => {
  console.log('>>>> Running tax form job');
  const accounts = await findAccountsThatNeedToBeSentTaxForm(year);

  if (process.env.DRY_RUN) {
    console.log('>> Doing tax form dry run. Accounts who need tax forms:');
    return Promise.all(
      accounts.map(
        pThrottle(
          account => console.log(`${account.name} (@${account.slug})`),
          MAX_REQUESTS_PER_SECOND,
          ONE_SECOND_IN_MILLISECONDS,
        ),
      ),
    );
  } else {
    return Promise.all(
      accounts.map(
        pThrottle(
          account => {
            console.log(`>> Sending tax form to account: ${account.name} (@${account.slug})`);
            return sendHelloWorksUsTaxForm(client, account, year, CALLBACK_URL, WORKFLOW_ID);
          },
          MAX_REQUESTS_PER_SECOND,
          ONE_SECOND_IN_MILLISECONDS,
        ),
      ),
    );
  }
};

init()
  .catch(error => {
    console.error(error);
  })
  .finally(() => {
    sequelize.close();
  });
