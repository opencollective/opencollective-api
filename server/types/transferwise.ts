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
