# Developing with Emails

## Receving Emails

- Make sure you have [MailDev](https://danfarrelly.nyc/MailDev/) installed globally: `npm install -g maildev`
- Launch the API server with `MAILDEV=true npm run dev`
- In a separate terminal, launch [MailDev](https://danfarrelly.nyc/MailDev/) with `maildev`
- Open `http://localhost:1080` to browse outgoing emails

## Email Templates

Email templates can be viewed locally by running `npm run compile:email <template name>` and making sure there is data for that template in `scripts/compile-email.js`.
