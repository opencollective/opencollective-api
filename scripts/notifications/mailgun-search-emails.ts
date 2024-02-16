#!/usr/bin/env ./node_modules/.bin/babel-node

import '../../server/env';

import fs from 'fs';
import path from 'path';

import { Command } from 'commander';
import slug from 'limax';
import moment from 'moment';

const DATE_RFC2822 = 'ddd, DD MMM YYYY HH:mm:ss ZZ';
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
if (!MAILGUN_API_KEY) {
  throw new Error('MAILGUN_API_KEY is not set');
}

const main = async () => {
  const program = new Command();
  program.option('-s, --subject <subject>', 'Subject of the email');
  program.option('-r, --to <to>', 'To email');
  program.option('--from-date <fromDate>', 'From date (default: 1 week ago)');
  program.option('--to-date <toDate>', 'To date (default: now)');
  program.option('--limit <limit>', 'Limit of emails to fetch (default: 5)', '5');
  program.option('--write <output>', 'Output directory');
  program.parse();

  const options = program.opts();
  const url = new URL(`https://api.mailgun.net/v3/opencollective.com/events`);
  url.searchParams.append('event', 'delivered');
  url.searchParams.append('limit', options.limit);
  url.searchParams.append('ascending', 'no');
  if (options.fromDate) {
    const date = moment(options.fromDate);
    url.searchParams.append('begin', date.format(DATE_RFC2822));
    if (moment().diff(date, 'days') > 30) {
      console.warn('Warning: Mailgun logs retention is 30 days. You may not be able to fetch logs older than that.');
    }
  }
  if (options.toDate) {
    url.searchParams.append('end', moment(options.toDate).format(DATE_RFC2822));
  }
  if (options.to) {
    url.searchParams.append('recipient', options.to);
  }
  if (options.subject) {
    url.searchParams.append('subject', options.subject);
  }

  const authorization = `Basic ${Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64')}`;
  const headers = { Authorization: authorization };
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch emails: ${response.status} ${response.statusText}.\n${JSON.stringify(await response.json())}`,
    );
  }

  const body = await response.json();
  if (body.items.length === 0) {
    console.log('No emails found');
    return;
  }

  for (const item of body.items) {
    const date = new Date(item.timestamp);
    const subject = item.message.headers.subject;
    console.log(`[${date.toISOString()}] <${item.recipient}>: ${subject}`);

    // Generate HTML file
    if (options.write) {
      const storageKey = item.storage.key;
      const emailUrl = `https://api.mailgun.net/v3/domains/opencollective.com/messages/${storageKey}`;
      const emailResponse = await fetch(emailUrl, { headers });
      if (!emailResponse.ok) {
        console.error(`Failed to fetch email: ${emailResponse.status} ${emailResponse.statusText}`);
        continue;
      }

      const data = await emailResponse.json();
      const filename = `./email-${item.timestamp}-${item.recipient}-${slug(subject)}.html`;
      const outPath = path.join(options.write, filename);
      fs.writeFileSync(outPath, data['body-html']);
    }
  }
};

main()
  .then(() => {
    console.log('Done');
    process.exit();
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
