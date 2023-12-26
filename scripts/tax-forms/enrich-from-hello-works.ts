/**
 * Enrich a tax form CSV with data from HelloWorks
 */

import '../../server/env';

import config from 'config';
import HelloWorks from 'helloworks-sdk';
import { get } from 'lodash';

import { HelloWorksTaxFormInstance } from '../../server/controllers/helloworks';
import models, { Op } from '../../server/models';

const HELLO_WORKS_KEY = get(config, 'helloworks.key');
const HELLO_WORKS_SECRET = get(config, 'helloworks.secret');
const HELLO_WORKS_WORKFLOW_ID = get(config, 'helloworks.workflowId');

if (!HELLO_WORKS_KEY || !HELLO_WORKS_SECRET || !HELLO_WORKS_WORKFLOW_ID) {
  throw new Error('Missing HelloWorks configuration');
}

async function main() {
  const client = new HelloWorks({ apiKeyId: HELLO_WORKS_KEY, apiKeySecret: HELLO_WORKS_SECRET });
  const pageSize = 100;
  let offset = 0;
  let result;

  do {
    result = await models.LegalDocument.findAndCountAll({
      limit: pageSize,
      offset,
      order: [['id', 'ASC']],
      where: {
        documentType: 'US_TAX_FORM',
        requestStatus: 'RECEIVED',
        data: {
          helloWorksInstance: { [Op.eq]: null },
          helloWorks: { instance: { id: { [Op.ne]: null } } },
        },
      },
    });

    for (const doc of result.rows) {
      const instanceId = doc.data.helloWorks.instance.id;
      const instance = (await client.workflowInstances.getInstance({ instanceId })) as HelloWorksTaxFormInstance;
      if (!instance) {
        console.log('No metadata for', doc.id);
        continue;
      } else if (instance.status !== 'completed') {
        console.log('Instance not completed', doc.id);
        continue;
      } else {
        await doc.update({ data: { ...doc.data, helloWorksInstance: instance } });
      }
    }
  } while (result.count > ++offset * pageSize);
}

main()
  .then(() => {
    console.log('Done');
    process.exit();
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
