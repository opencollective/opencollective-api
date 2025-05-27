import '../../server/env';

import logger from '../../server/lib/logger';
import models from '../../server/models';
import { runCronJob } from '../utils';

async function expireTaxForms() {
  const nbUpdated = await models.LegalDocument.expireOldDocuments();
  logger.info(`Expired ${nbUpdated} legal documents`);
}

if (require.main === module) {
  runCronJob('expire-legal-documents', expireTaxForms, 23 * 60 * 60);
}
