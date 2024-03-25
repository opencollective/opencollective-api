import config from 'config';
import HelloWorks from 'helloworks-sdk';
import { get } from 'lodash';

import ActivityTypes from '../constants/activities';
import logger from '../lib/logger';
import { reportErrorToSentry, reportMessageToSentry } from '../lib/sentry';
import { encryptAndUploadTaxFormToS3 } from '../lib/tax-forms';
import models, { Activity } from '../models';
import { LEGAL_DOCUMENT_REQUEST_STATUS, LEGAL_DOCUMENT_SERVICE } from '../models/LegalDocument';

const { User, LegalDocument, RequiredLegalDocument } = models;

const {
  documentType: { US_TAX_FORM },
} = RequiredLegalDocument;

const HELLO_WORKS_KEY = get(config, 'helloworks.key');
const HELLO_WORKS_SECRET = get(config, 'helloworks.secret');
const HELLO_WORKS_WORKFLOW_ID = get(config, 'helloworks.workflowId');

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
    // Latest version of the form
    Form_nRZrdh?: {
      /** Name of organization that is the beneficial owner */
      field_3HxExU: string;
      /** Chapter 3 Status (entity type) */
      field_7h9cxX: string;
      field_96QX5j: string;
      /** Are you US Person or Entity? */
      field_ENxHCd: 'Yes' | 'No';
      field_FTZIWD: string;
      field_G7YfJr: string;
      field_OSOk14: string;
      /** Permanent residence address */
      field_T0IdZf: string;
      /** Country of incorporation or organization */
      field_VvICe1: string;
      /** Your_Email (Participant) */
      field_gwd8pa: string;
      /** Foreign TIN */
      field_hJkq4B: string;
      /** Name of disregarded entity receiving the payment */
      field_F1U7HL: string;
      field_hWAMyS: string;
      /** Name of the signer */
      field_mqVUrj: string;
      /** Mailing address */
      field_pITmtq: string;
      /** Are you submitting as... */
      field_xdp45L: 'an individual person' | 'a business or entity';
      /** Signature date */
      field_5yf9Bp: string;
      /** Foreign tax identifying number */
      field_JiKEj4: string;
      /** Certify country of residence */
      field_SZJNur: string;
      field_XdGK3o: string;
      /** Signer name */
      field_Xdy5Kk: string;
      // -----
      /** Signer name */
      field_JI6gsq: string;
      /** Enter_SSN (Participant) */
      field_SXcrBL: string;
      /** Address_(city,_state,_ZIP) (Participant) */
      field_bsHU5V: string;
      /** Tax ID number type */
      field_m4nLix: 'SSN' | 'EIN';
      field_oU5IRt: string;
      field_pxvAbW: string;
      /** Business type */
      field_ruhFN4:
        | 'Individual (or sole proprietor)'
        | 'C-Corp'
        | 'S-Corp'
        | 'Partnership'
        | 'Trust/Estate'
        | 'LLC'
        | 'Other (specify at the end of this form)';
      /** You selected "other tax classification" — please specify: */
      field_IYb1zy: string;
      // ----  US person/entity fields (field_ENxHCd=true) ----
      /** Name (Participant) */
      field_vBxRqQ: string;
      /** Address_(number,_street,_apt) (Participant) */
      field_y19HZi: string;
      /** Optional:_Exempt_payee_code_(if_any) (Participant) */
      field_tOgTam: string;
      /** Enter_EIN (Participant) */
      field_nsaxM8: string;
      /** U.S._SSN_or_ITIN_(if_required) (Participant) */
      field_iGedCY: string;
      // ---- W8-BEN (individuals) ----
      /** Permanent residence address (street, apt. or suite no., or rural route) */
      field_AdoY67: string;
      /** Country of citizenship */
      field_dIEvL2: string;
      /** Name of individual who is the beneficial owner */
      field_3IvuYi: string;
      field_26SpJI: string;
      field_2BzOcB: string;
      field_2o6n1d: string;
      /** Postal_address (Participant) */
      field_3j4IQT: string;
      /** Country of residence */
      field_e2uMPk: string;
    };
    // Legacy version of the form
    Form_jmV4rR?: {
      /** Participant name */
      field_nTuM3q: string;
      /** Date of birth  */
      field_5zvlrH: string;
      /** Name of individual that is the beneficial owner */
      field_7G0PTT: string;
      /** Do you claim tax treaty benefits for chapter 3 purposes? */
      field_8JIBUU: string;
      /** Signer name */
      field_HEJfi8: string;
      /** Are you US Person or Entity? */
      field_Jj5lq3: 'Yes' | 'No';
      /** Email */
      field_LEHARZ: string;
      /** Foreign tax identifying number */
      field_TDttcV: string;
      /** Mailing address */
      field_UXEERA: string;
      /** Country of citizenship */
      field_VjJblP: string;
      /** Are you submitting as... */
      field_W7cOxA: 'an individual person' | 'a business or entity';
      /** Has confirmed info */
      field_XKL6pp: 'Yes' | 'No';
      /** Signature date */
      field_kIEVyL: string;
      /** Permanent residence address */
      field_nhEGv2: string;
      // Conditional fields
      field_6qJvKv: string;
      /** Signature date */
      field_LCxCSj: string;
      /** Tax ID number type */
      field_GP1WVV: 'SSN' | 'EIN';
      /** SSN */
      field_IHousr: string;
      /** EIN */
      field_U1SIy7: string;
      /** US tax ID number */
      field_YBBuNx: string;
      /** Foreign tax identifying number */
      field_NwJcK9: string;
      /** You selected "other tax classification" — please specify: */
      field_uRwOOO: string;
      /** Name */
      field_Q3j60N: string;
      field_WHuufi: string;
      /** Permanent residence address (street, apt. or suite no., or rural route). */
      field_Zdjn7X: string;
      /** Certify that is not a financial institution */
      field_fAve48: 'Yes' | 'No';
      /** Name of organization that is the beneficial owner */
      field_pLPdKR: string;
      field_qXoH7X: string;
      /** Chapter 3 status */
      field_qgGMt1: string;
      /** Country of incorporation or organization */
      field_ro87Pn: string;
      /** Address_(number,_street,_apt) (Participant) */
      field_nSSZij: string;
      /** Address_(city,_state,_ZIP) (Participant) */
      field_2A7YUM: string;
      /** Business name */
      field_TDe8mH: string;
      /** Business type */
      field_TDyswI:
        | 'Individual (or sole proprietor)'
        | 'C-Corp'
        | 'S-Corp'
        | 'Partnership'
        | 'Trust/Estate'
        | 'LLC'
        | 'Other (specify at the end of this form)';
    };
  };
};

export const getFormFieldsFromHelloWorksInstance = (instance: HelloWorksTaxFormInstance) => {
  if (!instance?.data) {
    return {};
  } else if (instance.data.Form_nRZrdh) {
    const data = instance.data.Form_nRZrdh;
    const participantName = data.field_JI6gsq || data.field_mqVUrj || data.field_Xdy5Kk || data.field_3HxExU;
    const entityName = data.field_3HxExU || data.field_vBxRqQ || data.field_3IvuYi || data.field_F1U7HL;
    return {
      // Participant name == signer name
      type:
        data.field_ENxHCd === 'Yes'
          ? 'W9'
          : data.field_xdp45L === 'a business or entity'
            ? 'W8-BEN-E'
            : data.field_xdp45L === 'an individual person'
              ? 'W8-BEN'
              : null,
      participantName,
      entityName: participantName !== entityName ? entityName : null,
      address1: data.field_y19HZi || data.field_AdoY67 || data.field_3j4IQT || data.field_T0IdZf,
      address2: data.field_bsHU5V,
      taxIdNumberType: data.field_m4nLix || ((data.field_JiKEj4 || data.field_hJkq4B) && 'Foreign'),
      taxIdNumber:
        data.field_iGedCY || data.field_nsaxM8 || data.field_JiKEj4 || data.field_hJkq4B || data.field_SXcrBL,
      country:
        data.field_ENxHCd === 'Yes'
          ? 'United States'
          : data.field_VvICe1 || data.field_SZJNur || data.field_e2uMPk || data.field_dIEvL2,
      email: data.field_gwd8pa,
      status:
        data.field_xdp45L === 'an individual person'
          ? 'Individual (or sole proprietor)'
          : data.field_ruhFN4 === 'Other (specify at the end of this form)'
            ? `Other: ${data.field_IYb1zy}`
            : data.field_ruhFN4 || data.field_xdp45L,
    };
  } else if (instance.data.Form_jmV4rR) {
    const data = instance.data.Form_jmV4rR;
    return {
      type:
        data.field_Jj5lq3 === 'Yes'
          ? 'W9'
          : data.field_W7cOxA === 'a business or entity'
            ? 'W8-BEN-E'
            : data.field_W7cOxA === 'an individual person'
              ? 'W8-BEN'
              : null,
      participantName: data.field_nTuM3q || data.field_7G0PTT || data.field_pLPdKR || data.field_TDe8mH,
      address1: data.field_Zdjn7X || data.field_nSSZij || data.field_nhEGv2,
      address2: data.field_2A7YUM,
      taxIdNumberType: data.field_GP1WVV || ((data.field_TDttcV || data.field_NwJcK9) && 'Foreign'),
      taxIdNumber:
        data.field_IHousr || data.field_U1SIy7 || data.field_YBBuNx || data.field_TDttcV || data.field_NwJcK9,
      country: data.field_Jj5lq3 === 'Yes' ? 'United States' : data.field_VjJblP || data.field_ro87Pn,
      email: data.field_LEHARZ,
      status:
        data.field_W7cOxA === 'an individual person'
          ? 'Individual (or sole proprietor)'
          : data.field_TDyswI === 'Other (specify at the end of this form)'
            ? `Other: ${data.field_uRwOOO}`
            : data.field_TDyswI || data.field_W7cOxA,
    };
  } else {
    console.warn('Could not find form data in HelloWorks instance', instance);
    return {};
  }
};

const getClient = () => {
  return new HelloWorks({ apiKeyId: HELLO_WORKS_KEY, apiKeySecret: HELLO_WORKS_SECRET });
};

export const fetchHelloWorksInstance = async (instanceId: string): Promise<HelloWorksTaxFormInstance> => {
  const client = getClient();
  return client.workflowInstances.getInstance({ instanceId }) as Promise<HelloWorksTaxFormInstance>;
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

  const client = getClient();
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
      .then(buffer => encryptAndUploadTaxFormToS3(buffer, collective, year))
      .then(({ url }) => {
        doc.requestStatus = LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED;
        doc.documentLink = url;
        Activity.create({
          type: ActivityTypes.TAXFORM_RECEIVED,
          CollectiveId: collective.id,
          data: { service: LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS, document: doc.info },
        });
        return doc.save();
      })
      .then(() => res.sendStatus(200))
      .catch(err => {
        doc.requestStatus = LEGAL_DOCUMENT_REQUEST_STATUS.ERROR;
        doc.save();
        logger.error('error saving tax form: ', err);
        reportErrorToSentry(err);
        res.sendStatus(400);
      });
  } else {
    res.sendStatus(200);
  }
}

export default {
  callback,
};
