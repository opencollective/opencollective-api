import config from 'config';
import HelloWorks from 'helloworks-sdk';
import { get } from 'lodash';

import { uploadToS3 } from '../lib/awsS3';
import { secretbox } from '../lib/encryption';
import logger from '../lib/logger';
import { reportErrorToSentry, reportMessageToSentry } from '../lib/sentry';
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

export type HelloWorksTaxFormInstance = {
  audit_trail_hash: string;
  id: string;
  metadata: {
    accountId: string;
    accountType: string;
    adminEmails: string;
    email: string;
    userId: string;
    year: string;
  };
  status: string;
  workflow_id: string;
  document_hashes: Record<string, string>;
  mode: string;
  type: string;
  data: {
    Form_nRZrdh: {
      /** Name of organization that is the beneficial owner */
      field_3HxExU: string;
      /** Chapter 3 Status (entity type) */
      field_7h9cxX: string;
      field_96QX5j: string;
      field_ENxHCd: string;
      field_FTZIWD: string;
      field_G7YfJr: string;
      field_OSOk14: string;
      /** Permanent residence address */
      field_T0IdZf: string;
      /** Country of incorporation or organization */
      field_VvICe1: string;
      field_gwd8pa: string;
      /** Foreign TIN */
      field_hJkq4B: string;
      field_hWAMyS: string;
      /** Name of the signer */
      field_mqVUrj: string;
      /** Mailing address */
      field_pITmtq: string;
      field_xdp45L: string;
    };
  };
};

function processMetadata(metadata: HelloWorksTaxFormInstance['metadata']): HelloWorksTaxFormInstance['metadata'] {
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
  }, {}) as HelloWorksTaxFormInstance['metadata'];
}

async function callback(req, res) {
  logger.info('Tax Form callback (parsed):', req.body);

  const client = new HelloWorks({
    apiKeyId: HELLO_WORKS_KEY,
    apiKeySecret: HELLO_WORKS_SECRET,
  });

  const body = req.body as HelloWorksTaxFormInstance;
  const { status, workflow_id: workflowId, data, id, metadata: metadataReceived } = body;

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
      reportMessageToSentry('Tax Form: could not find user matching metadata', { extra: { metadata } });
      return res.sendStatus(400);
    } else if (!collective) {
      collective = await user.getCollective();
    }

    if (!collective) {
      logger.error('Tax Form: could not find collective matching metadata', metadata);
      reportMessageToSentry('Tax Form: could not find collective matching metadata', { extra: { metadata } });
      return res.sendStatus(400);
    }

    const doc = await LegalDocument.findByTypeYearCollective({ year, documentType, collective });
    if (!doc) {
      logger.error(`No legal document found for ${documentType}/${year}/${collective.slug}`);
      reportMessageToSentry(`Tax Form: No legal document found`, {
        extra: { documentType, year, collective: collective.info },
      });
      return res.sendStatus(400);
    }

    return client.workflowInstances
      .getInstanceDocument({ instanceId: id, documentId })
      .then(buff => Promise.resolve(secretbox.encrypt(buff, ENCRYPTION_KEY)))
      .then(buffer => uploadTaxFormToS3(buffer, { id: collective.name, year, documentType: US_TAX_FORM }))
      .then(({ url }) => {
        doc.requestStatus = RECEIVED;
        doc.documentLink = url;
        doc.data = { ...doc.data, helloWorksInstance: body };
        return doc.save();
      })
      .then(() => res.sendStatus(200))
      .catch(err => {
        doc.requestStatus = ERROR;
        doc.save();
        logger.error('error saving tax form: ', err);
        reportErrorToSentry(err);
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
  if (year >= 2023) {
    return `${documentType}/${year}/${id}.pdf`;
  } else {
    return `${documentType}_${year}_${id}.pdf`;
  }
}

export default {
  callback,
};
