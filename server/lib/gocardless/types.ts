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
export interface AccountBalance {
  balances?: BalanceSchema[];
}

/** AccountDetailSerializer. */
export interface AccountDetail {
  /** account */
  account: DetailSchema;
}

/** AccountSchema. */
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
export interface AdditionalAccountDataSchema {
  /** secondaryIdentification */
  secondaryIdentification?: string;
}

/** BalanceAfterTransactionSchema. */
export interface BalanceAfterTransactionSchema {
  /** amount */
  amount: string;
  /** currency */
  currency?: string;
}

/** BalanceAmountSchema. */
export interface BalanceAmountSchema {
  /** amount */
  amount: string;
  /** currency */
  currency: string;
}

/** BalanceSchema. */
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
export interface BankTransaction {
  booked: TransactionSchema[];
  pending?: TransactionSchema[];
}

/** CurrencyExchangeSchema. */
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

/** Represents an end-user agreement. */
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

export interface ErrorResponse {
  summary: string;
  detail: string;
  type?: string;
  status_code: number;
}

/** Represents an Integration. */
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
export interface JWTRefreshRequest {
  /** @minLength 1 */
  refresh: string;
}

/** OwnerAddressStructuredSchema. */
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

export interface SuccessfulDeleteResponse {
  summary: string;
  detail: string;
}

/** TransactionAmountSchema. */
export interface TransactionAmountSchema {
  /** amount */
  amount: string;
  /** currency */
  currency: string;
}

/** TransactionSchema. */
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

export type QueryParamsType = Record<string | number, any>;
export type ResponseFormat = keyof Omit<Body, 'body' | 'bodyUsed'>;

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

export type RequestParams = Omit<FullRequestParams, 'body' | 'method' | 'query' | 'path'>;

export interface ApiConfig<SecurityDataType = unknown> {
  baseUrl?: string;
  baseApiParams?: Omit<RequestParams, 'baseUrl' | 'cancelToken' | 'signal'>;
  securityWorker?: (securityData: SecurityDataType | null) => Promise<RequestParams | void> | RequestParams | void;
  customFetch?: typeof fetch;
}

export interface HttpResponse<D, E = unknown> extends Response {
  data: D;
  error: E;
}

type CancelToken = symbol | string | number;

export enum ContentType {
  Json = 'application/json',
  JsonApi = 'application/vnd.api+json',
  FormData = 'multipart/form-data',
  UrlEncoded = 'application/x-www-form-urlencoded',
  Text = 'text/plain',
}

export class HttpClient<SecurityDataType = unknown> {
  public baseUrl: string = 'https://bankaccountdata.gocardless.com';
  private securityData: SecurityDataType | null = null;
  private securityWorker?: ApiConfig<SecurityDataType>['securityWorker'];
  private abortControllers = new Map<CancelToken, AbortController>();
  private customFetch = (...fetchParams: Parameters<typeof fetch>) => fetch(...fetchParams);

  private baseApiParams: RequestParams = {
    credentials: 'same-origin',
    headers: {},
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
  };

  constructor(apiConfig: ApiConfig<SecurityDataType> = {}) {
    Object.assign(this, apiConfig);
  }

  public setSecurityData = (data: SecurityDataType | null) => {
    this.securityData = data;
  };

  protected encodeQueryParam(key: string, value: any) {
    const encodedKey = encodeURIComponent(key);
    return `${encodedKey}=${encodeURIComponent(typeof value === 'number' ? value : `${value}`)}`;
  }

  protected addQueryParam(query: QueryParamsType, key: string) {
    return this.encodeQueryParam(key, query[key]);
  }

  protected addArrayQueryParam(query: QueryParamsType, key: string) {
    const value = query[key];
    return value.map((v: any) => this.encodeQueryParam(key, v)).join('&');
  }

  protected toQueryString(rawQuery?: QueryParamsType): string {
    const query = rawQuery || {};
    const keys = Object.keys(query).filter(key => 'undefined' !== typeof query[key]);
    return keys
      .map(key => (Array.isArray(query[key]) ? this.addArrayQueryParam(query, key) : this.addQueryParam(query, key)))
      .join('&');
  }

  protected addQueryParams(rawQuery?: QueryParamsType): string {
    const queryString = this.toQueryString(rawQuery);
    return queryString ? `?${queryString}` : '';
  }

  private contentFormatters: Record<ContentType, (input: any) => any> = {
    [ContentType.Json]: (input: any) =>
      input !== null && (typeof input === 'object' || typeof input === 'string') ? JSON.stringify(input) : input,
    [ContentType.JsonApi]: (input: any) =>
      input !== null && (typeof input === 'object' || typeof input === 'string') ? JSON.stringify(input) : input,
    [ContentType.Text]: (input: any) => (input !== null && typeof input !== 'string' ? JSON.stringify(input) : input),
    [ContentType.FormData]: (input: any) =>
      Object.keys(input || {}).reduce((formData, key) => {
        const property = input[key];
        formData.append(
          key,
          property instanceof Blob
            ? property
            : typeof property === 'object' && property !== null
              ? JSON.stringify(property)
              : `${property}`,
        );
        return formData;
      }, new FormData()),
    [ContentType.UrlEncoded]: (input: any) => this.toQueryString(input),
  };

  protected mergeRequestParams(params1: RequestParams, params2?: RequestParams): RequestParams {
    return {
      ...this.baseApiParams,
      ...params1,
      ...(params2 || {}),
      headers: {
        ...(this.baseApiParams.headers || {}),
        ...(params1.headers || {}),
        ...((params2 && params2.headers) || {}),
      },
    };
  }

  protected createAbortSignal = (cancelToken: CancelToken): AbortSignal | undefined => {
    if (this.abortControllers.has(cancelToken)) {
      const abortController = this.abortControllers.get(cancelToken);
      if (abortController) {
        return abortController.signal;
      }
      return void 0;
    }

    const abortController = new AbortController();
    this.abortControllers.set(cancelToken, abortController);
    return abortController.signal;
  };

  public abortRequest = (cancelToken: CancelToken) => {
    const abortController = this.abortControllers.get(cancelToken);

    if (abortController) {
      abortController.abort();
      this.abortControllers.delete(cancelToken);
    }
  };

  public request = async <T = any, E = any>({
    body,
    secure,
    path,
    type,
    query,
    format,
    baseUrl,
    cancelToken,
    ...params
  }: FullRequestParams): Promise<HttpResponse<T, E>> => {
    const secureParams =
      ((typeof secure === 'boolean' ? secure : this.baseApiParams.secure) &&
        this.securityWorker &&
        (await this.securityWorker(this.securityData))) ||
      {};
    const requestParams = this.mergeRequestParams(params, secureParams);
    const queryString = query && this.toQueryString(query);
    const payloadFormatter = this.contentFormatters[type || ContentType.Json];
    const responseFormat = format || requestParams.format;

    return this.customFetch(`${baseUrl || this.baseUrl || ''}${path}${queryString ? `?${queryString}` : ''}`, {
      ...requestParams,
      headers: {
        ...(requestParams.headers || {}),
        ...(type && type !== ContentType.FormData ? { 'Content-Type': type } : {}),
      },
      signal: (cancelToken ? this.createAbortSignal(cancelToken) : requestParams.signal) || null,
      body: typeof body === 'undefined' || body === null ? null : payloadFormatter(body),
    }).then(async response => {
      const r = response.clone() as HttpResponse<T, E>;
      r.data = null as unknown as T;
      r.error = null as unknown as E;

      const data = !responseFormat
        ? r
        : await response[responseFormat]()
            .then(data => {
              if (r.ok) {
                r.data = data;
              } else {
                r.error = data;
              }
              return r;
            })
            .catch(e => {
              r.error = e;
              return r;
            });

      if (cancelToken) {
        this.abortControllers.delete(cancelToken);
      }

      if (!response.ok) {
        throw data;
      }
      return data;
    });
  };
}

/**
 * @title GoCardless Bank Account Data API
 * @version 2.0 (v2)
 * @baseUrl https://bankaccountdata.gocardless.com
 */
export class GoCardlessBankAccountDataApi<SecurityDataType> extends HttpClient<SecurityDataType> {
  api = {
    /**
     * @description Access account metadata. Information about the account record, such as the processing status and IBAN. Account status is recalculated based on the error count in the latest req.
     *
     * @tags accounts
     * @name RetrieveAccountMetadata
     * @request GET:/api/v2/accounts/{id}/
     * @secure
     */
    retrieveAccountMetadata: (id: string, params: RequestParams = {}) =>
      this.request<Account, ErrorResponse>({
        path: `/api/v2/accounts/${id}/`,
        method: 'GET',
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Access account balances. Balances will be returned in Berlin Group PSD2 format.
     *
     * @tags accounts
     * @name RetrieveAccountBalances
     * @request GET:/api/v2/accounts/{id}/balances/
     * @secure
     */
    retrieveAccountBalances: (id: string, params: RequestParams = {}) =>
      this.request<AccountBalance, ErrorResponse>({
        path: `/api/v2/accounts/${id}/balances/`,
        method: 'GET',
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Access account details. Account details will be returned in Berlin Group PSD2 format.
     *
     * @tags accounts
     * @name RetrieveAccountDetails
     * @request GET:/api/v2/accounts/{id}/details/
     * @secure
     */
    retrieveAccountDetails: (id: string, params: RequestParams = {}) =>
      this.request<AccountDetail, ErrorResponse>({
        path: `/api/v2/accounts/${id}/details/`,
        method: 'GET',
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Access account transactions. Transactions will be returned in Berlin Group PSD2 format.
     *
     * @tags accounts
     * @name RetrieveAccountTransactions
     * @request GET:/api/v2/accounts/{id}/transactions/
     * @secure
     */
    retrieveAccountTransactions: (
      id: string,
      query?: {
        /** @format date */
        date_from?: string;
        /** @format date */
        date_to?: string;
      },
      params: RequestParams = {},
    ) =>
      this.request<AccountTransactions, ErrorResponse>({
        path: `/api/v2/accounts/${id}/transactions/`,
        method: 'GET',
        query: query,
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Retrieve all End User Agreements belonging to the company
     *
     * @tags agreements
     * @name RetrieveAllAgreements
     * @request GET:/api/v2/agreements/enduser/
     * @secure
     */
    retrieveAllAgreements: (
      query?: {
        /**
         * Number of results to return per page.
         * @min 1
         * @default 100
         */
        limit?: number;
        /**
         * The initial zero-based index from which to return the results.
         * @min 0
         * @default 0
         */
        offset?: number;
      },
      params: RequestParams = {},
    ) =>
      this.request<PaginatedEndUserAgreementList, ErrorResponse>({
        path: `/api/v2/agreements/enduser/`,
        method: 'GET',
        query: query,
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description API endpoints related to end-user agreements.
     *
     * @tags agreements
     * @name CreateEua
     * @request POST:/api/v2/agreements/enduser/
     * @secure
     */
    createEua: (data: EndUserAgreementRequest, params: RequestParams = {}) =>
      this.request<EndUserAgreement, ErrorResponse>({
        path: `/api/v2/agreements/enduser/`,
        method: 'POST',
        body: data,
        secure: true,
        type: ContentType.Json,
        format: 'json',
        ...params,
      }),

    /**
     * @description Retrieve end user agreement by ID
     *
     * @tags agreements
     * @name RetrieveEuaById
     * @request GET:/api/v2/agreements/enduser/{id}/
     * @secure
     */
    retrieveEuaById: (id: string, params: RequestParams = {}) =>
      this.request<EndUserAgreement, ErrorResponse>({
        path: `/api/v2/agreements/enduser/${id}/`,
        method: 'GET',
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Delete an end user agreement
     *
     * @tags agreements
     * @name DeleteEuaById
     * @request DELETE:/api/v2/agreements/enduser/{id}/
     * @secure
     */
    deleteEuaById: (id: string, params: RequestParams = {}) =>
      this.request<SuccessfulDeleteResponse, ErrorResponse>({
        path: `/api/v2/agreements/enduser/${id}/`,
        method: 'DELETE',
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Accept an end-user agreement via the API
     *
     * @tags agreements
     * @name AcceptEua
     * @request PUT:/api/v2/agreements/enduser/{id}/accept/
     * @secure
     */
    acceptEua: (id: string, data: EnduserAcceptanceDetailsRequest, params: RequestParams = {}) =>
      this.request<EndUserAgreement, ErrorResponse>({
        path: `/api/v2/agreements/enduser/${id}/accept/`,
        method: 'PUT',
        body: data,
        secure: true,
        type: ContentType.Json,
        format: 'json',
        ...params,
      }),

    /**
     * @description Retrieve EUA reconfirmation
     *
     * @tags agreements
     * @name RetrieveEuaReconfirmation
     * @request GET:/api/v2/agreements/enduser/{id}/reconfirm/
     * @secure
     */
    retrieveEuaReconfirmation: (id: string, params: RequestParams = {}) =>
      this.request<ReconfirmationRetrieve, ErrorResponse>({
        path: `/api/v2/agreements/enduser/${id}/reconfirm/`,
        method: 'GET',
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Create EUA reconfirmation
     *
     * @tags agreements
     * @name CreateEuaReconfirmation
     * @request POST:/api/v2/agreements/enduser/{id}/reconfirm/
     * @secure
     */
    createEuaReconfirmation: (id: string, data: ReconfirmationRetrieveRequest, params: RequestParams = {}) =>
      this.request<ReconfirmationRetrieve, ErrorResponse>({
        path: `/api/v2/agreements/enduser/${id}/reconfirm/`,
        method: 'POST',
        body: data,
        secure: true,
        type: ContentType.Json,
        format: 'json',
        ...params,
      }),

    /**
     * @description List all available institutions
     *
     * @tags institutions
     * @name RetrieveAllSupportedInstitutionsInAGivenCountry
     * @request GET:/api/v2/institutions/
     * @secure
     */
    retrieveAllSupportedInstitutionsInAGivenCountry: (
      query?: {
        /** Boolean value, indicating if access scopes are supported */
        access_scopes_supported?: string;
        /** Boolean value, indicating if account selection is supported */
        account_selection_supported?: string;
        /** Boolean value, indicating if business accounts are supported */
        business_accounts_supported?: string;
        /** Boolean value, indicating if card accounts are supported */
        card_accounts_supported?: string;
        /** Boolean value, indicating if corporate accounts are supported */
        corporate_accounts_supported?: string;
        /** ISO 3166 two-character country code */
        country?: string;
        /** Boolean value, indicating if pending transactions are supported */
        pending_transactions_supported?: string;
        /** Boolean value, indicating if private accounts are supported */
        private_accounts_supported?: string;
        /** Boolean value, indicating if debtor account can be read before submitting payment */
        read_debtor_account_supported?: string;
        /** Boolean value, indicating if read refund account is supported */
        read_refund_account_supported?: string;
        /** Boolean value, indicating if separate consent for continuous history is supported */
        separate_continuous_history_consent_supported?: string;
        /** Boolean value, indicating if ssn verification is supported */
        ssn_verification_supported?: string;
      },
      params: RequestParams = {},
    ) =>
      this.request<Integration[], ErrorResponse>({
        path: `/api/v2/institutions/`,
        method: 'GET',
        query: query,
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Get details about a specific Institution and its supported features
     *
     * @tags institutions
     * @name RetrieveInstitution
     * @request GET:/api/v2/institutions/{id}/
     * @secure
     */
    retrieveInstitution: (id: string, params: RequestParams = {}) =>
      this.request<IntegrationRetrieve, ErrorResponse>({
        path: `/api/v2/institutions/${id}/`,
        method: 'GET',
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Retrieve all requisitions belonging to the company
     *
     * @tags requisitions
     * @name RetrieveAllRequisitions
     * @request GET:/api/v2/requisitions/
     * @secure
     */
    retrieveAllRequisitions: (
      query?: {
        /**
         * Number of results to return per page.
         * @min 1
         * @default 100
         */
        limit?: number;
        /**
         * The initial zero-based index from which to return the results.
         * @min 0
         * @default 0
         */
        offset?: number;
      },
      params: RequestParams = {},
    ) =>
      this.request<PaginatedRequisitionList, ErrorResponse>({
        path: `/api/v2/requisitions/`,
        method: 'GET',
        query: query,
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Create a new requisition
     *
     * @tags requisitions
     * @name CreateRequisition
     * @request POST:/api/v2/requisitions/
     * @secure
     */
    createRequisition: (data: RequisitionRequest, params: RequestParams = {}) =>
      this.request<SpectacularRequisition, ErrorResponse>({
        path: `/api/v2/requisitions/`,
        method: 'POST',
        body: data,
        secure: true,
        type: ContentType.Json,
        format: 'json',
        ...params,
      }),

    /**
     * @description Retrieve a requisition by ID
     *
     * @tags requisitions
     * @name RequisitionById
     * @request GET:/api/v2/requisitions/{id}/
     * @secure
     */
    requisitionById: (id: string, params: RequestParams = {}) =>
      this.request<Requisition, ErrorResponse>({
        path: `/api/v2/requisitions/${id}/`,
        method: 'GET',
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Delete requisition and its end user agreement
     *
     * @tags requisitions
     * @name DeleteRequisitionById
     * @request DELETE:/api/v2/requisitions/{id}/
     * @secure
     */
    deleteRequisitionById: (id: string, params: RequestParams = {}) =>
      this.request<SuccessfulDeleteResponse, ErrorResponse>({
        path: `/api/v2/requisitions/${id}/`,
        method: 'DELETE',
        secure: true,
        format: 'json',
        ...params,
      }),

    /**
     * @description Obtain JWT pair
     *
     * @tags token
     * @name ObtainNewAccessRefreshTokenPair
     * @request POST:/api/v2/token/new/
     * @secure
     */
    obtainNewAccessRefreshTokenPair: (data: JWTObtainPairRequest, params: RequestParams = {}) =>
      this.request<SpectacularJWTObtain, ErrorResponse>({
        path: `/api/v2/token/new/`,
        method: 'POST',
        body: data,
        secure: true,
        type: ContentType.Json,
        format: 'json',
        ...params,
      }),

    /**
     * @description Refresh access token
     *
     * @tags token
     * @name GetANewAccessToken
     * @request POST:/api/v2/token/refresh/
     * @secure
     */
    getANewAccessToken: (data: JWTRefreshRequest, params: RequestParams = {}) =>
      this.request<SpectacularJWTRefresh, ErrorResponse>({
        path: `/api/v2/token/refresh/`,
        method: 'POST',
        body: data,
        secure: true,
        type: ContentType.Json,
        format: 'json',
        ...params,
      }),
  };
}
