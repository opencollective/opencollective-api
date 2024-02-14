# Environment Variables

| Environment Variable                      | Config Name(name on the `config` file)             | Description                                                                    |
| ----------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| OC_ENV                                    | .env                                               | Application Environment variable                                               |
| PG_DATABASE                               | .database.database                                 | Postgres database name                                                         |
| PG_USERNAME                               | .database.username                                 | Postgres database username                                                     |
| PG_PASSWORD                               | .database.password                                 | Postgres database password                                                     |
| PG_HOST                                   | .database.options.host                             | Postgres database host                                                         |
| PG_MIN_CONNECTIONS                        | .database.options.pool.min                         | Postgres number of min connections                                             |
| PG_MAX_CONNECTIONS                        | .database.options.pool.max                         | Postgres number of max connections                                             |
| API_KEY                                   | .keys.opencollective.apiKey                        | The API KEY                                                                    |
| JWT_SECRET                                | .keys.opencollective.jwtSecret                     | JWT secret                                                                     |
| EMAIL_UNSUBSCRIBE_SECRET                  | .keys.opencollective.emailUnsubscribeSecret        | JWT secret                                                                     |
| STRIPE_CLIENT_ID                          | .stripe.client_id                                  | Stripe Client id                                                               |
| STRIPE_KEY                                | .stripe.key                                        | Stripe key                                                                     |
| STRIPE_SECRET                             | .stripe.secret                                     | Stripe secret                                                                  |
| SENTRY_DSN                                | .sentry.dsn                                        | Sentry DSN                                                                     |
| SENTRY_TRACES_SAMPLE_RATE                 | .sentry.tracesSampleRate                           | Percentage of collected transactions to send to Sentry (for performances)      |
| AWS_KEY                                   | .aws.s3.key                                        | AWS key                                                                        |
| AWS_SECRET                                | .aws.s3.secret                                     | AWS secret                                                                     |
| AWS_S3_BUCKET                             | .aws.s3.bucket                                     | AWS s3 bucket to send files                                                    |
| CLOUDFLARE_KEY                            | .cloudflare.key                                    | CLOUDFLARE key                                                                 |
| CLOUDFLARE_EMAIL                          | .cloudflare.email                                  | CLOUDFLARE email                                                               |
| CLOUDFLARE_ZONE                           | .cloudflare.zone                                   | CLOUDFLARE zone                                                                |
| PAYPAL_USER_ID                            | .paypal.classic.userId                             | Paypal USER ID (legacy adaptive)                                               |
| PAYPAL_APP_ID                             | .paypal.classic.appId                              | Paypal APP ID (legacy adaptive)                                                |
| PAYPAL_PASSWORD                           | .paypal.classic.password                           | Paypal password (legacy adaptive)                                              |
| PAYPAL_SIGNATURE                          | .paypal.classic.signature                          | Paypal signature (legacy adaptive)                                             |
| MAILGUN_USER                              | .mailgun.user                                      | mailgun user                                                                   |
| MAILGUN_API_KEY                           | .mailgun.apiKey                                    | mailgun password                                                               |
| API_URL                                   | .host.api                                          | API exposed url                                                                |
| WEBSITE_URL                               | .host.website                                      | UI URL                                                                         |
| FRONTEND_URL                              | .host.frontend                                     | URL of the frontend service (for caching)                                      |
| SLACK_WEBHOOK_ABUSE                       | .slack.webhooks.abuse                              | slack abuse webhook url                                                        |
| GITHUB_CLIENT_ID                          | .github.clientId                                   | github client ID                                                               |
| GITHUB_CLIENT_SECRET                      | .github.clientSecret                               | github client secret                                                           |
| TWITTER_CONSUMER_KEY                      | .twitter.consumerKey                               | twitter key                                                                    |
| TWITTER_CONSUMER_SECRET                   | .twitter.consumerSecret                            | twitter secret                                                                 |
| TWITTER_DISABLE                           | .twitter.disable                                   | disable twitter integration                                                    |
| FOREST_AUTH_SECRET                        |                                                    | forest auth secret                                                             |
| FOREST_ENV_SECRET                         |                                                    | forest environment secret                                                      |
|                                           | .stripe.redirectUri                                |                                                                                |
| HELLO_WORKS_KEY                           | .helloworks.key                                    | HelloWorks key                                                                 |
| HELLO_WORKS_SECRET                        | .helloworks.secret                                 | HelloWorks secret                                                              |
| HELLO_WORKS_DOCUMENT_ENCRYPTION_KEY       | .helloworks.documentEncryptionKey                  | base64 encoded secret key for encrypting document before storage.              |
| HELLO_WORKS_AWS_S3_BUCKET                 | .helloworks.aws.s3.bucket                          | the bucket where tax forms will be uploaded                                    |
| GITHUB_FLOW_MIN_NB_STARS                  | .githubFlow.minNbStars                             | Minimum number of Github stars required to apply to the open source collective |
| TRANSFERWISE_API_URL                      | .transferwise.apiUrl                               |                                                                                |
| TRANSFERWISE_OAUTH_URL                    | .transferwise.oauthUrl                             |                                                                                |
| TRANSFERWISE_CLIENT_KEY                   | .transferwise.clientKey                            |                                                                                |
| TRANSFERWISE_CLIENT_ID                    | .transferwise.clientId                             |                                                                                |
| TRANSFERWISE_CLIENT_SECRET                | .transferwise.clientSecret                         |                                                                                |
| TRANSFERWISE_REDIRECT_URI                 | .transferwise.redirectUri                          |                                                                                |
| TRANSFERWISE_PRIVATE_KEY                  | .transferwise.privateKey                           |                                                                                |
| TRANSFERWISE_BLOCKED_CURRENCIES           | .transferwise.blockedCurrencies                    |                                                                                |
| TRANSFERWISE_BLOCKED_CURRENCIES_BUSINESS  | .transferwise.blockedCurrenciesForBusinessProfiles |                                                                                |
| TRANSFERWISE_BLOCKED_CURRENCIES_NONPROFIT | .transferwise.blockedCurrenciesForNonProfits       |                                                                                |
| KLIPPA_API_KEY                            | .klippa.apiKey                                     | The API key for Klippa                                                         |
| KLIPPA_ENABLED                            | .klippa.enabled                                    | Whether Klippa is enabled                                                      |
| WEB_CONCURRENCY                           | .webConcurrency                                    | Number of workers. Automatically set by Heroku, otherwise defaults to 1.       |
