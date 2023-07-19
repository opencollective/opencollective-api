#!/usr/bin/env node
import '../../server/env.js';
import '../../server/lib/sentry.js';

import email from '../../server/lib/email.js';
import { reportErrorToSentry } from '../../server/lib/sentry.js';

const recipients = 'ops@opencollective.com';

const subject = 'Daily Cron Job completed';

const text = 'The Daily Cron Job successfully completed again today.';

const html = text;

function run() {
  return email.sendMessage(recipients, subject, html, { text });
}

run()
  .then(() => {
    console.log(text);
    process.exit(0);
  })
  .catch(error => {
    console.error(error);
    reportErrorToSentry(error);
    process.exit(1);
  });
