import { get } from 'lodash';

import { LegalDocument } from '../../models';
import { USTaxFormType } from '../../models/LegalDocument';

type TaxFormCSVFields = {
  type?: USTaxFormType;
  participantName?: string;
  entityName?: string;
  address1?: string;
  address2?: string;
  taxIdNumberType?: string;
  taxIdNumber?: string;
  country?: string;
  email?: string;
  status?: string;
  instanceId?: string;
};

type HelloWorksTaxFormInstance = {
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

const tryAndDecryptInstance = (encryptedFormData: string): HelloWorksTaxFormInstance => {
  try {
    return JSON.parse(LegalDocument.decrypt(Buffer.from(encryptedFormData, 'base64')).toString());
  } catch {
    return null;
  }
};

export const getFormFieldsFromHelloWorksInstance = (recipientData: Record<string, unknown>): TaxFormCSVFields => {
  if (!recipientData?.encryptedFormData || typeof recipientData.encryptedFormData !== 'string') {
    return {};
  }

  const instance = tryAndDecryptInstance(recipientData.encryptedFormData);
  const baseData = {
    email: instance?.metadata?.email,
    instanceId: get(recipientData, 'helloWorks.instance.id') as string,
  };

  if (!instance?.data) {
    return baseData;
  } else if (instance.data.Form_nRZrdh) {
    const data = instance.data.Form_nRZrdh;
    const participantName = data.field_JI6gsq || data.field_mqVUrj || data.field_Xdy5Kk || data.field_3HxExU;
    const entityName = data.field_3HxExU || data.field_vBxRqQ || data.field_3IvuYi || data.field_F1U7HL;
    return {
      ...baseData,
      // Participant name == signer name
      type:
        data.field_ENxHCd === 'Yes'
          ? 'W9'
          : data.field_xdp45L === 'a business or entity'
            ? 'W8_BEN_E'
            : data.field_xdp45L === 'an individual person'
              ? 'W8_BEN'
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
      email: data.field_gwd8pa || baseData.email,
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
      ...baseData,
      type:
        data.field_Jj5lq3 === 'Yes'
          ? 'W9'
          : data.field_W7cOxA === 'a business or entity'
            ? 'W8_BEN_E'
            : data.field_W7cOxA === 'an individual person'
              ? 'W8_BEN'
              : null,
      participantName: data.field_nTuM3q || data.field_7G0PTT || data.field_pLPdKR || data.field_TDe8mH,
      address1: data.field_Zdjn7X || data.field_nSSZij || data.field_nhEGv2,
      address2: data.field_2A7YUM,
      taxIdNumberType: data.field_GP1WVV || ((data.field_TDttcV || data.field_NwJcK9) && 'Foreign'),
      taxIdNumber:
        data.field_IHousr || data.field_U1SIy7 || data.field_YBBuNx || data.field_TDttcV || data.field_NwJcK9,
      country: data.field_Jj5lq3 === 'Yes' ? 'United States' : data.field_VjJblP || data.field_ro87Pn,
      email: data.field_LEHARZ || baseData.email,
      status:
        data.field_W7cOxA === 'an individual person'
          ? 'Individual (or sole proprietor)'
          : data.field_TDyswI === 'Other (specify at the end of this form)'
            ? `Other: ${data.field_uRwOOO}`
            : data.field_TDyswI || data.field_W7cOxA,
    };
  } else {
    console.warn('Could not find form data in HelloWorks instance', instance);
    return { ...baseData, email: baseData.email };
  }
};
