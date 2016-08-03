const nock = require('nock');

nock('https://api.sandbox.paypal.com:443')
  .post('/v1/oauth2/token', "grant_type=client_credentials")
  .reply(200, {"scope":"https://uri.paypal.com/services/subscriptions https://api.paypal.com/v1/payments/.* https://api.paypal.com/v1/vault/credit-card https://uri.paypal.com/services/applications/webhooks openid https://uri.paypal.com/payments/payouts https://api.paypal.com/v1/vault/credit-card/.*","nonce":"2016-08-03T21:01:22ZcIbqjVI2MPTodCz4VkKZptGUDo0l77kE0W9HJCarniE","access_token":"A101.gP5cjIGBF4eAVuq_hTrafQ7F_DqZ0FPqNgi_OnDAP31Pf8r-9GRbtYR5HyN-bjQ0.LeHej6pGR28T6nKme0E1MCB-3cC","token_type":"Bearer","app_id":"APP-80W284485P519543T","expires_in":31244}, { date: 'Wed, 03 Aug 2016 21:20:38 GMT',
  server: 'Apache',
  proxy_server_info: 'host=slcsbplatformapiserv3002.slc.paypal.com;threadId=1401',
  'paypal-debug-id': 'b0f91a413f6f1, b0f91a413f6f1',
  'correlation-id': 'b0f91a413f6f1',
  'x-paypal-token-service': 'IAAS',
  connection: 'close',
  'set-cookie':
   [ 'X-PP-SILOVER=name%3DSANDBOX3.API.1%26silo_version%3D1880%26app%3Dplatformapiserv%26TIME%3D643867223%26HTTP_X_PP_AZ_LOCATOR%3D; Expires=Wed, 03 Aug 2016 21:50:38 GMT; domain=.paypal.com; path=/; Secure; HttpOnly',
     'X-PP-SILOVER=; Expires=Thu, 01 Jan 1970 00:00:01 GMT' ],
  vary: 'Authorization',
  'content-length': '550',
  'content-type': 'application/json' });


nock('https://api.sandbox.paypal.com:443')
  .post('/v1/payments/billing-plans/', {"description":"donation of USD 10 / month to WWCode Austin","name":"Plan for donation of USD 10 / month to WWCode Austin","merchant_preferences":{"cancel_url":"http://localhost:3060/groups/1/transactions/1/callback","return_url":"http://localhost:3060/groups/1/transactions/1/callback"},"payment_definitions":[{"amount":{"currency":"USD","value":10},"cycles":"0","frequency":"MONTH","frequency_interval":"1","name":"Regular payment","type":"REGULAR"}],"type":"INFINITE"})
  .reply(201, {"id":"P-9LU31061JM5918805KJDZNQA","state":"CREATED","name":"Plan for donation of USD 10 / month to WWCode Austin","description":"donation of USD 10 / month to WWCode Austin","type":"INFINITE","payment_definitions":[{"id":"PD-0G554669WU5823836KJDZNQA","name":"Regular payment","type":"REGULAR","frequency":"Month","amount":{"currency":"USD","value":"10"},"cycles":"0","charge_models":[],"frequency_interval":"1"}],"merchant_preferences":{"setup_fee":{"currency":"USD","value":"0"},"max_fail_attempts":"0","return_url":"http://localhost:3060/groups/1/transactions/1/callback","cancel_url":"http://localhost:3060/groups/1/transactions/1/callback","auto_bill_amount":"NO","initial_fail_amount_action":"CONTINUE"},"create_time":"2016-08-03T21:20:38.592Z","update_time":"2016-08-03T21:20:38.592Z","links":[{"href":"https://api.sandbox.paypal.com/v1/payments/billing-plans/P-9LU31061JM5918805KJDZNQA","rel":"self","method":"GET"}]}, { date: 'Wed, 03 Aug 2016 21:20:38 GMT',
  server: 'Apache',
  proxy_server_info: 'host=slcsbplatformapiserv3001.slc.paypal.com;threadId=536',
  'paypal-debug-id': 'a2e4ccc7876a3, a2e4ccc7876a3',
  'correlation-id': 'a2e4ccc7876a3',
  'content-language': '*',
  connection: 'close',
  'set-cookie':
   [ 'X-PP-SILOVER=name%3DSANDBOX3.API.1%26silo_version%3D1880%26app%3Dplatformapiserv%26TIME%3D643867223%26HTTP_X_PP_AZ_LOCATOR%3D; Expires=Wed, 03 Aug 2016 21:50:38 GMT; domain=.paypal.com; path=/; Secure; HttpOnly',
     'X-PP-SILOVER=; Expires=Thu, 01 Jan 1970 00:00:01 GMT' ],
  vary: 'Authorization',
  'content-length': '925',
  'content-type': 'application/json' });

nock('https://api.sandbox.paypal.com:443')
  .patch('/v1/payments/billing-plans/P-9LU31061JM5918805KJDZNQA', [{"op":"replace","path":"/","value":{"state":"ACTIVE"}}])
  .reply(200, "", { date: 'Wed, 03 Aug 2016 21:20:38 GMT',
  server: 'Apache',
  proxy_server_info: 'host=slcsbplatformapiserv3002.slc.paypal.com;threadId=338',
  'paypal-debug-id': '5cf4d052d896a, 5cf4d052d896a',
  'correlation-id': '5cf4d052d896a',
  'content-language': '*',
  connection: 'close',
  'set-cookie':
   [ 'X-PP-SILOVER=name%3DSANDBOX3.API.1%26silo_version%3D1880%26app%3Dplatformapiserv%26TIME%3D643867223%26HTTP_X_PP_AZ_LOCATOR%3D; Expires=Wed, 03 Aug 2016 21:50:39 GMT; domain=.paypal.com; path=/; Secure; HttpOnly',
     'X-PP-SILOVER=; Expires=Thu, 01 Jan 1970 00:00:01 GMT' ],
  vary: 'Authorization',
  'content-length': '0',
  'content-type': 'text/xml' });

nock('https://api.sandbox.paypal.com:443')
  .post('/v1/payments/billing-agreements/', {"name":"Agreement for donation of USD 10 / month to WWCode Austin","description":"donation of USD 10 / month to WWCode Austin","start_date":"2016-08-03T21:20:43.837Z","plan":{"id":"P-9LU31061JM5918805KJDZNQA"},"payer":{"payment_method":"paypal"}})
  .reply(201, {"name":"Agreement for donation of USD 10 / month to WWCode Austin","description":"donation of USD 10 / month to WWCode Austin","plan":{"id":"P-9LU31061JM5918805KJDZNQA","state":"ACTIVE","name":"Plan for donation of USD 10 / month to WWCode Austin","description":"donation of USD 10 / month to WWCode Austin","type":"INFINITE","payment_definitions":[{"id":"PD-0G554669WU5823836KJDZNQA","name":"Regular payment","type":"REGULAR","frequency":"Month","amount":{"currency":"USD","value":"10"},"cycles":"0","charge_models":[],"frequency_interval":"1"}],"merchant_preferences":{"setup_fee":{"currency":"USD","value":"0"},"max_fail_attempts":"0","return_url":"http://localhost:3060/groups/1/transactions/1/callback","cancel_url":"http://localhost:3060/groups/1/transactions/1/callback","auto_bill_amount":"NO","initial_fail_amount_action":"CONTINUE"}},"links":[{"href":"https://www.sandbox.paypal.com/cgi-bin/webscr?cmd=_express-checkout&token=EC-4L33313259490452N","rel":"approval_url","method":"REDIRECT"},{"href":"https://api.sandbox.paypal.com/v1/payments/billing-agreements/EC-4L33313259490452N/agreement-execute","rel":"execute","method":"POST"}],"start_date":"2016-08-03T21:20:43.837Z"}, { date: 'Wed, 03 Aug 2016 21:20:40 GMT',
  server: 'Apache',
  proxy_server_info: 'host=slcsbplatformapiserv3002.slc.paypal.com;threadId=330',
  'paypal-debug-id': 'df3d58b418c67, df3d58b418c67',
  'correlation-id': 'df3d58b418c67',
  'content-language': '*',
  connection: 'close',
  'set-cookie':
   [ 'X-PP-SILOVER=name%3DSANDBOX3.API.1%26silo_version%3D1880%26app%3Dplatformapiserv%26TIME%3D677421655%26HTTP_X_PP_AZ_LOCATOR%3D; Expires=Wed, 03 Aug 2016 21:50:41 GMT; domain=.paypal.com; path=/; Secure; HttpOnly',
     'X-PP-SILOVER=; Expires=Thu, 01 Jan 1970 00:00:01 GMT' ],
  vary: 'Authorization',
  'content-length': '1186',
  'content-type': 'application/json' });

nock('https://api.sandbox.paypal.com:443')
  .post('/v1/payments/billing-plans/', {"description":"donation of USD 10 / month to WWCode Austin","name":"Plan for donation of USD 10 / month to WWCode Austin","merchant_preferences":{"cancel_url":"http://localhost:3060/groups/1/transactions/1/callback","return_url":"http://localhost:3060/groups/1/transactions/1/callback"},"payment_definitions":[{"amount":{"currency":"USD","value":10},"cycles":"0","frequency":"MONTH","frequency_interval":"1","name":"Regular payment","type":"REGULAR"}],"type":"INFINITE"})
  .reply(201, {"id":"P-70J82902LM081770FKJD2L6A","state":"CREATED","name":"Plan for donation of USD 10 / month to WWCode Austin","description":"donation of USD 10 / month to WWCode Austin","type":"INFINITE","payment_definitions":[{"id":"PD-76000583BP697171BKJD2L6A","name":"Regular payment","type":"REGULAR","frequency":"Month","amount":{"currency":"USD","value":"10"},"cycles":"0","charge_models":[],"frequency_interval":"1"}],"merchant_preferences":{"setup_fee":{"currency":"USD","value":"0"},"max_fail_attempts":"0","return_url":"http://localhost:3060/groups/1/transactions/1/callback","cancel_url":"http://localhost:3060/groups/1/transactions/1/callback","auto_bill_amount":"NO","initial_fail_amount_action":"CONTINUE"},"create_time":"2016-08-03T21:20:42.488Z","update_time":"2016-08-03T21:20:42.488Z","links":[{"href":"https://api.sandbox.paypal.com/v1/payments/billing-plans/P-70J82902LM081770FKJD2L6A","rel":"self","method":"GET"}]}, { date: 'Wed, 03 Aug 2016 21:20:42 GMT',
  server: 'Apache',
  proxy_server_info: 'host=slcsbplatformapiserv3001.slc.paypal.com;threadId=375',
  'paypal-debug-id': 'bd99460b6cc62, bd99460b6cc62',
  'correlation-id': 'bd99460b6cc62',
  'content-language': '*',
  connection: 'close',
  'set-cookie':
   [ 'X-PP-SILOVER=name%3DSANDBOX3.API.1%26silo_version%3D1880%26app%3Dplatformapiserv%26TIME%3D710976087%26HTTP_X_PP_AZ_LOCATOR%3D; Expires=Wed, 03 Aug 2016 21:50:42 GMT; domain=.paypal.com; path=/; Secure; HttpOnly',
     'X-PP-SILOVER=; Expires=Thu, 01 Jan 1970 00:00:01 GMT' ],
  vary: 'Authorization',
  'content-length': '925',
  'content-type': 'application/json' });

nock('https://api.sandbox.paypal.com:443')
  .patch('/v1/payments/billing-plans/P-70J82902LM081770FKJD2L6A', [{"op":"replace","path":"/","value":{"state":"ACTIVE"}}])
  .reply(200, "", { date: 'Wed, 03 Aug 2016 21:20:43 GMT',
  server: 'Apache',
  proxy_server_info: 'host=slcsbplatformapiserv3001.slc.paypal.com;threadId=413',
  'paypal-debug-id': '8d5c5860ed73e, 8d5c5860ed73e',
  'correlation-id': '8d5c5860ed73e',
  'content-language': '*',
  connection: 'close',
  'set-cookie':
   [ 'X-PP-SILOVER=name%3DSANDBOX3.API.1%26silo_version%3D1880%26app%3Dplatformapiserv%26TIME%3D727753303%26HTTP_X_PP_AZ_LOCATOR%3D; Expires=Wed, 03 Aug 2016 21:50:44 GMT; domain=.paypal.com; path=/; Secure; HttpOnly',
     'X-PP-SILOVER=; Expires=Thu, 01 Jan 1970 00:00:01 GMT' ],
  vary: 'Authorization',
  'content-length': '0',
  'content-type': 'text/xml' });

nock('https://api.sandbox.paypal.com:443')
  .post('/v1/payments/billing-agreements/', {"name":"Agreement for donation of USD 10 / month to WWCode Austin","description":"donation of USD 10 / month to WWCode Austin","start_date":"2016-08-03T21:20:48.854Z","plan":{"id":"P-70J82902LM081770FKJD2L6A"},"payer":{"payment_method":"paypal"}})
  .reply(201, {"name":"Agreement for donation of USD 10 / month to WWCode Austin","description":"donation of USD 10 / month to WWCode Austin","plan":{"id":"P-70J82902LM081770FKJD2L6A","state":"ACTIVE","name":"Plan for donation of USD 10 / month to WWCode Austin","description":"donation of USD 10 / month to WWCode Austin","type":"INFINITE","payment_definitions":[{"id":"PD-76000583BP697171BKJD2L6A","name":"Regular payment","type":"REGULAR","frequency":"Month","amount":{"currency":"USD","value":"10"},"cycles":"0","charge_models":[],"frequency_interval":"1"}],"merchant_preferences":{"setup_fee":{"currency":"USD","value":"0"},"max_fail_attempts":"0","return_url":"http://localhost:3060/groups/1/transactions/1/callback","cancel_url":"http://localhost:3060/groups/1/transactions/1/callback","auto_bill_amount":"NO","initial_fail_amount_action":"CONTINUE"}},"links":[{"href":"https://www.sandbox.paypal.com/cgi-bin/webscr?cmd=_express-checkout&token=EC-6F714728WB9804158","rel":"approval_url","method":"REDIRECT"},{"href":"https://api.sandbox.paypal.com/v1/payments/billing-agreements/EC-6F714728WB9804158/agreement-execute","rel":"execute","method":"POST"}],"start_date":"2016-08-03T21:20:48.854Z"}, { date: 'Wed, 03 Aug 2016 21:20:45 GMT',
  server: 'Apache',
  proxy_server_info: 'host=slcsbplatformapiserv3002.slc.paypal.com;threadId=356',
  'paypal-debug-id': '33c8098f14434, 33c8098f14434',
  'correlation-id': '33c8098f14434',
  'content-language': '*',
  connection: 'close',
  'set-cookie':
   [ 'X-PP-SILOVER=name%3DSANDBOX3.API.1%26silo_version%3D1880%26app%3Dplatformapiserv%26TIME%3D761307735%26HTTP_X_PP_AZ_LOCATOR%3D; Expires=Wed, 03 Aug 2016 21:50:46 GMT; domain=.paypal.com; path=/; Secure; HttpOnly',
     'X-PP-SILOVER=; Expires=Thu, 01 Jan 1970 00:00:01 GMT' ],
  vary: 'Authorization',
  'content-length': '1186',
  'content-type': 'application/json' });