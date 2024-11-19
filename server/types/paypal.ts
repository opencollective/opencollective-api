/* eslint-disable camelcase */

type BatchStatus = 'DENIED' | 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'CANCELED';

type TransactionStatus =
  | 'SUCCESS'
  | 'FAILED'
  | 'PENDING'
  | 'UNCLAIMED'
  | 'RETURNED'
  | 'ONHOLD'
  | 'BLOCKED'
  | 'REFUNDED'
  | 'REVERSED';

export type PayoutRequestBody = {
  sender_batch_header: {
    recipient_type: string;
    email_message: string;
    sender_batch_id: string;
    email_subject: string;
  };
  items: {
    note: string;
    receiver: string;
    sender_item_id: string;
    amount: {
      currency: string;
      value: string;
    };
  }[];
};

export type PayoutRequestResult = {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
    sender_batch_header: {
      email_subject: string;
      sender_batch_id: string;
    };
  };
};

export type PayoutItemDetails = {
  payout_item_id: string;
  transaction_id: string;
  transaction_status: TransactionStatus;
  payout_batch_id: string;
  payout_item_fee: {
    currency: string;
    value: string;
  };
  payout_item: {
    recipient_type: 'EMAIL';
    amount: {
      value: string;
      currency: string;
    };
    note: string;
    receiver: string;
    sender_item_id: string;
  };
  time_processed: string;
  currency_conversion?: {
    to_amount: { value: number; currency: string };
    from_amount: { value: number; currency: string };
    exchange_rate: string;
  };
  errors?: {
    name: string;
    debug_id: string;
    message: string;
    information_link: string;
    payout_errors_details: {
      field: string;
      issue: string;
    }[];
  };
};

export type PayoutBatchDetails = {
  batch_header: {
    payout_batch_id: string;
    batch_status: BatchStatus;
    time_created: string;
    time_completed: string;
    sender_batch_header: {
      sender_batch_id: string;
      email_subject: string;
    };
    amount: {
      value: string;
      currency: string;
    };
    fees: {
      value: string;
      currency: string;
    };
  };
  items: PayoutItemDetails[];
};

type PayPalLink = {
  href: string;
  rel: string;
  method: string;
};

type PayoutWebhookEventType =
  | 'PAYMENT.PAYOUTSBATCH.DENIED'
  | 'PAYMENT.PAYOUTSBATCH.PROCESSING'
  | 'PAYMENT.PAYOUTSBATCH.SUCCESS'
  | 'PAYMENT.PAYOUTS-ITEM.BLOCKED'
  | 'PAYMENT.PAYOUTS-ITEM.CANCELED'
  | 'PAYMENT.PAYOUTS-ITEM.DENIED'
  | 'PAYMENT.PAYOUTS-ITEM.FAILED'
  | 'PAYMENT.PAYOUTS-ITEM.HELD'
  | 'PAYMENT.PAYOUTS-ITEM.REFUNDED'
  | 'PAYMENT.PAYOUTS-ITEM.RETURNED'
  | 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED'
  | 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED';

export type PayoutWebhookRequest = {
  id: string;
  event_version: string;
  create_time: string;
  resource_type: 'payouts_item';
  event_type: PayoutWebhookEventType;
  summary: string;
  resource: {
    payout_item_id: string;
    transaction_id: string;
    transaction_status: TransactionStatus;
    payout_item_fee: {
      currency: string;
      value: string;
    };
    payout_batch_id: string;
    payout_item: {
      recipient_type: 'EMAIL';
      amount: {
        currency: string;
        value: string;
      };
      note: string;
      receiver: string;
      sender_item_id: string;
    };
    time_processed: string;
    links: PayPalLink[];
  };
  links: PayPalLink[];
};

export type PaypalWebhookEventType = {
  name: string;
  description: string;
};

export type PaypalWebhook = {
  id: string;
  url: string;
  event_types: PaypalWebhookEventType[];
};

export type PaypalWebhookPatch = {
  op: string;
  path: string;
  value: string | PaypalWebhookEventType[];
}[];

export type PaypalTransactionAmount = {
  currency_code: string;
  value: string;
};

export type PaypalTransactionSearchResult = {
  account_number: string;
  last_refreshed_datetime: string;
  page: number;
  total_items: number;
  total_pages: number;
  transaction_details: Array<{
    transaction_info: {
      paypal_account_id: string;
      transaction_id: string;
      transaction_event_code: string;
      transaction_initiation_date: string;
      transaction_updated_date: string;
      transaction_amount: PaypalTransactionAmount;
      paypal_reference_id?: string;
      paypal_reference_id_type?: 'ODR' | 'TXN' | 'SUB' | 'PAP';
      fee_amount: PaypalTransactionAmount;
      insurance_amount: PaypalTransactionAmount;
      shipping_amount: PaypalTransactionAmount;
      shipping_discount_amount: PaypalTransactionAmount;
      transaction_status: string;
      transaction_subject: string;
      transaction_note: string;
      invoice_id: string;
      custom_field: string;
      protection_eligibility: string;
    };
    payer_info: {
      account_id: string;
      email_address: string;
      address_status: string;
      payer_status: string;
      payer_name: {
        given_name: string;
        surname: string;
        alternate_full_name: string;
      };
      country_code: string;
    };
    shipping_info: {
      name: string;
      address: {
        line1: string;
        line2: string;
        city: string;
        country_code: string;
        postal_code: string;
      };
    };
    cart_info: {
      item_details: Array<{
        item_code?: string;
        item_name: string;
        item_description?: string;
        item_quantity: string;
        item_unit_price: PaypalTransactionAmount;
        item_amount: PaypalTransactionAmount;
        tax_amounts?: Array<{
          tax_amount: PaypalTransactionAmount;
        }>;
        total_item_amount: PaypalTransactionAmount;
        invoice_number: string;
      }>;
    };
    store_info: Record<string, never>;
    auction_info: Record<string, never>;
    incentive_info: Record<string, never>;
  }>;
};

export type PaypalCapture = {
  id: string;
  amount: PaypalTransactionAmount;
  final_capture: boolean;
  seller_protection: {
    status: string;
    dispute_categories: Array<string>;
  };
  seller_receivable_breakdown: {
    gross_amount: PaypalTransactionAmount;
    paypal_fee: PaypalTransactionAmount;
    net_amount: PaypalTransactionAmount;
  };
  status: string;
  supplementary_data: {
    related_ids: {
      order_id: string;
    };
  };
  create_time: string;
  update_time: string;
  links: Array<{
    href: string;
    rel: string;
    method: string;
  }>;
};

export type PaypalOrder = {
  id: string;
  intent: string;
  status: string;
  payment_source: {
    paypal: {
      email_address: string;
      account_id: string;
      name: {
        given_name: string;
        surname: string;
      };
      phone_number: {
        national_number: string;
      };
      address: {
        country_code: string;
      };
    };
  };
  purchase_units: Array<{
    reference_id: string;
    amount: {
      currency_code: string;
      value: string;
      breakdown: {
        item_total: PaypalTransactionAmount;
        shipping: PaypalTransactionAmount;
        handling: PaypalTransactionAmount;
        insurance: PaypalTransactionAmount;
        shipping_discount: PaypalTransactionAmount;
        discount: PaypalTransactionAmount;
      };
    };
    payee: {
      email_address: string;
      merchant_id: string;
    };
    soft_descriptor: string;
    shipping: {
      name: {
        full_name: string;
      };
    };
    payments: {
      captures: Array<{
        id: string;
        status: string;
        amount: PaypalTransactionAmount;
        final_capture: boolean;
        seller_protection: {
          status: string;
          dispute_categories: Array<string>;
        };
        seller_receivable_breakdown: {
          gross_amount: PaypalTransactionAmount;
          paypal_fee: PaypalTransactionAmount;
          net_amount: PaypalTransactionAmount;
        };
        links: Array<{
          href: string;
          rel: string;
          method: string;
        }>;
        create_time: string;
        update_time: string;
      }>;
    };
  }>;
  payer: {
    name: {
      given_name: string;
      surname: string;
    };
    email_address: string;
    payer_id: string;
    phone: {
      phone_number: {
        national_number: string;
      };
    };
    address: {
      country_code: string;
    };
  };
  update_time: string;
  links: Array<{
    href: string;
    rel: string;
    method: string;
  }>;
};

export type PaypalTransaction = {
  id: string;
  time: string;
  status: string;
  payer_name: {
    surname: string;
    given_name: string;
  };
  payer_email: string;
  amount_with_breakdown: {
    fee_amount: PaypalTransactionAmount;
    net_amount: PaypalTransactionAmount;
    gross_amount: PaypalTransactionAmount;
  };
};

export type PaypalSale = {
  id: string;
  links: Array<{
    rel: string;
    href: string;
    method: string;
  }>;
  state: string;
  amount: {
    total: string;
    details: {
      subtotal: string;
    };
    currency: string;
  };
  create_time: string;
  update_time: string;
  payment_mode: string;
  invoice_number: string;
  transaction_fee: {
    value: string;
    currency: string;
  };
  billing_agreement_id: string;
  protection_eligibility: string;
  protection_eligibility_type: string;
};

/**
 * When fetching transactions from /v1/billing/subscriptions/{id}/transactions
 * See https://developer.paypal.com/docs/api/subscriptions/v1/#subscriptions_transactions
 */
export type SubscriptionTransactions = {
  transactions: Array<PaypalTransaction>;
  total_pages: number;
  total_items: number;
  links: Array<{
    href: string;
    rel: string;
    method: string;
  }>;
};

export type PayPalSubscription = {
  id: string;
  plan_id: string;
  start_time: string;
  quantity: string;
  shipping_amount: {
    currency_code: string;
    value: string;
  };
  subscriber: {
    shipping_address: {
      name: {
        full_name: string;
      };
      address: {
        address_line_1: string;
        address_line_2: string;
        admin_area_2: string;
        admin_area_1: string;
        postal_code: string;
        country_code: string;
      };
    };
    name: {
      given_name: string;
      surname: string;
    };
    email_address: string;
    payer_id: string;
  };
  billing_info: {
    outstanding_balance: {
      currency_code: string;
      value: string;
    };
    cycle_executions: {
      tenure_type: string;
      sequence: number;
      cycles_completed: number;
      cycles_remaining: number;
      total_cycles: number;
    }[];
    last_payment: {
      amount: {
        currency_code: string;
        value: string;
      };
      time: string;
    };
    next_billing_time: string;
    failed_payments_count: number;
  };
  create_time: string;
  update_time: string;
  links: {
    href: string;
    rel: string;
    method: string;
  }[];
  status: 'APPROVAL_PENDING' | 'APPROVED' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED';
  status_update_time: string;
};
