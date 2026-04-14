// ts-unused-exports:disable-next-line
export enum GoCardlessRequisitionStatus {
  /** Requisition has been successfully created (Stage 1) */
  CR = 'CR',
  /** End-user is giving consent at GoCardless's consent screen (Stage 2) */
  GC = 'GC',
  /** End-user is redirected to the financial institution for authentication (Stage 3) */
  UA = 'UA',
  /** Either SSN verification has failed or end-user has entered incorrect credentials (Stage 4) */
  RJ = 'RJ',
  /** End-user is selecting accounts (Stage 5) */
  SA = 'SA',
  /** End-user is granting access to their account information (Stage 6) */
  GA = 'GA',
  /**  */
  LN = 'LN',
  /** Access to accounts has expired as set in End User Agreement (Stage 8) */
  EX = 'EX',
  // Below are statuses not found in the documentation (https://developer.gocardless.com/bank-account-data/statuses) but still part of https://bankaccountdata.gocardless.com/api/v2/swagger.json
  ID = 'ID',
  ER = 'ER',
  SU = 'SU',
}

/** AccountSerializer. */
// ts-unused-exports:disable-next-line
export interface Account {
  /**
   * The ID of this Account, used to refer to this account in other API calls.
   * @format uuid
   */
  id?: string;
  /**
   * The date & time at which the account object was created.
   * @format date-time
   */
  created?: string;
  /**
   * The date & time at which the account object was last accessed.
   * @format date-time
   */
  last_accessed?: string;
  /** The Account IBAN */
  iban?: string;
  /** The Account BBAN */
  bban?: string;
  /** The processing status of this account. */
  status?: string;
  /** The ASPSP associated with this account. */
  institution_id?: string;
  /** The name of the account owner. */
  owner_name?: string;
  /** The name of account. */
  name?: string;
}

/** AccountBalanceSerializer. */
// ts-unused-exports:disable-next-line
export interface AccountBalance {
  balances?: BalanceSchema[];
}

/** AccountDetailSerializer. */
// ts-unused-exports:disable-next-line
export interface AccountDetail {
  /** account */
  account: DetailSchema;
}

/** AccountSchema. */
// ts-unused-exports:disable-next-line
export interface AccountSchema {
  /** iban */
  iban?: string;
  /** bban */
  bban?: string;
  /** pan */
  pan?: string;
  /** maskedPan */
  maskedPan?: string;
  /** msisdn */
  msisdn?: string;
  /** currency */
  currency?: string;
}

/** AccountTransactionsSerializer. */
// ts-unused-exports:disable-next-line
export interface AccountTransactions {
  /** transactions */
  transactions: BankTransaction;
  /**
   * The last time the account transactions were updated
   * @format date-time
   */
  last_updated?: string;
}

/** AdditionalAccountDataSchema. */
// ts-unused-exports:disable-next-line
export interface AdditionalAccountDataSchema {
  /** secondaryIdentification */
  secondaryIdentification?: string;
}

/** BalanceAfterTransactionSchema. */
// ts-unused-exports:disable-next-line
export interface BalanceAfterTransactionSchema {
  /** amount */
  amount: string;
  /** currency */
  currency?: string;
}

/** BalanceAmountSchema. */
// ts-unused-exports:disable-next-line
export interface BalanceAmountSchema {
  /** amount */
  amount: string;
  /** currency */
  currency: string;
}

/** BalanceSchema. */
// ts-unused-exports:disable-next-line
export interface BalanceSchema {
  /** balanceAmount */
  balanceAmount: BalanceAmountSchema;
  /** balanceType */
  balanceType: string;
  /** creditLimitIncluded */
  creditLimitIncluded?: boolean;
  /** lastChangeDateTime */
  lastChangeDateTime?: string;
  /** referenceDate */
  referenceDate?: string;
  /** lastCommittedTransaction */
  lastCommittedTransaction?: string;
}

/** BankTransactionSerializer. */
// ts-unused-exports:disable-next-line
export interface BankTransaction {
  booked: TransactionSchema[];
  pending?: TransactionSchema[];
}

/** CurrencyExchangeSchema. */
// ts-unused-exports:disable-next-line
export interface CurrencyExchangeSchema {
  /** sourceCurrency */
  sourceCurrency?: string;
  /** exchangeRate */
  exchangeRate?: string;
  /** unitCurrency */
  unitCurrency?: string;
  /** targetCurrency */
  targetCurrency?: string;
  /** quotationDate */
  quotationDate?: string;
  /** contractIdentification */
  contractIdentification?: string;
}

/** DetailSchema. */
// ts-unused-exports:disable-next-line
export interface DetailSchema {
  /** resourceId */
  resourceId?: string;
  /** iban */
  iban?: string;
  /** bban */
  bban?: string;
  /** SortCodeAccountNumber returned by some UK banks (6 digit Sort Code and 8 digit Account Number) */
  scan?: string;
  /** msisdn */
  msisdn?: string;
  /** currency */
  currency?: string;
  /** ownerName */
  ownerName?: string;
  /** name */
  name?: string;
  /** displayName */
  displayName?: string;
  /** product */
  product?: string;
  /** cashAccountType */
  cashAccountType?: string;
  /** status */
  status?: string;
  /** bic */
  bic?: string;
  /** linkedAccounts */
  linkedAccounts?: string;
  /** maskedPan */
  maskedPan?: string;
  /** usage */
  usage?: string;
  /** details */
  details?: string;
  /** ownerAddressUnstructured */
  ownerAddressUnstructured?: string[];
  /** ownerAddressStructured */
  ownerAddressStructured?: OwnerAddressStructuredSchema;
  /** additionalAccountData used for information that is outside of Berlin Group specification, such as bank or country-specific fields */
  additionalAccountData?: AdditionalAccountDataSchema;
}

/**
 * @example {
    "id": "COOPERATIVE_CPBKGB22",
    "name": "The Co-Operative Bank Business",
    "bic": "CPBKGB22",
    "transaction_total_days": "730",
    "countries": [
      "GB"
    ],
    "logo": "https://cdn-logos.gocardless.com/ais/COOPERATIVE_CPBKGB22.png",
    "max_access_valid_for_days": "90",
    "max_access_valid_for_days_reconfirmation": "730",
    "supported_features": [
      "business_accounts",
      "reconfirmation_of_consent",
      "submit_payment"
    ],
    "identification_codes": []
  }
 */
export interface Institution {
  id: string;
  name: string;
  bic: string;
  logo: string;
  max_access_valid_for_days: string;
  max_access_valid_for_days_reconfirmation: string;
  transaction_total_days: string;
  supported_features: string[];
  identification_codes: string[];
  countries: string[];
}

/** Represents an end-user agreement. */
// ts-unused-exports:disable-next-line
export interface EndUserAgreement {
  /**
   * End User Agreement ID
   * The ID of this End User Agreement, used to refer to this end user agreement in other API calls.
   * @format uuid
   */
  id?: string;
  /**
   * Created Date
   * The date & time at which the end user agreement was created.
   * @format date-time
   */
  created?: string;
  /** an Institution ID for this EUA */
  institution_id: string;
  /**
   * Maximum Historical Days
   * Maximum number of days of transaction data to retrieve.
   * @min 1
   * @max 730
   * @default 90
   */
  max_historical_days?: number;
  /**
   * Access Valid For (Days)
   * Number of days from acceptance that the access can be used.
   * @min 1
   * @max 180
   * @default 90
   */
  access_valid_for_days?: number;
  /**
   * Level of information to access (by default all)
   * Array containing one or several values of ['balances', 'details', 'transactions']
   * @default ["balances","details","transactions"]
   */
  access_scope?: any[];
  /**
   * Accepted Date
   * The date & time at which the end user accepted the agreement.
   * @format date-time
   */
  accepted?: string | null;
  /**
   * if this agreement can be extended. Supported by GB banks only.
   * @default false
   */
  reconfirmation?: boolean;
}

/** Represents an end-user agreement. */
// ts-unused-exports:disable-next-line
export interface EndUserAgreementRequest {
  /**
   * an Institution ID for this EUA
   * @minLength 1
   */
  institution_id: string;
  /**
   * Maximum Historical Days
   * Maximum number of days of transaction data to retrieve.
   * @min 1
   * @max 730
   * @default 90
   */
  max_historical_days?: number;
  /**
   * Access Valid For (Days)
   * Number of days from acceptance that the access can be used.
   * @min 1
   * @max 180
   * @default 90
   */
  access_valid_for_days?: number;
  /**
   * Level of information to access (by default all)
   * Array containing one or several values of ['balances', 'details', 'transactions']
   * @default ["balances","details","transactions"]
   */
  access_scope?: any[];
  /**
   * if this agreement can be extended. Supported by GB banks only.
   * @default false
   */
  reconfirmation?: boolean;
}

/** Represents end-user details. */
// ts-unused-exports:disable-next-line
export interface EnduserAcceptanceDetailsRequest {
  /**
   * user agent string for the end user
   * @minLength 1
   */
  user_agent: string;
  /**
   * end user IP address
   * @minLength 1
   */
  ip_address: string;
}

// ts-unused-exports:disable-next-line
export interface ErrorResponse {
  summary: string;
  detail: string;
  type?: string;
  status_code: number;
}

/** Represents an Integration. */
// ts-unused-exports:disable-next-line
export interface Integration {
  id: string;
  name: string;
  bic?: string;
  /** @default "90" */
  transaction_total_days?: string;
  max_access_valid_for_days?: string;
  countries: string[];
  logo: string;
}

/** IntegrationSerializer for Retrieve endpoint. */
// ts-unused-exports:disable-next-line
export interface IntegrationRetrieve {
  id: string;
  name: string;
  bic?: string;
  /** @default "90" */
  transaction_total_days?: string;
  max_access_valid_for_days?: string;
  countries: string[];
  logo: string;
  supported_features: any[];
  identification_codes: any[];
}

/** Obtain JWT pair. */
// ts-unused-exports:disable-next-line
export interface JWTObtainPairRequest {
  /**
   * Secret id from /user-secrets/
   * @minLength 1
   */
  secret_id: string;
  /**
   * Secret key from /user-secrets/
   * @minLength 1
   */
  secret_key: string;
}

/** Refresh access token. */
// ts-unused-exports:disable-next-line
export interface JWTRefreshRequest {
  /** @minLength 1 */
  refresh: string;
}

/** OwnerAddressStructuredSchema. */
// ts-unused-exports:disable-next-line
export interface OwnerAddressStructuredSchema {
  /** streetName */
  streetName?: string;
  /** buildingNumber */
  buildingNumber?: string;
  /** townName */
  townName?: string;
  /** postCode */
  postCode?: string;
  /** country */
  country?: string;
}

// ts-unused-exports:disable-next-line
export interface PaginatedEndUserAgreementList {
  /** @example 123 */
  count: number;
  /**
   * @format uri
   * @example "https://bankaccountdata.gocardless.com/api/v2/agreements/enduser/?limit=100&offset=0"
   */
  next?: string | null;
  /**
   * @format uri
   * @example "https://bankaccountdata.gocardless.com/api/v2/agreements/enduser/?limit=100&offset=0"
   */
  previous?: string | null;
  results: EndUserAgreement[];
}

// ts-unused-exports:disable-next-line
export interface PaginatedRequisitionList {
  /** @example 123 */
  count: number;
  /**
   * @format uri
   * @example "https://bankaccountdata.gocardless.com/api/v2/requisitions/?limit=100&offset=0"
   */
  next?: string | null;
  /**
   * @format uri
   * @example "https://bankaccountdata.gocardless.com/api/v2/requisitions/?limit=100&offset=0"
   */
  previous?: string | null;
  results: Requisition[];
}

/** EUA reconfirmation. */
// ts-unused-exports:disable-next-line
export interface ReconfirmationRetrieve {
  /**
   * Reconfirmation URL to be provided to PSU.
   * @format uri
   */
  reconfirmation_url?: string;
  /**
   * Reconfirmation creation time
   * @format date-time
   */
  created?: string;
  /**
   * Datetime from when PSU will be able to access reconfirmation URL.
   * @format date-time
   */
  url_valid_from?: string;
  /**
   * Datetime until when PSU will be able to access reconfirmation URL.
   * @format date-time
   */
  url_valid_to?: string;
  /**
   * redirect_url
   * Optional redirect URL for reconfirmation to override requisition's redirect.
   * @format uri
   * @maxLength 1024
   */
  redirect?: string | null;
  /**
   * Last time when reconfirmation was accessed (this does not mean that it was accessed by PSU).
   * @format date-time
   */
  last_accessed?: string | null;
  /**
   * Last time reconfirmation was submitted (it can be submitted multiple times).
   * @format date-time
   */
  last_submitted?: string | null;
  /**
   * Dictionary of accounts and their reconfirm and reject timestamps
   * @example {"64a985ae-4427-4a27-bd36-fd625fe6e1fc":{"reconfirmed":"2025-01-14T15:20:56.942817Z","rejected":""},"cd2fbd71-15f7-4607-bea2-fbd80311a013":{"reconfirmed":"","rejected":""}}
   */
  accounts?: object;
}

/** EUA reconfirmation. */
// ts-unused-exports:disable-next-line
export interface ReconfirmationRetrieveRequest {
  /**
   * redirect_url
   * Optional redirect URL for reconfirmation to override requisition's redirect.
   * @format uri
   * @maxLength 1024
   */
  redirect?: string | null;
}

/** RequisitionSerializer. */
// ts-unused-exports:disable-next-line
export interface Requisition {
  /** @format uuid */
  id?: string;
  /**
   * Created Date
   * The date & time at which the requisition was created.
   * @format date-time
   */
  created?: string | null;
  /**
   * redirect URL to your application after end-user authorization with ASPSP
   * @format uri
   * @maxLength 1024
   */
  redirect: string | null;
  /**
   * Requisition status
   * status of this requisition
   */
  status?: GoCardlessRequisitionStatus;
  /** an Institution ID for this Requisition */
  institution_id: string;
  /**
   * EUA associated with this requisition
   * @format uuid
   */
  agreement?: string;
  /**
   * additional ID to identify the end user
   * @maxLength 256
   */
  reference?: string;
  /** array of account IDs retrieved within a scope of this requisition */
  accounts?: string[];
  /**
   * A two-letter country code (ISO 639-1)
   * @maxLength 5
   */
  user_language?: string;
  /**
   * link to initiate authorization with Institution
   * @format uri
   * @default "https://ob.gocardless.com/psd2/start/3fa85f64-5717-4562-b3fc-2c963f66afa6/SANDBOXFINANCE_SFIN0000"
   */
  link?: string;
  /**
   * optional SSN field to verify ownership of the account
   * @maxLength 64
   */
  ssn?: string;
  /**
   * option to enable account selection view for the end user
   * @default false
   */
  account_selection?: boolean;
  /**
   * enable redirect back to the client after account list received
   * @default false
   */
  redirect_immediate?: boolean;
}

/** RequisitionSerializer. */
// ts-unused-exports:disable-next-line
export interface RequisitionRequest {
  /**
   * redirect URL to your application after end-user authorization with ASPSP
   * @format uri
   * @minLength 1
   * @maxLength 1024
   */
  redirect: string | null;
  /**
   * an Institution ID for this Requisition
   * @minLength 1
   */
  institution_id: string;
  /**
   * EUA associated with this requisition
   * @format uuid
   */
  agreement?: string;
  /**
   * additional ID to identify the end user
   * @minLength 1
   * @maxLength 256
   */
  reference?: string;
  /**
   * A two-letter country code (ISO 639-1)
   * @minLength 1
   * @maxLength 5
   */
  user_language?: string;
  /**
   * optional SSN field to verify ownership of the account
   * @maxLength 64
   */
  ssn?: string;
  /**
   * option to enable account selection view for the end user
   * @default false
   */
  account_selection?: boolean;
  /**
   * enable redirect back to the client after account list received
   * @default false
   */
  redirect_immediate?: boolean;
}

/** Obtain new JWT pair. */
// ts-unused-exports:disable-next-line
export interface SpectacularJWTObtain {
  /** Your access token */
  access?: string;
  /**
   * Access token expires in seconds
   * @default 86400
   */
  access_expires?: number;
  /** Your refresh token */
  refresh?: string;
  /**
   * Refresh token expires in seconds
   * @default 2592000
   */
  refresh_expires?: number;
}

/** Refresh Access token. */
// ts-unused-exports:disable-next-line
export interface SpectacularJWTRefresh {
  /** Your access token */
  access?: string;
  /**
   * Access token expires in seconds
   * @default 86400
   */
  access_expires?: number;
}

/** Create requisition. */
// ts-unused-exports:disable-next-line
export interface SpectacularRequisition {
  /** @format uuid */
  id?: string;
  /**
   * Created Date
   * The date & time at which the requisition was created.
   * @format date-time
   */
  created?: string | null;
  /**
   * redirect URL to your application after end-user authorization with ASPSP
   * @format uri
   * @maxLength 1024
   */
  redirect: string | null;
  /**
   * Requisition status
   * status of this requisition
   */
  status?: GoCardlessRequisitionStatus;
  /** an Institution ID for this Requisition */
  institution_id: string;
  /**
   * EUA associated with this requisition
   * @format uuid
   */
  agreement?: string;
  /**
   * additional ID to identify the end user
   * @maxLength 256
   */
  reference?: string;
  /**
   * array of account IDs retrieved within a scope of this requisition
   * @default []
   */
  accounts?: any[];
  /**
   * A two-letter country code (ISO 639-1)
   * @maxLength 5
   */
  user_language?: string;
  /**
   * link to initiate authorization with Institution
   * @format uri
   * @default "https://ob.gocardless.com/psd2/start/3fa85f64-5717-4562-b3fc-2c963f66afa6/SANDBOXFINANCE_SFIN0000"
   */
  link?: string;
  /**
   * optional SSN field to verify ownership of the account
   * @maxLength 64
   */
  ssn?: string;
  /**
   * option to enable account selection view for the end user
   * @default false
   */
  account_selection?: boolean;
  /**
   * enable redirect back to the client after account list received
   * @default false
   */
  redirect_immediate?: boolean;
}

// ts-unused-exports:disable-next-line
export interface SuccessfulDeleteResponse {
  summary: string;
  detail: string;
}

/** TransactionAmountSchema. */
// ts-unused-exports:disable-next-line
export interface TransactionAmountSchema {
  /** amount */
  amount: string;
  /** currency */
  currency: string;
}

/** TransactionSchema. */
// ts-unused-exports:disable-next-line
export interface TransactionSchema {
  /** transactionId */
  transactionId?: string;
  /** entryReference */
  entryReference?: string;
  /** endToEndId */
  endToEndId?: string;
  /** mandateId */
  mandateId?: string;
  /** checkId */
  checkId?: string;
  /** creditorId */
  creditorId?: string;
  /** bookingDate */
  bookingDate?: string;
  /** valueDate */
  valueDate?: string;
  /** bookingDateTime */
  bookingDateTime?: string;
  /** valueDateTime */
  valueDateTime?: string;
  /** transactionAmount */
  transactionAmount: TransactionAmountSchema;
  currencyExchange?: CurrencyExchangeSchema[];
  /** creditorName */
  creditorName?: string;
  /** creditorAccount */
  creditorAccount?: AccountSchema;
  /** ultimateCreditor */
  ultimateCreditor?: string;
  /** debtorName */
  debtorName?: string;
  /** debtorAccount */
  debtorAccount?: AccountSchema;
  /** ultimateDebtor */
  ultimateDebtor?: string;
  /** remittanceInformationUnstructured */
  remittanceInformationUnstructured?: string;
  /** remittanceInformationUnstructuredArray */
  remittanceInformationUnstructuredArray?: string[];
  /** remittanceInformationStructured */
  remittanceInformationStructured?: string;
  /** remittanceInformationStructuredArray */
  remittanceInformationStructuredArray?: string[];
  /** additionalInformation */
  additionalInformation?: string;
  /** purposeCode */
  purposeCode?: string;
  /** bankTransactionCode */
  bankTransactionCode?: string;
  /** proprietaryBankTransactionCode */
  proprietaryBankTransactionCode?: string;
  /** internalTransactionId */
  internalTransactionId?: string;
  /** balanceAfterTransaction */
  balanceAfterTransaction?: BalanceAfterTransactionSchema;
}

// ts-unused-exports:disable-next-line
export type QueryParamsType = Record<string | number, any>;

// ts-unused-exports:disable-next-line
export type ResponseFormat = keyof Omit<Body, 'body' | 'bodyUsed'>;

// ts-unused-exports:disable-next-line
export interface FullRequestParams extends Omit<RequestInit, 'body'> {
  /** set parameter to `true` for call `securityWorker` for this request */
  secure?: boolean;
  /** request path */
  path: string;
  /** content type of request body */
  type?: ContentType;
  /** query params */
  query?: QueryParamsType;
  /** format of response (i.e. response.json() -> format: "json") */
  format?: ResponseFormat;
  /** request body */
  body?: unknown;
  /** base url */
  baseUrl?: string;
  /** request cancellation token */
  cancelToken?: CancelToken;
}

// ts-unused-exports:disable-next-line
export type RequestParams = Omit<FullRequestParams, 'body' | 'method' | 'query' | 'path'>;

// ts-unused-exports:disable-next-line
export interface ApiConfig<SecurityDataType = unknown> {
  baseUrl?: string;
  baseApiParams?: Omit<RequestParams, 'baseUrl' | 'cancelToken' | 'signal'>;
  securityWorker?: (securityData: SecurityDataType | null) => Promise<RequestParams | void> | RequestParams | void;
  customFetch?: typeof fetch;
}

// ts-unused-exports:disable-next-line
export interface HttpResponse<D, E = unknown> extends Response {
  data: D;
  error: E;
}

// ts-unused-exports:disable-next-line
type CancelToken = symbol | string | number;

// ts-unused-exports:disable-next-line
export enum ContentType {
  Json = 'application/json',
  JsonApi = 'application/vnd.api+json',
  FormData = 'multipart/form-data',
  UrlEncoded = 'application/x-www-form-urlencoded',
  Text = 'text/plain',
}
