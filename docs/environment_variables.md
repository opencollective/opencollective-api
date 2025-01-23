# Environment Variables

| Environment Variable                          | Config Name(name on the `config` file)             | Description                                                                        |
| --------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PORT                                          | .port                                              | Application port                                                                   |
| OC_ENV                                        | .env                                               | Application Environment variable                                                   |
| ENABLE_SERVICE_SERVER                         | .services.server                                   | Enable server service                                                              |
| ENABLE_SERVICE_SEARCH_SYNC                    | .services.searchSync                               | Enable search sync service                                                         |
| MAILPIT_CLIENT                                | .mailpit.client                                    | Mailpit client configuration                                                       |
| ELASTICSEARCH_URL                             | .elasticSearch.url                                 | ElasticSearch URL                                                                  |
| ELASTICSEARCH_MAX_SYNC_DELAY                  | .elasticSearch.maxSyncDelay                        | Maximum sync delay for ElasticSearch                                               |
| ELASTICSEARCH_INDEXES_PREFIX                  | .elasticSearch.indexesPrefix                       | Prefix for ElasticSearch indexes                                                   |
| PG_URL                                        | .database.url                                      | Postgres database URL                                                              |
| PG_DATABASE                                   | .database.override.database                        | Postgres database name                                                             |
| PG_USERNAME                                   | .database.override.username                        | Postgres database username                                                         |
| PG_PASSWORD                                   | .database.override.password                        | Postgres database password                                                         |
| PG_HOST                                       | .database.override.host                            | Postgres database host                                                             |
| PG_PORT                                       | .database.override.port                            | Postgres database port                                                             |
| PG_MIN_CONNECTIONS                            | .database.options.pool.min                         | Postgres number of min connections                                                 |
| PG_MAX_CONNECTIONS                            | .database.options.pool.max                         | Postgres number of max connections                                                 |
| DATABASE_READ_ONLY                            | .database.readOnly                                 | Database read-only mode                                                            |
| APOLLO_KEY                                    | .graphql.apollo.key                                | Apollo GraphQL key                                                                 |
| APOLLO_GRAPH_REF                              | .graphql.apollo.graphRef                           | Apollo GraphQL graph reference                                                     |
| GRAPHQL_CACHE_ENABLED                         | .graphql.cache.enabled                             | Enable GraphQL cache                                                               |
| GRAPHQL_CACHE_TTL                             | .graphql.cache.ttl                                 | GraphQL cache TTL                                                                  |
| GRAPHQL_CACHE_MIN_EXECUTION_TIME_TO_CACHE     | .graphql.cache.minExecutionTimeToCache             | Minimum execution time to cache GraphQL queries                                    |
| GRAPHQL_ERROR_DETAILED                        | .graphql.error.detailed                            | Enable detailed GraphQL errors                                                     |
| GRAPHQL_RESOLVER_TIME_DEBUG                   | .graphql.resolverTimeDebugWarning                  | Enable GraphQL resolver time debug warnings                                        |
| MEMCACHE_SERVERS                              | .memcache.servers                                  | Memcache servers                                                                   |
| MEMCACHE_USERNAME                             | .memcache.username                                 | Memcache username                                                                  |
| MEMCACHE_PASSWORD                             | .memcache.password                                 | Memcache password                                                                  |
| REDIS_URL                                     | .redis.serverUrl                                   | Redis server URL                                                                   |
| REDIS_TIMELINE_URL                            | .redis.serverUrlTimeline                           | Redis timeline URL                                                                 |
| REDIS_SESSION_URL                             | .redis.serverUrlSession                            | Redis session URL                                                                  |
| API_KEY                                       | .keys.opencollective.apiKey                        | The API KEY                                                                        |
| SESSION_SECRET                                | .keys.opencollective.sessionSecret                 | Session secret                                                                     |
| JWT_SECRET                                    | .keys.opencollective.jwtSecret                     | JWT secret                                                                         |
| EMAIL_UNSUBSCRIBE_SECRET                      | .keys.opencollective.emailUnsubscribeSecret        | Email unsubscribe secret                                                           |
| HASHID_SALT                                   | .keys.opencollective.hashidSalt                    | Hashid salt                                                                        |
| LOG_LEVEL                                     | .log.level                                         | Logging level                                                                      |
| ACCESS_LOGS                                   | .log.accessLogs                                    | Enable access logs                                                                 |
| SLOW_REQUEST                                  | .log.slowRequest                                   | Enable slow request logging                                                        |
| SLOW_REQUEST_THRESHOLD                        | .log.slowRequestThreshold                          | Slow request threshold                                                             |
| PLAID_CLIENT_ID                               | .plaid.clientId                                    | Plaid client ID                                                                    |
| PLAID_SECRET                                  | .plaid.secret                                      | Plaid secret                                                                       |
| PLAID_ENV                                     | .plaid.env                                         | Plaid environment                                                                  |
| STRIPE_SECRET                                 | .stripe.secret                                     | Stripe secret                                                                      |
| STRIPE_KEY                                    | .stripe.key                                        | Stripe key                                                                         |
| STRIPE_CLIENT_ID                              | .stripe.clientId                                   | Stripe Client id                                                                   |
| STRIPE_WEBHOOK_SIGNING_SECRET                 | .stripe.webhookSigningSecret                       | Stripe webhook signing secret                                                      |
| STRIPE_PAYMENT_INTENT_ENABLED                 | .stripe.paymentIntentEnabled                       | Enable Stripe payment intent                                                       |
| STRIPE_ONETIME_PAYMENT_METHOD_CONFIGURATION   | .stripe.oneTimePaymentMethodConfiguration          | Stripe one-time payment method configuration                                       |
| STRIPE_RECURRING_PAYMENT_METHOD_CONFIGURATION | .stripe.recurringPaymentMethodConfiguration        | Stripe recurring payment method configuration                                      |
| AWS_KEY                                       | .aws.s3.key                                        | AWS key                                                                            |
| AWS_SECRET                                    | .aws.s3.secret                                     | AWS secret                                                                         |
| AWS_S3_BUCKET                                 | .aws.s3.bucket                                     | AWS s3 bucket to send files                                                        |
| AWS_S3_REGION                                 | .aws.s3.region                                     | AWS S3 region                                                                      |
| AWS_S3_API_VERSION                            | .aws.s3.apiVersion                                 | AWS S3 API version                                                                 |
| AWS_S3_ENDPOINT                               | .aws.s3.endpoint                                   | AWS S3 endpoint                                                                    |
| AWS_S3_SSL_ENABLED                            | .aws.s3.sslEnabled                                 | AWS S3 SSL enabled                                                                 |
| AWS_S3_FORCE_PATH_STYLE                       | .aws.s3.forcePathStyle                             | AWS S3 force path style                                                            |
| CLOUDFLARE_KEY                                | .cloudflare.key                                    | CLOUDFLARE key                                                                     |
| CLOUDFLARE_EMAIL                              | .cloudflare.email                                  | CLOUDFLARE email                                                                   |
| CLOUDFLARE_ZONE                               | .cloudflare.zone                                   | CLOUDFLARE zone                                                                    |
| KLIPPA_API_KEY                                | .klippa.apiKey                                     | The API key for Klippa                                                             |
| KLIPPA_ENABLED                                | .klippa.enabled                                    | Whether Klippa is enabled                                                          |
| PAYPAL_APP_ID                                 | .paypal.classic.appId                              | Paypal APP ID (legacy adaptive)                                                    |
| PAYPAL_USER_ID                                | .paypal.classic.userId                             | Paypal USER ID (legacy adaptive)                                                   |
| PAYPAL_PASSWORD                               | .paypal.classic.password                           | Paypal password (legacy adaptive)                                                  |
| PAYPAL_SIGNATURE                              | .paypal.classic.signature                          | Paypal signature (legacy adaptive)                                                 |
| PAYPAL_ENVIRONMENT                            | .paypal.payment.environment                        | PayPal payment environment                                                         |
| PAYPAL_CLIENT_ID                              | .paypal.payment.clientId                           | PayPal client ID                                                                   |
| PAYPAL_CLIENT_SECRET                          | .paypal.payment.clientSecret                       | PayPal client secret                                                               |
| MAILGUN_USER                                  | .mailgun.user                                      | Mailgun user                                                                       |
| MAILGUN_PASSWORD                              | .mailgun.password                                  | Mailgun password                                                                   |
| MAILGUN_API_KEY                               | .mailgun.apiKey                                    | Mailgun API key                                                                    |
| API_URL                                       | .host.api                                          | API exposed url                                                                    |
| IMAGES_URL                                    | .host.images                                       | Images URL                                                                         |
| FRONTEND_URL                                  | .host.frontend                                     | URL of the frontend service                                                        |
| WEBSITE_URL                                   | .host.website                                      | Website URL                                                                        |
| PDF_SERVICE_URL                               | .host.pdf                                          | PDF service URL                                                                    |
| REST_URL                                      | .host.rest                                         | REST service URL                                                                   |
| ORDERS_LIMIT_ACCOUNT                          | .limits.ordersPerHour.perAccount                   | Orders limit per account                                                           |
| ORDERS_LIMIT_ACCOUNT_COLLECTIVE               | .limits.ordersPerHour.perAccountForCollective      | Orders limit per account for collective                                            |
| ORDERS_LIMIT_EMAIL                            | .limits.ordersPerHour.perEmail                     | Orders limit per email                                                             |
| ORDERS_LIMIT_EMAIL_COLLECTIVE                 | .limits.ordersPerHour.perEmailForCollective        | Orders limit per email for collective                                              |
| ORDERS_LIMIT_IP                               | .limits.ordersPerHour.perIp                        | Orders limit per IP                                                                |
| ORDERS_LIMIT_MASK                             | .limits.ordersPerHour.perMask                      | Orders limit per mask                                                              |
| ORDERS_LIMIT_COLLECTIVE                       | .limits.ordersPerHour.forCollective                | Orders limit for collective                                                        |
| ORDERS_LIMIT_SKIP_CLEAN_SLUGS                 | .limits.skipCleanOrdersLimitSlugs                  | Skip clean orders limit slugs                                                      |
| ORDERS_LIMIT_ENABLED_MASKS                    | .limits.enabledMasks                               | Enabled masks for orders limit                                                     |
| SLACK_WEBHOOK_ABUSE                           | .slack.webhooks.abuse                              | Slack abuse webhook URL                                                            |
| GITHUB_CLIENT_ID                              | .github.clientID                                   | GitHub client ID                                                                   |
| GITHUB_CLIENT_SECRET                          | .github.clientSecret                               | GitHub client secret                                                               |
| TWITTER_CONSUMER_KEY                          | .twitter.consumerKey                               | Twitter consumer key                                                               |
| TWITTER_CONSUMER_SECRET                       | .twitter.consumerSecret                            | Twitter consumer secret                                                            |
| TWITTER_DISABLE                               | .twitter.disable                                   | Disable Twitter integration                                                        |
| FIXER_ACCESS_KEY                              | .fixer.accessKey                                   | Fixer access key                                                                   |
| FIXER_DISABLE_MOCK                            | .fixer.disableMock                                 | Disable Fixer mock                                                                 |
| CAPTCHA_ENABLE                                | .captcha.enabled                                   | Enable CAPTCHA                                                                     |
| RECAPTCHA_SITE_KEY                            | .recaptcha.siteKey                                 | reCAPTCHA site key                                                                 |
| RECAPTCHA_SECRET_KEY                          | .recaptcha.secretKey                               | reCAPTCHA secret key                                                               |
| HCAPTCHA_SECRET                               | .hcaptcha.secret                                   | hCaptcha secret                                                                    |
| HCAPTCHA_SITEKEY                              | .hcaptcha.sitekey                                  | hCaptcha site key                                                                  |
| TURNSTILE_SECRET                              | .turnstile.secretKey                               | Turnstile secret key                                                               |
| TAX_FORMS_ENCRYPTION_KEY                      | .taxForms.encryptionKey                            | Base64 encoded secret key for encrypting document before storage                   |
| TAX_FORMS_AWS_S3_BUCKET                       | .taxForms.aws.s3.bucket                            | The bucket where tax forms will be uploaded                                        |
| GITHUB_FLOW_MIN_NB_STARS                      | .githubFlow.minNbStars                             | Minimum number of Github stars required to apply to the open source collective     |
| TRANSFERWISE_API_URL                          | .transferwise.apiUrl                               | TransferWise API URL                                                               |
| TRANSFERWISE_OAUTH_URL                        | .transferwise.oauthUrl                             | TransferWise OAuth URL                                                             |
| TRANSFERWISE_CLIENT_KEY                       | .transferwise.clientKey                            | TransferWise client key                                                            |
| TRANSFERWISE_CLIENT_ID                        | .transferwise.clientId                             | TransferWise client ID                                                             |
| TRANSFERWISE_CLIENT_SECRET                    | .transferwise.clientSecret                         | TransferWise client secret                                                         |
| TRANSFERWISE_REDIRECT_URI                     | .transferwise.redirectUri                          | TransferWise redirect URI                                                          |
| TRANSFERWISE_PRIVATE_KEY                      | .transferwise.privateKey                           | TransferWise private key                                                           |
| TRANSFERWISE_BLOCKED_COUNTRIES                | .transferwise.blockedCountries                     | TransferWise blocked countries                                                     |
| TRANSFERWISE_BLOCKED_CURRENCIES               | .transferwise.blockedCurrencies                    | TransferWise blocked currencies                                                    |
| TRANSFERWISE_BLOCKED_CURRENCIES_BUSINESS      | .transferwise.blockedCurrenciesForBusinessProfiles | TransferWise blocked currencies for business profiles                              |
| TRANSFERWISE_BLOCKED_CURRENCIES_NONPROFIT     | .transferwise.blockedCurrenciesForNonProfits       | TransferWise blocked currencies for non-profits                                    |
| TRANSFERWISE_USE_TRANSFER_REFUND_HANDLER      | .transferwise.useTransferRefundHandler             | Use TransferWise transfer refund handler                                           |
| HYPERWATCH_ENABLED                            | .hyperwatch.enabled                                | Enable Hyperwatch                                                                  |
| HYPERWATCH_PATH                               | .hyperwatch.path                                   | Hyperwatch path                                                                    |
| HYPERWATCH_REALM                              | .hyperwatch.realm                                  | Hyperwatch realm                                                                   |
| HYPERWATCH_USERNAME                           | .hyperwatch.username                               | Hyperwatch username                                                                |
| HYPERWATCH_SECRET                             | .hyperwatch.secret                                 | Hyperwatch secret                                                                  |
| DB_ENCRYPTION_SECRET_KEY                      | .dbEncryption.secretKey                            | Database encryption secret key                                                     |
| DB_ENCRYPTION_CIPHER                          | .dbEncryption.cipher                               | Database encryption cipher                                                         |
| FETCH_TRANSACTIONS_RECEIPTS                   | .pdfService.fetchTransactionsReceipts              | Fetch transactions receipts                                                        |
| FETCH_COLLECTIVE_TRANSACTIONS_CSV             | .restService.fetchCollectiveTransactionsCsv        | Fetch collective transactions CSV                                                  |
| FETCH_HOST_TRANSACTIONS_CSV                   | .restService.fetchHostTransactionsCsv              | Fetch host transactions CSV                                                        |
| SENTRY_DSN                                    | .sentry.dsn                                        | Sentry DSN                                                                         |
| SENTRY_TRACES_SAMPLE_RATE                     | .sentry.tracesSampleRate                           | Percentage of collected transactions to send to Sentry                             |
| SENTRY_PROFILES_SAMPLE_RATE                   | .sentry.profilesSampleRate                         | Sentry profiles sample rate                                                        |
| SENTRY_MIN_EXECUTION_TIME_TO_SAMPLE           | .sentry.minExecutionTimeToSample                   | Minimum execution time to sample for Sentry                                        |
| LEDGER_FAST_BALANCE                           | .ledger.fastBalance                                | Enable fast balance for ledger                                                     |
| LEDGER_SEPARATE_PAYMENT_PROCESSOR_FEES        | .ledger.separatePaymentProcessorFees               | Separate payment processor fees in ledger                                          |
| LEDGER_SEPARATE_TAXES                         | .ledger.separateTaxes                              | Separate taxes in ledger                                                           |
| LEDGER_ORDERED_TRANSACTIONS                   | .ledger.orderedTransactions                        | Ordered transactions in ledger                                                     |
| TIMELINE_DAYS_CACHED                          | .timeline.daysCached                               | Number of days cached in timeline                                                  |
| TIMELINE_DISABLED                             | .timeline.disabled                                 | Disable timeline                                                                   |
| SKIP_TRANSACTION_ACTIVITIES                   | .activities.skipTransactions                       | Skip transaction activities                                                        |
| LEGACY_TRANSACTIONS_ACTIVITY_COLLECTIVE_IDS   | .activities.legacyTransactionsCollectiveIds        | List of collective ids for which to generate legacy transaction.created activities |
| TWO_FACTOR_AUTHENTICATION_ENABLED             | .twoFactorAuthentication.enabled                   | Enable two-factor authentication                                                   |
| FRAUD_ORDER_USER                              | .fraud.order.user                                  | Fraud order user settings                                                          |
| FRAUD_ORDER_CARD                              | .fraud.order.card                                  | Fraud order card settings                                                          |
| FRAUD_ORDER_EMAIL                             | .fraud.order.email                                 | Fraud order email settings                                                         |
| FRAUD_ORDER_IP                                | .fraud.order.ip                                    | Fraud order IP settings                                                            |
| FRAUD_PROTECTION_SUSPEND_ASSET                | .fraud.enforceSuspendedAsset                       | Enforce suspended asset for fraud protection                                       |
| GITBOOK_API_KEY                               | .gitbook.apiKey                                    | GitBook API key                                                                    |
| OPENTELEMETRY_ENABLED                         | .opentelemetry.enabled                             | Enable OpenTelemetry                                                               |
| STATSD_ENABLED                                | .statsd.enabled                                    | Enable StatsD                                                                      |
| STATSD_URL                                    | .statsd.url                                        | StatsD URL                                                                         |
| STATSD_PORT                                   | .statsd.port                                       | StatsD port                                                                        |
| STATSD_PREFIX                                 | .statsd.prefix                                     | StatsD prefix                                                                      |
| FEATURES_DASHBOARD_REDIRECT                   | .features.dashboard.redirect                       | Dashboard redirect feature                                                         |
| SETTLEMENT_MINIMUM_AMOUNT_IN_USD              | .settlement.minimumAmountInUSD                     | Minimum settlement amount in USD                                                   |
