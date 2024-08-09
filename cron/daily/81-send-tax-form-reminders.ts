import '../../server/env';

import logger from '../../server/lib/logger';
import { LegalDocument } from '../../server/models';
import { runCronJob } from '../utils';

const run = async () => {
  logger.info('>>>> Running tax form job');
  await LegalDocument.sendRemindersForTaxForms();
};

if (require.main === module) {
  runCronJob('send-tax-form-requests', run, 60 * 60);
}
