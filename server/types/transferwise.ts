export type Quote = {
  id?: number;
  source: string;
  target: string;
  sourceAmount: number;
  targetAmount: number;
  type: string;
  rate: number;
  createdTime: string;
  createdByUserId: number;
  profile: number;
  rateType: string;
  deliveryEstimate: string;
  fee: number;
  allowedProfileTypes: Array<'PERSONAL' | 'BUSINESS'>;
  guaranteedTargetAmount: boolean;
  ofSourceAmount: boolean;
};

export type RecipientAccount = {
  id?: number;
  currency: string;
  type: string;
  accountHolderName: string;
  legalType: 'PRIVATE' | 'BUSINESS';
  details: {
    address?: string;
    email?: string;
    accountNumber?: string;
    sortCode?: string;
    abartn?: string;
    accountType?: string;
    bankgiroNumber?: string;
    ifscCode?: string;
    bsbCode?: string;
    institutionNumber?: string;
    transitNumber?: string;
    phoneNumber?: string;
    bankCode?: string;
    russiaRegion?: string;
    routingNumber?: string;
    branchCode?: string;
    cpf?: string;
    cardNumber?: string;
    idType?: string;
    idNumber?: string;
    idCountryIso3?: string;
    idValidFrom?: string;
    idValidTo?: string;
    clabe?: string;
    swiftCode?: string;
    dateOfBirth?: string;
    clearingNumber?: string;
    bankName?: string;
    branchName?: string;
    businessNumber?: string;
    province?: string;
    city?: string;
    rut?: string;
    token?: string;
    cnpj?: string;
    payinReference?: string;
    pspReference?: string;
    orderId?: string;
    idDocumentType?: string;
    idDocumentNumber?: string;
    targetProfile?: string;
    targetUserId?: string;
    taxId?: string;
    job?: string;
    nationality?: string;
    interacAccount?: string;
    bban?: string;
    iban?: string;
    bic?: string;
    IBAN?: string;
    BIC?: string;
  };
};

export type PersonalProfile = {
  id: number;
  type: 'personal' | 'business';
  details: {
    firstName: string;
    lastName: string;
    dateOfBirth: string; // YYYY-MM-DD
    phoneNumber: string;
    avatar: string;
    occupation: string;
    primaryAddress: number | string | null;
  };
};

export type BusinessProfile = {
  id: number;
  type: 'business';
  details: {
    name: string;
    registrationNumber: string;
    acn: string | null;
    abn: string | null;
    arbn: string | null;
    companyType: string;
    companyRole: string;
    descriptionOfBusiness: string;
    webpage: string;
    primaryAddress: number | string | null;
    businessCategory: string;
    businessSubCategory: string;
  };
};

export type Profile = PersonalProfile | BusinessProfile;

export type TransferStatus =
  | 'incoming_payment_waiting'
  | 'waiting_recipient_input_to_proceed'
  | 'processing'
  | 'funds_converted'
  | 'outgoing_payment_sent'
  | 'cancelled'
  | 'funds_refunded'
  | 'bounced_back';

export interface WebhookEvent {
  data: Record<string, any>;
  subscription_id: string;
  event_type: string;
  schema_version: '2.0.0';
  sent_at: string;
}

export interface TransferStateChangeEvent extends WebhookEvent {
  data: {
    resource: {
      id: number;
      profile_id: number;
      account_id: number;
      type: 'transfer';
    };
    current_state: TransferStatus;
    previous_state: TransferStatus;
    occurred_at: string;
  };
  event_type: 'transfers#state-change';
}

export type Transfer = {
  id: number;
  user: number;
  targetAccount: number;
  sourceAccount: null | number;
  quote: number;
  status: string;
  reference?: string;
  rate: number;
  created: string;
  business: number;
  transferRequest: null | number;
  details: {
    reference?: string;
  };
  hasActiveIssues: boolean;
  sourceCurrency: string;
  sourceValue: number;
  targetCurrency: string;
  targetValue: number;
  customerTransactionId: string;
};

export type CurrencyPair = {
  currencyCode: string;
  maxInvoiceAmount: number;
  targetCurrencies: {
    currencyCode: string;
    minInvoiceAmount: number;
    fixedTargetPaymentAllowed: boolean;
  }[];
};

export type Balance = {
  balanceType: string;
  currency: string;
  amount: {
    value: number;
    currency: string;
  };
  reservedAmount: {
    value: number;
    currency: string;
  };
  bankDetails: null | {
    id: number;
    currency: string;
    bankCode: string | null;
    accountNumber: string | null;
    swift: string | null;
    iban: string | null;
    bankName: string | null;
    accountHolderName: string | null;
    bankAddress: {
      addressFirstLine: string | null;
      postCode: string | null;
      city: string | null;
      country: string | null;
      stateCode: string | null;
    };
  };
};

export type BorderlessAccount = {
  id: number;
  profileId: number;
  recipientId: number;
  creationTime: string;
  modificationTime: string;
  active: boolean;
  eligible: boolean;
  balances: Balance[];
};
