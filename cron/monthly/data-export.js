#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env';

import fs from 'fs';
import readline from 'readline';

import Promise from 'bluebird';
import config, { googleDrive } from 'config';
import { google } from 'googleapis';
import { parse as json2csv } from 'json2csv';
import moment from 'moment';

import models, { sequelize } from '../../server/models';

const GoogleDrivePath = process.env.OC_GOOGLE_DRIVE || '/tmp';

if (!fs.existsSync(GoogleDrivePath)) {
  console.error('error');
  console.log(`Please make sure the Open Collective Drive is synchronized locally to ${GoogleDrivePath}.`);
  console.log('You can override the default location with the env variable OC_GOOGLE_DRIVE');
  process.exit(0);
}

const queries = [
  {
    filename: 'TopCollectivesByNewBackers.csv',
    query: `
    SELECT max(c.slug) as collective, max(c."createdAt") as "createdAt", count(*) as "totalNewBackers",
    max(c.website) as website, max(c."twitterHandle") as twitter, max(c.description) as description
    FROM "Members" m
    LEFT JOIN "Collectives" c ON m."CollectiveId" = c.id
    WHERE m."createdAt" > :startDate
      AND m."createdAt" < :endDate
      AND m.role='BACKER'
      AND m."deletedAt" IS NULL
    GROUP BY "CollectiveId"
    ORDER BY "totalNewBackers" DESC
    `,
  },
  {
    filename: 'TopNewCollectivesByDonations.csv',
    query: `
  SELECT sum(amount)::float / 100 as "totalAmount", max(t.currency) as currency, max(c.slug) as collective,
  max(c.website) as website, max(c."twitterHandle") as twitter, max(c.description) as description
  FROM "Transactions" t
  LEFT JOIN "Collectives" c ON c.id = t."CollectiveId"
  INNER JOIN "PaymentMethods" pm ON t."PaymentMethodId" = pm.id
  WHERE t."createdAt" > :startDate
    AND c."createdAt" > :startDate
    AND t."createdAt" < :endDate
    AND c."createdAt" < :endDate
    AND t.type='CREDIT'
    AND t."deletedAt" IS NULL
    AND NOT (pm."service" = 'opencollective' AND pm."type" = 'collective' AND t."HostCollectiveId" = t."FromCollectiveId") -- Ignore added funds
  GROUP BY t."CollectiveId"
  ORDER BY "totalAmount" DESC
  `,
  },
  {
    filename: 'Top100Backers.csv',
    query: `
  with res as (SELECT CONCAT('https://opencollective.com/', max(backer.slug)) as backer, sum(amount)::float / 100 as "amount",
  max(t.currency) as currency, string_agg(DISTINCT c.slug, ', ') AS "collectives supported", max(backer."twitterHandle") as twitter,
  max(backer.description) as description, max(backer.website) as website
  FROM "Transactions" t
  LEFT JOIN "Collectives" backer ON backer.id = t."FromCollectiveId"
  LEFT JOIN "Collectives" c ON c.id = t."CollectiveId"
  INNER JOIN "PaymentMethods" pm ON t."PaymentMethodId" = pm.id
  WHERE t."createdAt" > :startDate
    AND t."createdAt" < :endDate
    AND t.type='CREDIT'
    AND t."deletedAt" IS NULL
    AND NOT (pm."service" = 'opencollective' AND pm."type" = 'collective' AND t."HostCollectiveId" = t."FromCollectiveId") -- Ignore added funds
   GROUP BY t."FromCollectiveId"
   ORDER BY "amount" DESC)
   SELECT row_number() over(order by "amount" DESC) as "#", * from res LIMIT 100
   `,
  },
  {
    filename: 'transactions.csv',
    query: `
    SELECT
    t."createdAt", c.slug as "collective slug", t.type as "transaction type", t.amount::float / 100,
    t.currency, fc.slug as "from slug", fc.type as "from type", t.description, e.tags as "expense tags",
    h.slug as "host slug", t."hostCurrency", t."hostCurrencyFxRate",
    pm.service as "payment processor", pm.type as "payment method type",
    t."paymentProcessorFeeInHostCurrency"::float / 100 as "paymentProcessorFeeInHostCurrency",
    t."hostFeeInHostCurrency"::float / 100 as "hostFeeInHostCurrency",
    t."platformFeeInHostCurrency"::float / 100 as "platformFeeInHostCurrency"
    FROM "Transactions" t
    LEFT JOIN "Collectives" fc ON fc.id=t."FromCollectiveId"
    LEFT JOIN "Collectives" c ON c.id=t."CollectiveId"
    LEFT JOIN "Collectives" h ON h.id=t."HostCollectiveId"
    LEFT JOIN "PaymentMethods" pm ON pm.id=t."PaymentMethodId"
    LEFT JOIN "Expenses" e ON e.id=t."ExpenseId"
    WHERE t."createdAt" >= :startDate AND t."createdAt" < :endDate
      AND t."deletedAt" IS NULL
    ORDER BY t.id ASC
      `,
  },
];

const d = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();
d.setMonth(d.getMonth() - 1);

const startDate = new Date(d.getFullYear(), d.getMonth(), 1);
const endDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);

console.log('startDate', startDate, 'endDate', endDate);
let month = startDate.getMonth() + 1;
if (month < 10) {
  month = `0${month}`;
}

const path = `${GoogleDrivePath}/${startDate.getFullYear()}-${month}`;
try {
  console.log('>>> mkdir', path);
  fs.mkdirSync(path);
} catch (e) {
  console.log('>>> path already exists');
}

async function run() {
  const lastTransaction = await models.Transaction.findOne({ order: [['id', 'DESC']] });
  if (new Date(lastTransaction.createdAt) < endDate) {
    console.log('The last transaction date must be newer that endDate');
    console.log('Make sure you have a recent data dump of the database locally.');
    console.log(`Last transaction date in ${process.env.PG_DATABASE}: ${lastTransaction.createdAt}`);
    process.exit(0);
  }

  await Promise.map(queries, async query => {
    const res = await sequelize.query(query.query, {
      type: sequelize.QueryTypes.SELECT,
      replacements: { startDate, endDate },
    });

    const data = res.map(row => {
      if (row.createdAt) {
        row.createdAt = moment(row.createdAt).format('YYYY-MM-DD HH:mm');
      }
      Object.keys(row).map(key => {
        if (row[key] === null) {
          row[key] = '';
        }
      });
      return row;
    });
    try {
      const csv = json2csv(data);
      fs.writeFileSync(`${path}/${query.filename}`, csv);
    } catch (err) {
      console.log(err);
    }
  });
  console.log('all files created');
}

// If modifying these scopes, you will need to regenerate the token.
const SCOPES = ['https://www.googleapis.com/auth/drive'];

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
const authorize = (googleDrive, callback) => {
  const { clientSecret, clientId, redirectUri, refresh_token } = googleDrive || {}; // eslint-disable-line camelcase
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // Check if we have previously stored a token.
  // eslint-disable-next-line camelcase
  if (refresh_token) {
    oAuth2Client.setCredentials(googleDrive);
    callback(oAuth2Client);
  } else if (process.env.NODE_ENV !== 'production' || process.env.MANUAL_RUN) {
    return getAccessToken(oAuth2Client, callback);
  } else {
    console.log('No token set for Google Drive, skipping data export upload');
    process.exit(0);
  }
};

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
const getAccessToken = (oAuth2Client, callback) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline', // eslint-disable-line camelcase
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', code => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) {
        return console.error('Error retrieving access token', err);
      } else {
        console.log(`>>> Token: ${JSON.stringify(token)}`);
      }

      oAuth2Client.setCredentials(token);
      callback(oAuth2Client);
    });
  });
};

/**
 * upload file to google drive
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
const uploadFiles = async auth => {
  const drive = google.drive({ version: 'v3', auth });

  // Create a folder on drive
  const folderMetadata = {
    name: `${startDate.getFullYear()}-${month}`,
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['1OwRpuIehFQxRnJIRAksQ1Jd2xXZrhz5L'],
  };
  const folder = await drive.files.create({
    resource: folderMetadata,
    fields: 'id',
  });

  await Promise.map(queries, async query => {
    const fileMetadata = {
      name: `${query.filename}`,
      parents: [`${folder.data.id}`],
    };
    const media = {
      mimeType: 'file/csv',
      body: fs.createReadStream(`${path}/${query.filename}`),
    };

    const res = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id',
    });
    console.log(`File: ${query.filename},\t Id: ${res.data.id}`);
  });
  console.log(`>>> all files uploaded to "${folderMetadata['name']}" folder in google drive`);

  // Delete all the files after succesful upload
  try {
    fs.rmdirSync(`${path}`, { recursive: true });
    console.log(`${path} is deleted!`);
  } catch (err) {
    console.error(`Error while deleting ${path}.`);
    console.error(err);
  }
  process.exit(0);
};

// Only run on the first of the month
const today = new Date();
if (config.env === 'production' && today.getDate() !== 1 && !process.env.MANUAL_RUN) {
  console.log('OC_ENV is production and today is not the first of month, script aborted!');
  process.exit();
} else {
  run()
    .then(() => {
      // If drive credentails are available try to upload generated files to drive
      if (googleDrive.clientId && googleDrive.clientSecret && googleDrive.redirectUri) {
        // Authorize with credentials, then call the Google Drive API.
        authorize(googleDrive, uploadFiles);
      } else {
        console.log(`>>> Required google drive credentails weren't provided.`);
        process.exit(0);
      }
    })
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
