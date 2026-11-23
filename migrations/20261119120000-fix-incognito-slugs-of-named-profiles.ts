'use strict';

import slugify from 'limax';
import { chunk, trim } from 'lodash';
import { type QueryInterface, QueryTypes } from 'sequelize';
import { v4 as uuid } from 'uuid';

import { isCollectiveSlugReserved } from '../server/constants/collective-slugs';

/**
 * Profiles created by `/users/signup` have no name at creation: they are named "incognito" and get an
 * `incognito-…` slug. Until `editAccount` learned to regenerate it, the slug stayed after the user set
 * their name, so regular (non-incognito) profiles kept `incognito-…` as their profile URL.
 *
 * For every individual profile that is not incognito, has an `incognito-…` slug and a real name, the slug is
 * derived from the name, like `Collective.generateSlug` does (random suffix when the slug is taken).
 * Left alone: profiles with a placeholder name ("incognito", "Guest"), since there is nothing to derive a
 * slug from, and names that give no usable slug (empty, reserved keyword).
 *
 * Old and new slugs are recorded in `MigrationLogs`; `down` restores the slugs nothing else changed since.
 */

const MIGRATION_NAME = '20261119120000-fix-incognito-slugs-of-named-profiles';

const PLACEHOLDER_NAMES = ['incognito', 'guest', 'anonymous'];

type Profile = { id: number; name: string; slug: string };

type MigrationData = { updated: Array<{ id: number; from: string; to: string }> };

const getRandomHash = () => uuid().split('-')[0];

/** Same rules as the `slug` validation of the Collective model */
const isValidSlug = (slug: string) =>
  Boolean(slug) &&
  slug.length <= 255 &&
  /^[\w-]+$/.test(slug) &&
  trim(slug, '-') === slug &&
  slug === slug.toLowerCase() &&
  !isCollectiveSlugReserved(slug);

module.exports = {
  async up(queryInterface: QueryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async transaction => {
      const profiles = await sequelize.query<Profile>(
        `
        SELECT id, name, slug
        FROM "Collectives"
        WHERE type = 'USER'
          AND "isIncognito" IS FALSE
          AND "deletedAt" IS NULL
          AND slug LIKE 'incognito-%'
          AND name IS NOT NULL
          AND LOWER(TRIM(name)) NOT IN (:placeholderNames)
        ORDER BY id
        FOR UPDATE
      `,
        { type: QueryTypes.SELECT, replacements: { placeholderNames: PLACEHOLDER_NAMES }, transaction },
      );

      const candidates = profiles
        .map(profile => ({ ...profile, baseSlug: slugify(profile.name) as string }))
        .filter(({ baseSlug }) => isValidSlug(baseSlug) && !baseSlug.startsWith('incognito'));

      // Slugs already in use, deleted accounts included (the unique index covers them)
      const takenSlugs = new Set<string>();
      for (const slugs of chunk([...new Set(candidates.map(c => c.baseSlug))], 5000)) {
        const rows = await sequelize.query<{ slug: string }>(`SELECT slug FROM "Collectives" WHERE slug IN (:slugs)`, {
          type: QueryTypes.SELECT,
          replacements: { slugs },
          transaction,
        });
        rows.forEach(row => takenSlugs.add(row.slug));
      }

      const updated: MigrationData['updated'] = [];
      for (const { id, slug, baseSlug } of candidates) {
        const newSlug = takenSlugs.has(baseSlug) ? `${baseSlug}-${getRandomHash()}` : baseSlug;
        if (isValidSlug(newSlug)) {
          takenSlugs.add(newSlug);
          updated.push({ id, from: slug, to: newSlug });
        }
      }

      for (const rows of chunk(updated, 1000)) {
        await sequelize.query(
          `
          UPDATE "Collectives" c
          SET slug = v.slug
          FROM (SELECT UNNEST(ARRAY[:ids]::int[]) AS id, UNNEST(ARRAY[:slugs]::text[]) AS slug) v
          WHERE c.id = v.id
        `,
          { replacements: { ids: rows.map(row => row.id), slugs: rows.map(row => row.to) }, transaction },
        );
      }

      const data: MigrationData = { updated };
      await sequelize.query(
        `
        INSERT INTO "MigrationLogs" ("type", "createdAt", "description", "data")
        VALUES ('MIGRATION', NOW(), :description, :data)
      `,
        { replacements: { description: MIGRATION_NAME, data: JSON.stringify(data) }, transaction },
      );
    });
  },

  /** Restores the previous slugs, skipping the profiles whose slug was changed since */
  async down(queryInterface: QueryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async transaction => {
      const [migrationLog] = await sequelize.query<{ id: number; data: MigrationData }>(
        `SELECT id, data FROM "MigrationLogs" WHERE type = 'MIGRATION' AND description = :description ORDER BY id DESC LIMIT 1`,
        { type: QueryTypes.SELECT, replacements: { description: MIGRATION_NAME }, transaction },
      );

      if (!migrationLog) {
        return;
      }

      for (const rows of chunk(migrationLog.data.updated, 1000)) {
        await sequelize.query(
          `
          UPDATE "Collectives" c
          SET slug = v.previous_slug
          FROM (
            SELECT
              UNNEST(ARRAY[:ids]::int[]) AS id,
              UNNEST(ARRAY[:previousSlugs]::text[]) AS previous_slug,
              UNNEST(ARRAY[:slugs]::text[]) AS slug
          ) v
          WHERE c.id = v.id AND c.slug = v.slug
        `,
          {
            replacements: {
              ids: rows.map(row => row.id),
              previousSlugs: rows.map(row => row.from),
              slugs: rows.map(row => row.to),
            },
            transaction,
          },
        );
      }

      await sequelize.query(`DELETE FROM "MigrationLogs" WHERE id = :id`, {
        replacements: { id: migrationLog.id },
        transaction,
      });
    });
  },
};
