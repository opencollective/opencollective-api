import '../../server/env';

import { checkAllModels } from '../../checks/model';
import email from '../../server/lib/email';

const recipients = 'ops@opencollective.com';

const subject = 'Daily Checks failed';

const failureMessage = 'The Daily Checks failed today with the following errors:';
const fixMessage = 'To fix the models, try:';
const fixCommand = 'npm run script checks/model -- --fix';

async function run() {
  const { errors } = await checkAllModels();

  if (errors.length > 0) {
    const html = `${failureMessage}<br>\n<br>\n${errors
      .map(msg => `<li> ${msg}`)
      .join('\n')}<br>\n<br>\n${fixMessage} <code>${fixCommand}</code>`;

    const text = `${failureMessage}\n\n${errors.map(msg => `- ${msg}`).join('\n')}\n\n${fixMessage} ${fixCommand}`;

    return email.sendMessage(recipients, subject, html, { text });
  }

  process.exit();
}

run();
