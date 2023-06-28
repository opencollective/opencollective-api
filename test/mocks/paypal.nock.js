import nock from 'nock';

export const nockPayPalGetCredentials = () =>
  nock('https://api.sandbox.paypal.com:443')
    .post('/v1/oauth2/token', 'grant_type=client_credentials')
    .reply(
      200,
      {
        scope:
          'https://uri.paypal.com/services/subscriptions https://api.paypal.com/v1/payments/.* https://api.paypal.com/v1/vault/credit-card https://uri.paypal.com/services/applications/webhooks openid https://uri.paypal.com/payments/payouts https://api.paypal.com/v1/vault/credit-card/.*',
        nonce: '2016-08-03T21:01:22ZcIbqjVI2MPTodCz4VkKZptGUDo0l77kE0W9HJCarniE',
        access_token:
          'A101.gP5cjIGBF4eAVuq_hTrafQ7F_DqZ0FPqNgi_OnDAP31Pf8r-9GRbtYR5HyN-bjQ0.LeHej6pGR28T6nKme0E1MCB-3cC',
        token_type: 'Bearer',
        app_id: 'APP-80W284485P519543T',
        expires_in: 31244,
      },
      {
        date: 'Wed, 03 Aug 2016 21:20:38 GMT',
        server: 'Apache',
        proxy_server_info: 'host=slcsbplatformapiserv3002.slc.paypal.com;threadId=1401',
        'paypal-debug-id': 'b0f91a413f6f1, b0f91a413f6f1',
        'correlation-id': 'b0f91a413f6f1',
        'x-paypal-token-service': 'IAAS',
        connection: 'close',
        'set-cookie': [
          'X-PP-SILOVER=name%3DSANDBOX3.API.1%26silo_version%3D1880%26app%3Dplatformapiserv%26TIME%3D643867223%26HTTP_X_PP_AZ_LOCATOR%3D; Expires=Wed, 03 Aug 2016 21:50:38 GMT; domain=.paypal.com; path=/; Secure; HttpOnly',
          'X-PP-SILOVER=; Expires=Thu, 01 Jan 1970 00:00:01 GMT',
        ],
        vary: 'Authorization',
        'content-length': '550',
        'content-type': 'application/json',
      },
    );
