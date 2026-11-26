/**
 * Re-sanitize Update HTML content using the current sanitizer rules.
 *
 * Usage:
 *   # Dry run (default) on all updates
 *   npm run script scripts/updates/update-html.ts
 *
 *   # Dry run on specific updates
 *   npm run script scripts/updates/update-html.ts -- --updateId 1,2,3
 *
 *   # Dry run on updates containing a string
 *   npm run script scripts/updates/update-html.ts -- --contains 'javascript:'
 *
 *   # Show full diff per changed update
 *   npm run script scripts/updates/update-html.ts -- --updateId 1 --verbose
 *
 *   # Apply changes
 *   npm run script scripts/updates/update-html.ts -- --updateId 1 --no-dry-run
 *
 *   # Process at most 50 updates
 *   npm run script scripts/updates/update-html.ts -- --limit 50
 */

import '../../server/env';

import { Command } from 'commander';
import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { generateSummaryForHTML, optsSanitizeUpdateHtml, sanitizeHTML } from '../../server/lib/sanitize-html';
import { sequelize } from '../../server/models';

const BATCH_SIZE = 100;

type UpdateRow = {
  id: number;
  html: string;
  summary: string;
};

export const parseCommaSeparatedInts = (value: string | undefined): number[] | undefined => {
  if (!value) {
    return undefined;
  }

  const ids = value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => parseInt(part, 10));

  if (ids.some(id => Number.isNaN(id))) {
    throw new Error(`Invalid update id in list: ${value}`);
  }

  return ids;
};

export const countChangedChars = (before: string, after: string): number => {
  if (before === after) {
    return 0;
  }

  const maxLength = Math.max(before.length, after.length);
  let changed = 0;

  for (let i = 0; i < maxLength; i++) {
    if (before[i] !== after[i]) {
      changed++;
    }
  }

  return changed;
};

const printLineDiff = (before: string, after: string): void => {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const maxLines = Math.max(beforeLines.length, afterLines.length);

  for (let i = 0; i < maxLines; i++) {
    const beforeLine = beforeLines[i];
    const afterLine = afterLines[i];

    if (beforeLine !== afterLine) {
      if (beforeLine !== undefined) {
        console.log(`- ${beforeLine}`);
      }
      if (afterLine !== undefined) {
        console.log(`+ ${afterLine}`);
      }
    }
  }
};

export const getSanitizedContent = (html: string): { html: string; summary: string } => {
  return {
    html: sanitizeHTML(html, optsSanitizeUpdateHtml),
    summary: generateSummaryForHTML(html, 240),
  };
};

const findUpdates = async ({
  updateIds,
  contains,
  lastId,
  limit,
}: {
  updateIds?: number[];
  contains?: string;
  lastId: number;
  limit: number;
}): Promise<UpdateRow[]> => {
  const conditions = ['"deletedAt" IS NULL'];
  const replacements: Record<string, unknown> = {};

  if (updateIds?.length) {
    conditions.push('id IN (:updateIds)');
    replacements.updateIds = updateIds;
  } else {
    conditions.push('id > :lastId');
    replacements.lastId = lastId;
  }

  if (contains) {
    conditions.push('html LIKE :contains');
    replacements.contains = `%${contains}%`;
  }

  const limitClause = `LIMIT ${limit}`;

  return sequelize.query<UpdateRow>(
    `SELECT id, html, summary FROM "Updates" WHERE ${conditions.join(' AND ')} ORDER BY id ASC ${limitClause}`,
    { replacements, type: QueryTypes.SELECT },
  );
};

const saveSanitizedContent = async (id: number, html: string, summary: string | null): Promise<void> => {
  await sequelize.query(
    `UPDATE "Updates" SET html = :html, summary = :summary, "updatedAt" = NOW() WHERE id = :id AND "deletedAt" IS NULL`,
    { replacements: { id, html, summary } },
  );
};

export const main = async (argv = process.argv): Promise<void> => {
  const program = new Command();
  program
    .option('--updateId <ids>', 'Comma-separated list of update IDs to process')
    .option('--contains <string>', 'Only process updates whose HTML contains this string')
    .option('--limit <n>', 'Maximum number of updates to process', parseInt)
    .option('--verbose', 'Show full diff for changed updates')
    .option('--no-dry-run', 'Apply changes (default is dry run)')
    .parse(argv);

  const options = program.opts();
  const dryRun = options.dryRun !== false;
  const updateIds = parseCommaSeparatedInts(options.updateId);
  const contains = options.contains as string | undefined;
  const verbose = Boolean(options.verbose);
  const maxToProcess = options.limit as number | undefined;

  if (maxToProcess !== undefined && (Number.isNaN(maxToProcess) || maxToProcess <= 0)) {
    throw new Error(`Invalid limit: ${options.limit}`);
  }

  if (dryRun) {
    logger.info('Running in dry run mode (use --no-dry-run to apply changes)');
  }

  let lastId = 0;
  let scanned = 0;
  let changed = 0;
  let saved = 0;
  let totalChangedChars = 0;

  while (true) {
    if (maxToProcess !== undefined && scanned >= maxToProcess) {
      break;
    }

    const batchLimit =
      maxToProcess !== undefined
        ? Math.min(BATCH_SIZE, maxToProcess - scanned)
        : updateIds?.length
          ? updateIds.length
          : BATCH_SIZE;

    const updates = await findUpdates({
      updateIds,
      contains,
      lastId,
      limit: batchLimit,
    });

    if (updates.length === 0) {
      break;
    }

    for (const update of updates) {
      if (maxToProcess !== undefined && scanned >= maxToProcess) {
        break;
      }

      scanned++;
      const currentHtml = update.html ?? '';
      const currentSummary = update.summary ?? '';
      const sanitized = getSanitizedContent(currentHtml);
      const htmlChanged = sanitized.html !== currentHtml;
      const summaryChanged = sanitized.summary !== currentSummary;

      if (!htmlChanged && !summaryChanged) {
        continue;
      }

      changed++;
      const htmlChangedChars = countChangedChars(currentHtml, sanitized.html);
      const summaryChangedChars = countChangedChars(currentSummary, sanitized.summary ?? '');
      totalChangedChars += htmlChangedChars + summaryChangedChars;

      if (verbose) {
        console.log(`\nUpdate #${update.id}`);
        if (htmlChanged) {
          console.log('HTML diff:');
          printLineDiff(currentHtml, sanitized.html);
        }
        if (summaryChanged) {
          console.log('Summary diff:');
          printLineDiff(currentSummary, sanitized.summary ?? '');
        }
      } else {
        const summarySuffix = summaryChanged ? `, summary changed ${summaryChangedChars} chars` : '';
        console.log(`Update #${update.id}: html changed ${htmlChangedChars} chars${summarySuffix}`);
      }

      if (!dryRun) {
        await saveSanitizedContent(update.id, sanitized.html, sanitized.summary);
        saved++;
      }
    }

    if (updateIds?.length || (maxToProcess !== undefined && scanned >= maxToProcess)) {
      break;
    }

    lastId = updates[updates.length - 1].id;
  }

  const savedSuffix = dryRun ? '' : `, ${saved} saved`;
  const changedCharsSuffix = changed ? `, ${totalChangedChars} total changed chars` : '';
  logger.info(`Done. Scanned ${scanned} update(s), ${changed} would change${savedSuffix}${changedCharsSuffix}`);
};

if (require.main === module) {
  main()
    .then(() => process.exit())
    .catch(error => {
      logger.error(error);
      console.error(error);
      process.exit(1);
    });
}
