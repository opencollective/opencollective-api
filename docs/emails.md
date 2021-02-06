# Developing with Emails

## Receiving Emails

- By default, [MailDev](https://github.com/maildev/maildev) is configured in development environment
- Open `http://localhost:1080` to browse outgoing emails

## Email Templates

Email templates can be viewed locally by running `npm run compile:email <template name>` and making sure there is data for that template in `scripts/compile-email.js`.
