/**
 * A script to seed HelloWorks IDs for existing tax forms.
 * Pre-2022, or more precisely before https://github.com/opencollective/opencollective-api/pull/6907,
 * we were not storing the HelloWorks instance ID in the database. This script aims to fix that
 * as best as possible, by looking at HelloWorks CSV exports and trying to match them with existing
 * `LegalDocument`s in the database.
 *
 * The CSV can be downloaded with the script below (look at Dropbox Forms for the exact curl command):
 *
 * ```bash
 * start_date="2019-01-01T00:00:00.000Z"
 * end_date="2019-05-01T23:59:59.000Z"
 * end_loop_date="2023-01-01T00:00:00.000Z"
 * interval="4 months"
 * workflows="&guid[]=MfmOZErmhz1qPgMp&guid[]=qdUbX5nw8sMZzykz&guid[]=MkFBvG39RIA61OnD"
 *
 * # Download
 * while [[ "$start_date" < "$end_loop_date" ]]; do
 *   # Calculate the end date for this period
 *   period_end_date=$(date -d "$start_date + $interval" "+%Y-%m-%dT%H:%M:%S.000Z")
 *
 *   # Call the curl command with the current date range
 *   # curl "http://my-url.com?start_date=$start_date&end_date=$period_end_date"
 *   curl --output result-$start_date-$period_end_date.zip "https://portal.helloworks.com/workflow/transactions/detail/?mode=live&$worflows&start_date=$start_date&end_date=$period_end_date"
 *
 *   # Update the start date for the next period
 *   start_date=$(date -d "$period_end_date + 1 second" "+%Y-%m-%dT%H:%M:%S.000Z")
 * done
 *
 * # Extract all CSV files from the zip files
 * for f in *.zip; do unzip -B -j "$f" "*.csv"; done
 *
 * # Merge all CSV files into one
 * csvstack Open*.csv* >all.csv
 * ```
 *
 */

import '../../server/env';

import fs from 'fs';

import Commander from 'commander';
import { parse } from 'csv-parse/sync'; // eslint-disable-line

import { fetchHelloWorksInstance, HelloWorksTaxFormInstance } from '../../server/controllers/helloworks';
import models, { sequelize } from '../../server/models';

const parseCommandLine = () => {
  const program = new Commander.Command();
  program.requiredOption('-i, --input <path>', 'Path to the CSV file exported from HelloWorks');
  program.option('--offset <number>', 'Number of rows to skip', parseInt);
  program.option('--email <email>', 'Email of the user to look for');
  program.parse(process.argv);
  return program.opts();
};

const getDocumentForYear = (documents, year, identifier) => {
  if (year && documents.find(d => d.year === year)) {
    if (documents.filter(d => d.year === year).length !== 1) {
      console.log(
        `Multiple documents found for ${identifier} at year ${year} (${documents
          .map(d => d.year)
          .join(', ')}). Skipping...`,
      );
    } else {
      return documents.find(d => d.year === year);
    }
  }
};

const getYearFromMetadata = metadata => {
  if (!metadata) {
    return null;
  }
  if (metadata.year) {
    return parseInt(metadata.year);
  }

  const yearKey = Object.keys(metadata).find(key => typeof key === 'string' && key.startsWith('year,'));
  if (yearKey) {
    return parseInt(yearKey.split(',')[1]);
  }
};

const getTaxFormForCollective = async (collectiveId, getInstance) => {
  const documents = await models.LegalDocument.findAll({
    where: { CollectiveId: collectiveId, documentType: 'US_TAX_FORM' },
    order: [['year', 'DESC']],
  });

  if (documents.length === 0) {
    console.log(`No documents found for ${collectiveId}`);
  } else if (documents.length === 1) {
    return documents[0];
  } else if (documents.length > 1) {
    // If there's 1 document per year, we can try and match on the best one
    const instance = await getInstance();
    const year = getYearFromMetadata(instance.metadata);

    if (!year && instance.status === 'completed') {
      return documents.find(d => !d.data?.helloWorks?.instance?.id) || documents[0];
    } else if (year && documents.find(d => d.year === year)) {
      return getDocumentForYear(documents, year, collectiveId);
    } else {
      console.log(
        `Multiple documents found for ${collectiveId} (${documents.map(d => d.year).join(', ')}). None for ${year}`,
      );
    }
  }
};

const isCorruptedMetadata = metadata => {
  return Boolean(metadata && Object.keys(metadata).some(key => typeof key === 'string' && key.startsWith('userId,')));
};

const getTaxFormForInstanceWithCorruptedMetadata = async (instance: HelloWorksTaxFormInstance) => {
  const userKey = Object.keys(instance.metadata).find(key => typeof key === 'string' && key.startsWith('userId,'));
  const userId = parseInt(userKey?.split(',')[1]);
  const user = await models.User.findByPk(userId);
  if (user) {
    return getTaxFormForCollective(user.CollectiveId, () => Promise.resolve(instance));
  } else {
    console.log(`No user found for ${instance.id} (${userKey})`);
  }
};

const findDocumentForEmail = async (email, getInstance) => {
  let user = await models.User.findOne({ where: { email }, paranoid: false });
  if (user) {
    return getTaxFormForCollective(user.CollectiveId, getInstance);
  } else {
    // Users may have changed their emails, look in the histories table
    const result = await sequelize.query(`SELECT DISTINCT "id" FROM "UserHistories" WHERE email = :email`, {
      type: sequelize.QueryTypes.SELECT,
      replacements: { email },
    });

    if (result.length === 1) {
      user = await models.User.findByPk(result[0].id, { paranoid: false });
      if (user) {
        return getTaxFormForCollective(user.CollectiveId, getInstance);
      }
    }
  }
};

const findLegalDocument = async (instanceId, { email, slug }) => {
  // Try to find by instance ID
  let ld = await models.LegalDocument.findOne({ where: { data: { helloWorks: { instance: { id: instanceId } } } } });
  let fullInstance: HelloWorksTaxFormInstance;
  const getInstance = async () => {
    if (!fullInstance) {
      fullInstance = await fetchHelloWorksInstance(instanceId);
    }
    return fullInstance;
  };

  // Fallback on account slug if available
  if (!ld && slug) {
    const documents = await models.LegalDocument.findAll({
      include: [{ association: 'collective', where: { slug }, attributes: [], paranoid: false }],
    });

    if (documents.length > 1) {
      const instance = await getInstance();
      ld = getDocumentForYear(documents, parseInt(instance.metadata?.year), slug);
    } else {
      ld = documents[0];
    }
  }

  // Fallback on email
  if (!ld && email) {
    ld = await findDocumentForEmail(email, getInstance);
  }

  // Use the instance to find the legal document
  if (!ld && instanceId) {
    const instance = await getInstance();
    if (!instance) {
      console.log('No metadata for', instanceId);
    } else {
      const collectiveId = instance.metadata?.accountId;
      if (collectiveId) {
        ld = await getTaxFormForCollective(collectiveId, getInstance);
      } else if (isCorruptedMetadata(instance.metadata)) {
        ld = await getTaxFormForInstanceWithCorruptedMetadata(instance);
      } else if (instance.metadata?.userId) {
        const user = await models.User.findByPk(instance.metadata.userId);
        if (user) {
          ld = await getTaxFormForCollective(user.CollectiveId, getInstance);
        }
      } else if (instance.metadata?.email) {
        ld = await findDocumentForEmail(instance.metadata.email, getInstance);
      } else {
        console.log('No account ID for', instance.id);
      }
    }
  }

  return ld;
};

const main = async () => {
  const options = parseCommandLine();
  const rawContent = fs.readFileSync(options.input, 'utf8');
  const parsedCsv = parse(rawContent, { delimiter: ',', columns: true });

  for (const [index, row] of parsedCsv.entries()) {
    if (options.offset && index < options.offset) {
      continue;
    } else if (index % 50 === 0) {
      console.log(`Processed ${index}/${parsedCsv.length}`);
    }

    const instanceId = row['Instance ID'];
    const email = (row['Participant - Authentication'] || row['Your Email'] || '').toLowerCase();
    let name = row['Name'] || row['Name of Beneficial Owner'] || row['Signer name'] || row['Business name'];
    let slug;
    if (options.email && email !== options.email) {
      continue;
    }

    // Extract slug from format "carolyn-ephraim (Cosmos Ray)"
    if (row['Participant - Name']) {
      const slugRegex = /(?<slug>[a-z0-9-]+) (\((?<name>.+)\))/i;
      const match = row['Participant - Name'].match(slugRegex);
      if (match) {
        slug = match.groups.slug;
        name = match.groups.name || name;
      }
    }

    // All entries must have an instance ID
    if (!instanceId) {
      console.log(`No instance ID found for ${email} - ${name} - ${slug}`);
      continue;
    }

    // Try to find the legal document and update it
    const ld = await findLegalDocument(instanceId, { email, slug });
    if (!ld) {
      console.log(`No legal document found for ${instanceId} (${email} - ${name} - ${slug})`);
    } else if (!ld.data?.helloWorks?.instance?.id) {
      console.log(`Updating ${instanceId} (${email} - ${name} - ${slug})`);
      await ld.update({ data: { ...ld.data, helloWorks: { instance: { id: instanceId } } } });
    } else if (ld.data.helloWorks.instance.id !== instanceId) {
      console.log(
        `Another instance ID found for ${instanceId} (${email} - ${name} - ${slug}): ${ld.data.helloWorks?.instance.id}`,
      );
    }
  }
};

main()
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
