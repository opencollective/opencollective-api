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
  items: {
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
  }[];
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
