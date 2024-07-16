import '../../server/env';

import email from '../../server/lib/email';
import { runCronJob } from '../utils';

const recipients = 'ops@opencollective.com';

const subject = 'Daily Cron Job completed';

const text = 'The Daily Cron Job successfully completed again today.';

const html = text;

function run() {
  return email.sendMessage(recipients, subject, html, { text });
}

runCronJob('done', run, 24 * 60 * 60);
