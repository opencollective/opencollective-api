/* eslint-disable camelcase */

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
    batch_status: 'DENIED' | 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'CANCELED';
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
    transaction_status:
      | 'SUCCESS'
      | 'FAILED'
      | 'PENDING'
      | 'UNCLAIMED'
      | 'RETURNED'
      | 'ONHOLD'
      | 'BLOCKED'
      | 'REFUNDED'
      | 'REVERSED';
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
