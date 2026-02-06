/**
 * Script to show all tax information for a given collective (by slug).
 * Lists all tax forms ordered by date, with service/type/year and raw decrypted data.
 *
 * Usage: npm run script scripts/tax-forms/show-collective-tax-forms.ts <collective-slug> [--json]
 */

import '../../server/env';

import { Command } from 'commander';
import { cloneDeep } from 'lodash';

import logger from '../../server/lib/logger';
import models from '../../server/models';
import LegalDocument from '../../server/models/LegalDocument';

const parseCommandLine = () => {
  const program = new Command();
  program.showSuggestionAfterError();
  program.arguments('<collective-slug>');
  program.option('--json', 'Output as JSON instead of pretty-printed text');
  program.parse();
  return { collectiveSlug: program.args[0], options: program.opts() };
};

const getRawDecryptedData = (doc: LegalDocument): Record<string, unknown> | null => {
  const data = cloneDeep(doc.data);
  if (data?.encryptedFormData) {
    try {
      const decrypted = LegalDocument.decrypt(Buffer.from(data.encryptedFormData, 'base64')).toString();
      data.decryptedFormData = JSON.parse(decrypted) as Record<string, unknown>;
    } catch (err) {
      data._decryptError = String(err);
    }
  }

  return data as Record<string, unknown>;
};

const main = async () => {
  const { collectiveSlug, options } = parseCommandLine();
  if (!collectiveSlug) {
    logger.error('Usage: npm run script scripts/tax-forms/show-collective-tax-forms.ts <collective-slug> [--json]');
    process.exit(1);
  }

  const collective = await models.Collective.findBySlug(collectiveSlug);
  if (!collective) {
    logger.error(`Collective not found: ${collectiveSlug}`);
    process.exit(1);
  }

  const documents = await models.LegalDocument.findAll({
    where: {
      CollectiveId: collective.id,
      documentType: 'US_TAX_FORM',
    },
    order: [['createdAt', 'ASC']],
  });

  if (documents.length === 0) {
    logger.info(`No tax forms found for collective "${collectiveSlug}" (${collective.name}, id: ${collective.id}).`);
    return;
  }

  const result = documents.map(doc => {
    const rawData = getRawDecryptedData(doc);
    const formType = rawData?.formType ?? null;
    return {
      id: doc.id,
      year: doc.year,
      documentType: doc.documentType,
      service: doc.service,
      requestStatus: doc.requestStatus,
      formType,
      createdAt: doc.createdAt?.toISOString?.() ?? doc.createdAt,
      documentLink: doc.documentLink || null,
      rawDecryptedData: rawData,
    };
  });

  if (options.json) {
    logger.info(JSON.stringify(result, null, 2));
    return;
  }

  logger.info(`Tax forms for "${collectiveSlug}" (${collective.name}, id: ${collective.id})\n`);
  logger.info(`Total: ${documents.length} form(s), ordered by date.\n`);

  for (const item of result) {
    logger.info('─'.repeat(60));
    logger.info(`ID: ${item.id}`);
    logger.info(`  Service: ${item.service}`);
    logger.info(`  Document type: ${item.documentType}`);
    logger.info(`  Form type: ${item.formType ?? '(not in data)'}`);
    logger.info(`  Year: ${item.year}`);
    logger.info(`  Status: ${item.requestStatus}`);
    logger.info(`  Created: ${item.createdAt}`);
    if (item.documentLink) {
      logger.info(`  Document link: ${item.documentLink}`);
    }
    logger.info('  Raw decrypted data:');
    logger.info(JSON.stringify(item.rawDecryptedData, null, 4));
    logger.info('');
  }
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(e => {
      logger.error(e);
      process.exit(1);
    });
}
