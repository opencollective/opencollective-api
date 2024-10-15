import { Jwt } from 'jsonwebtoken';

export type PlaidWebhookRequest = {
  webhook_code: 'SYNC_UPDATES_AVAILABLE' | 'DEFAULT_UPDATE' | 'HISTORICAL_UPDATE' | 'INITIAL_UPDATE';
  environment: 'sandbox' | 'development' | 'production';
  error: unknown;
  item_id: string;
  new_transactions: number;
  webhook_type: 'TRANSACTIONS';
};

export type PlaidWebhookDecodedJWTToken = Jwt & {
  request_body_sha256: string;
};
