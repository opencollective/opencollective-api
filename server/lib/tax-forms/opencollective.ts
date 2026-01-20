import logger from '../logger';

import { TaxFormCSVColumns, TaxFormCSVRow } from './types';

enum TaxFormType {
  W9 = 'W9',
  W8_BEN = 'W8_BEN',
  W8_BEN_E = 'W8_BEN_E',
}

enum SubmitterType {
  Individual = 'Individual',
  Business = 'Business',
}

enum FederalTaxClassification {
  Individual = 'Individual',
  C_Corporation = 'C_Corporation',
  S_Corporation = 'S_Corporation',
  Partnership = 'Partnership',
  TrustEstate = 'TrustEstate',
  LimitedLiabilityCompany = 'LimitedLiabilityCompany',
  Other = 'Other',
}

enum Chapter3Status {
  Corporation = 'Corporation',
  Partnership = 'Partnership',
  SimpleTrust = 'SimpleTrust',
  TaxExemptOrganization = 'TaxExemptOrganization',
  ComplexTrust = 'ComplexTrust',
  ForeignGovernmentControlledEntity = 'ForeignGovernmentControlledEntity',
  CentralBankOfIssue = 'CentralBankOfIssue',
  PrivateFoundation = 'PrivateFoundation',
  Estate = 'Estate',
  ForeignGovernmentIntegralPart = 'ForeignGovernmentIntegralPart',
  GrantorTrust = 'GrantorTrust',
  DisregardedEntity = 'DisregardedEntity',
  InternationalOrganization = 'InternationalOrganization',
}

enum TypeOfLimitationOnBenefitsProvisions {
  Government = 'Government',
  TaxExemptPensionTrustOrPensionFund = 'TaxExemptPensionTrustOrPensionFund',
  OtherTaxExemptOrganization = 'OtherTaxExemptOrganization',
  PubliclyTradedCorporation = 'PubliclyTradedCorporation',
  SubsidiaryOfAPubliclyTradedCorporation = 'SubsidiaryOfAPubliclyTradedCorporation',
  CompanyThatMeetsTheOwnershipAndBaseErosionTest = 'CompanyThatMeetsTheOwnershipAndBaseErosionTest',
  CompanyThatMeetsTheDerivativeBenefitsTest = 'CompanyThatMeetsTheDerivativeBenefitsTest',
  CompanyWithAnItemOfIncomeThatMeetsActiveTradeOrBusinessTest = 'CompanyWithAnItemOfIncomeThatMeetsActiveTradeOrBusinessTest',
  FavorableDiscretionaryDeterminationByTheUSCompetentAuthorityReceived = 'FavorableDiscretionaryDeterminationByTheUSCompetentAuthorityReceived',
  NoLOBArticleInTreaty = 'NoLOBArticleInTreaty',
  Other = 'Other',
}

enum NFFEStatus {
  ActiveNFFE = 'ActiveNFFE',
  PassiveNFFE = 'PassiveNFFE',
  NonProfitOrganization = 'NonProfitOrganization',
}

type W9TaxFormValues = {
  isUSPersonOrEntity?: boolean;
  submitterType?: SubmitterType;
  formType?: TaxFormType;
  email?: string;
  signer?: { firstName?: string; middleName?: string; lastName?: string };
  isSigned?: boolean;
  businessName?: string;
  federalTaxClassificationDetails?: string;
  llcTaxClassification?: 'C' | 'S' | 'P' | '';
  exemptPayeeCode?: string;
  fatcaExemptionCode?: string;
  taxIdNumberType?: 'SSN' | 'EIN';
  taxIdNumber?: string;
  accountNumbers?: string;
  federalTaxClassification?: FederalTaxClassification;
  hasConfirmedTOS?: boolean;
  location?: {
    country?: string;
    structured?: { address1?: string; address2?: string; city?: string; zone?: string; postalCode?: string };
  };
};

type W8BenTaxFormValues = ({
  isUSPersonOrEntity?: boolean;
  submitterType?: SubmitterType;
  formType?: TaxFormType;
  email?: string;
  signer?: { firstName?: string; middleName?: string; lastName?: string };
  isSigned?: boolean;
  beneficialOwner?: { firstName?: string; middleName?: string; lastName?: string };
  taxpayerIdentificationNumberTypeUS?: 'SSN' | 'ITIN';
  taxpayerIdentificationNumberUS?: string;
  taxpayerIdentificationNumberForeign?: string;
  dateOfBirth?: string;
  countryOfCitizenship?: string;
  residenceAddress?: {
    country?: string;
    structured?: { address1?: string; address2?: string; city?: string; zone?: string; postalCode?: string };
  };
  mailingAddress?: {
    country?: string;
    structured?: { address1?: string; address2?: string; city?: string; zone?: string; postalCode?: string };
  };
  hasConfirmedTOS?: boolean;
  claimsSpecialRatesAndConditions?: boolean;
  isSignerTheBeneficialOwner?: boolean;
  certifiesResidentCountry?: boolean;
  hasTaxTreatySpecialRatesAndConditions?: boolean;
  claimsArticleAndParagraph?: string;
  claimsRate?: number;
  claimsIncomeType?: string;
  claimsExplanation?: string;
  signerCapacity?: string;
} & ((
  | { claimsSpecialRatesAndConditions?: false }
  | {
      claimsSpecialRatesAndConditions?: true;
      hasTaxTreatySpecialRatesAndConditions?: boolean;
      certifiesResidentCountry?: boolean;
    }
) &
  (
    | { hasTaxTreatySpecialRatesAndConditions?: false }
    | {
        hasTaxTreatySpecialRatesAndConditions?: true;
        claimsArticleAndParagraph?: string;
        claimsRate?: number;
        claimsIncomeType?: string;
        claimsExplanation?: string;
      }
  ))) &
  ({ isSignerTheBeneficialOwner?: true } | { isSignerTheBeneficialOwner?: false; signerCapacity?: string });

type W8BenETaxFormValues = ((({
  isUSPersonOrEntity?: boolean;
  submitterType?: SubmitterType;
  formType?: TaxFormType;
  email?: string;
  signer?: { firstName?: string; middleName?: string; lastName?: string };
  isSigned?: boolean;
  businessName?: string;
  businessCountryOfIncorporationOrOrganization?: string;
  businessAddress?: {
    country?: string;
    structured?: { address1?: string; address2?: string; city?: string; zone?: string; postalCode?: string };
  };
  businessMailingAddress?: {
    country?: string;
    structured?: { address1?: string; address2?: string; city?: string; zone?: string; postalCode?: string };
  };
  disregardedBusinessName?: string;
  chapter3Status?: Chapter3Status;
  hasCapacityToSign?: boolean;
  certifyStatus?: boolean;
  taxpayerIdentificationNumberForeign?: string;
  taxpayerIdentificationNumberUS?: string;
  giin?: string;
  reference?: string;
  hasConfirmedTOS?: boolean;
  isHybridEntity?: boolean;
  claimsSpecialRatesAndConditions?: boolean;
  nffeStatus?: NFFEStatus;
  certifyDerivesIncome?: boolean;
  typeOfLimitationOnBenefitsProvisions?: TypeOfLimitationOnBenefitsProvisions;
  typeOfLimitationOnBenefitsProvisionsOther?: string;
  certifyBeneficialOwnerCountry?: boolean;
  certifyForeignCorporation?: boolean;
  claimsArticleAndParagraph?: string;
  claimsRate?: number;
  claimsIncomeType?: string;
  claimsExplanation?: string;
  usOwners?: {
    name?: string;
    address?: {
      country?: string;
      structured?: { address1?: string; address2?: string; city?: string; zone?: string; postalCode?: string };
    };
    tin?: string;
  }[];
} & (
  | { nffeStatus?: NFFEStatus.ActiveNFFE }
  | { nffeStatus?: NFFEStatus.NonProfitOrganization }
  | {
      nffeStatus?: NFFEStatus.PassiveNFFE;
      entityHasNoUSOwners?: boolean;
      usOwners?: {
        name?: string;
        address?: {
          country?: string;
          structured?: { address1?: string; address2?: string; city?: string; zone?: string; postalCode?: string };
        };
        tin?: string;
      }[];
    }
)) &
  (
    | { isHybridEntity?: boolean }
    | {
        isHybridEntity?: boolean;
        certifyBeneficialOwnerCountry?: boolean;
        certifyDerivesIncome?: boolean;
        certifyForeignCorporation?: boolean;
        claimsSpecialRatesAndConditions?: boolean;
      }
  )) &
  (
    | { certifyDerivesIncome?: boolean }
    | { certifyDerivesIncome?: boolean }
    | {
        certifyDerivesIncome?: boolean;
        typeOfLimitationOnBenefitsProvisions?: TypeOfLimitationOnBenefitsProvisions;
        typeOfLimitationOnBenefitsProvisionsOther?: string;
      }
  )) &
  (
    | { claimsSpecialRatesAndConditions?: boolean }
    | { claimsSpecialRatesAndConditions?: boolean }
    | {
        claimsSpecialRatesAndConditions?: boolean;
        claimsArticleAndParagraph?: string;
        claimsRate?: number;
        claimsIncomeType?: string;
        claimsExplanation?: string;
      }
  );

const isW9Data = (data: Record<string, unknown>): data is W9TaxFormValues => data?.formType === TaxFormType.W9;
const isW8BenData = (data: Record<string, unknown>): data is W8BenTaxFormValues =>
  data?.formType === TaxFormType.W8_BEN;
const isW8BenEData = (data: Record<string, unknown>): data is W8BenETaxFormValues =>
  data?.formType === TaxFormType.W8_BEN_E;

/**
 * Gets the standardized data from the OpenCollective legal document data, except the following fields which are meant
 * to be generated from the parent: ACCOUNT, BOX_1_NONEMPLOYEE_COMPENSATION, FILE, DROPBOX_FORM_INSTANCE, PLATFORM_ID
 */
export const getStandardizedDataFromOCLegalDocumentData = (
  data: W8BenETaxFormValues | W8BenTaxFormValues | W9TaxFormValues,
): TaxFormCSVRow => {
  const formatAddress2FromStructured = (structured: {
    address2?: string;
    city?: string;
    zone?: string;
    postalCode?: string;
  }) => [structured?.address2, structured?.city, structured?.zone, structured?.postalCode].filter(Boolean).join(', ');
  const common = {
    [TaxFormCSVColumns.RECIPIENT_NAME]: `${data?.signer?.firstName} ${data?.signer?.lastName}`.trim(),
    [TaxFormCSVColumns.TYPE]: data?.formType,
  };

  if (isW9Data(data)) {
    return {
      ...common,
      [TaxFormCSVColumns.ENTITY]: data.businessName,
      [TaxFormCSVColumns.STATUS]: data.submitterType,
      [TaxFormCSVColumns.TAX_ID_TYPE]: data.taxIdNumberType,
      [TaxFormCSVColumns.TAX_ID]: data.taxIdNumber,
      [TaxFormCSVColumns.RECIPIENT_ADDRESS_1]: data.location?.structured?.address1,
      [TaxFormCSVColumns.RECIPIENT_ADDRESS_2]: formatAddress2FromStructured(data.location?.structured),
      [TaxFormCSVColumns.RECIPIENT_COUNTRY]: data.location?.country,
      [TaxFormCSVColumns.RECIPIENT_EMAIL]: data.email,
    };
  } else if (isW8BenData(data)) {
    return {
      ...common,
      [TaxFormCSVColumns.ENTITY]: `${data.beneficialOwner?.firstName} ${data.beneficialOwner?.lastName}`,
      [TaxFormCSVColumns.STATUS]: data.submitterType,
      [TaxFormCSVColumns.TAX_ID_TYPE]:
        (data.taxpayerIdentificationNumberForeign && 'Foreign') || data.taxpayerIdentificationNumberTypeUS,
      [TaxFormCSVColumns.TAX_ID]: data.taxpayerIdentificationNumberUS || data.taxpayerIdentificationNumberForeign,
      [TaxFormCSVColumns.RECIPIENT_ADDRESS_1]: data.residenceAddress?.structured?.address1,
      [TaxFormCSVColumns.RECIPIENT_ADDRESS_2]: formatAddress2FromStructured(data.residenceAddress?.structured),
      [TaxFormCSVColumns.RECIPIENT_COUNTRY]: data.residenceAddress?.country,
      [TaxFormCSVColumns.RECIPIENT_EMAIL]: data.email,
    };
  } else if (isW8BenEData(data)) {
    return {
      ...common,
      [TaxFormCSVColumns.ENTITY]: data.businessName,
      [TaxFormCSVColumns.STATUS]: data.submitterType,
      [TaxFormCSVColumns.TAX_ID_TYPE]: data.taxpayerIdentificationNumberForeign ? 'Foreign' : data.giin ? 'GIIN' : '',
      [TaxFormCSVColumns.TAX_ID]:
        data.taxpayerIdentificationNumberForeign || data.giin || data.taxpayerIdentificationNumberUS,
      [TaxFormCSVColumns.RECIPIENT_ADDRESS_1]: data.businessAddress?.structured?.address1,
      [TaxFormCSVColumns.RECIPIENT_ADDRESS_2]: formatAddress2FromStructured(data.businessAddress?.structured),
      [TaxFormCSVColumns.RECIPIENT_COUNTRY]: data.businessAddress?.country,
      [TaxFormCSVColumns.RECIPIENT_EMAIL]: data.email,
    };
  } else {
    logger.warn(`Unknown tax form type for: ${data}`);
    return common;
  }
};
