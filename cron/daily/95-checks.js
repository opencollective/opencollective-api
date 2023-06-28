#!/usr/bin/env node
import '../../server/env';

import { checkAllModels } from '../../checks/model';
import email from '../../server/lib/email';

const recipients = 'ops@opencollective.com';

const subject = 'Daily Checks failed';

async function run() {
  const { errors } = await checkAllModels();

  if (errors.length > 0) {
    const text = `The Daily Checks Job failed today.\n\n${errors
      .map(msg => `- ${msg}`)
      .join('\n')}\n\nTo fix the models, try: npm run script checks/model -- --fix`;

    console.log({ text });

    return email.sendMessage(recipients, subject, text, { text });
  }

  process.exit();
}

run();
