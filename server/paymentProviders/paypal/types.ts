export interface PaypalUserInfo {
  user_id: string;
  sub: string;
  name: string;
  payer_id: string;
  address: {
    street_address: string;
    locality: string;
    region: string;
    postal_code: string;
    country: string;
  };
  verified_account: 'true' | string;
  emails: {
    value: string;
    primary: boolean;
    confirmed: boolean;
  }[];
}
