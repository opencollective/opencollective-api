/**
 * This scripts aims to import the data we have on Dropbox Forms to our database, encrypted like
 * the rest of internalized tax forms data.
 */

import '../../server/env';

import config from 'config';
import HelloWorks from 'helloworks-sdk';
import { get } from 'lodash';
import { encodeBase64 } from 'tweetnacl-util';

import { HelloWorksTaxFormInstance } from '../../server/controllers/helloworks';
import logger from '../../server/lib/logger';
import models, { Op } from '../../server/models';
import LegalDocument, {
  LEGAL_DOCUMENT_REQUEST_STATUS,
  LEGAL_DOCUMENT_SERVICE,
  LEGAL_DOCUMENT_TYPE,
} from '../../server/models/LegalDocument';

const HELLO_WORKS_KEY = get(config, 'helloworks.key');
const HELLO_WORKS_SECRET = get(config, 'helloworks.secret');
const HELLO_WORKS_WORKFLOW_ID = get(config, 'helloworks.workflowId');
const DRY_RUN = process.env.DRY_RUN !== 'false';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT) : null;

if (!HELLO_WORKS_KEY || !HELLO_WORKS_SECRET || !HELLO_WORKS_WORKFLOW_ID) {
  throw new Error('Missing HelloWorks configuration');
}

const encryptInstance = (instance: HelloWorksTaxFormInstance) => {
  return encodeBase64(LegalDocument.encrypt(Buffer.from(JSON.stringify(instance))));
};

async function main() {
  const client = new HelloWorks({ apiKeyId: HELLO_WORKS_KEY, apiKeySecret: HELLO_WORKS_SECRET });
  const pageSize = 100;
  let totalProcessed = 0;
  let offset = 0;
  let result;

  do {
    result = await models.LegalDocument.findAndCountAll({
      limit: pageSize,
      offset,
      order: [['id', 'ASC']],
      where: {
        service: LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS,
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        data: {
          encryptedFormData: { [Op.eq]: null },
          helloWorks: { instance: { id: { [Op.ne]: null } } },
        },
      },
    });

    for (const doc of result.rows) {
      const instanceId = doc.data.helloWorks.instance.id;
      const instance = (await client.workflowInstances.getInstance({ instanceId })) as HelloWorksTaxFormInstance;
      if (!instance) {
        logger.info('No metadata for', doc.id);
      } else if (instance.status !== 'completed') {
        logger.info('Instance not completed', doc.id);
      } else if (DRY_RUN) {
        logger.info(`Would update ${doc.id} with:`);
        logger.debug(instance);
        logger.debug('Encrypted data:');
        const encryptedData = encryptInstance(instance);
        logger.debug(encryptedData);
        logger.debug('Decrypted data:');
        logger.debug(LegalDocument.decrypt(Buffer.from(encryptedData, 'base64')).toString());
      } else {
        await doc.update({ data: { ...doc.data, encryptedFormData: encryptInstance(instance) } });
      }

      if (LIMIT && ++totalProcessed >= LIMIT) {
        logger.info('Limit reached');
        return;
      }
    }
  } while (result.count > ++offset * pageSize);
}

main()
  .then(() => {
    logger.info('Done');
    process.exit();
  })
  .catch(e => {
    logger.error(e);
    process.exit(1);
  });
