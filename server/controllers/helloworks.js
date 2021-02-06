import config from 'config';
import HelloWorks from 'helloworks-sdk';
import { get } from 'lodash';

import { uploadToS3 } from '../lib/awsS3';
import { secretbox } from '../lib/encryption';
import logger from '../lib/logger';
import models from '../models';

const { User, LegalDocument, RequiredLegalDocument } = models;
const {
  requestStatus: { ERROR, RECEIVED },
} = LegalDocument;
const {
  documentType: { US_TAX_FORM },
} = RequiredLegalDocument;

const HELLO_WORKS_KEY = get(config, 'helloworks.key');
const HELLO_WORKS_SECRET = get(config, 'helloworks.secret');
const HELLO_WORKS_WORKFLOW_ID = get(config, 'helloworks.workflowId');

const HELLO_WORKS_S3_BUCKET = get(config, 'helloworks.aws.s3.bucket');
const ENCRYPTION_KEY = get(config, 'helloworks.documentEncryptionKey');

// Put legacy workflows here
const SUPPORTED_WORKFLOWS = new Set([
  HELLO_WORKS_WORKFLOW_ID,
  'MfmOZErmhz1qPgMp',
  'MkFBvG39RIA61OnD',
  'qdUbX5nw8sMZzykz',
]);

function processMetadata(metadata) {
  // Check if metadata is malformed
  // ie: {"email,a@example.com":"1","userId,258567":"0","year,2019":"2"}
  const metadataNeedsFix = Math.max(...Object.values(metadata).map(value => value.length)) === 1;
  if (!metadataNeedsFix) {
    return metadata;
  }

  return Object.keys(metadata).reduce((acc, string) => {
    const [key, value] = string.split(',');
    acc[key] = value;
    return acc;
  }, {});
}

async function callback(req, res) {
  logger.info('Tax Form callback (raw):', req.rawBody);
  logger.info('Tax Form callback (parsed):', req.body);

  const client = new HelloWorks({
    apiKeyId: HELLO_WORKS_KEY,
    apiKeySecret: HELLO_WORKS_SECRET,
  });

  const {
    body: { status, workflow_id: workflowId, data, id, metadata: metadataReceived },
  } = req;

  const metadata = processMetadata(metadataReceived);
  if (status && status === 'completed' && SUPPORTED_WORKFLOWS.has(workflowId)) {
    const { userId, accountId, email, year } = metadata;
    const documentId = Object.keys(data)[0];
    const documentType = US_TAX_FORM;

    logger.info('Completed Tax form. Metadata:', metadata);

    let user, collective;

    if (accountId) {
      collective = await models.Collective.findByPk(accountId);
    }

    if (userId) {
      user = await User.findOne({ where: { id: userId } });
    } else if (email) {
      user = await User.findOne({ where: { email } });
    }
    if (!user) {
      logger.error('Tax Form: could not find user matching metadata', metadata);
      return res.sendStatus(400);
    } else if (!collective) {
      collective = await user.getCollective();
    }

    if (!collective) {
      logger.error('Tax Form: could not find collective matching metadata', metadata);
      return res.sendStatus(400);
    }

    const doc = await LegalDocument.findByTypeYearCollective({ year, documentType, collective });
    if (!doc) {
      logger.error(`No legal document  found for ${documentType}/${year}/${collective.slug}`);
      return res.sendStatus(400);
    }

    return client.workflowInstances
      .getInstanceDocument({ instanceId: id, documentId })
      .then(buff => Promise.resolve(secretbox.encrypt(buff, ENCRYPTION_KEY)))
      .then(buffer => uploadTaxFormToS3(buffer, { id: collective.name, year, documentType: US_TAX_FORM }))
      .then(({ Location: location }) => {
        doc.requestStatus = RECEIVED;
        doc.documentLink = location;
        return doc.save();
      })
      .then(() => res.sendStatus(200))
      .catch(err => {
        doc.requestStatus = ERROR;
        doc.save();
        logger.error('error saving tax form: ', err);
        res.sendStatus(400);
      });
  } else {
    res.sendStatus(200);
  }
}

function uploadTaxFormToS3(buffer, { id, year, documentType }) {
  const bucket = HELLO_WORKS_S3_BUCKET;
  const key = createTaxFormFilename({ id, year, documentType });

  return uploadToS3({ Body: buffer, Bucket: bucket, Key: key });
}

function createTaxFormFilename({ id, year, documentType }) {
  return `${documentType}_${year}_${id}.pdf`;
}

export default {
  callback,
};
