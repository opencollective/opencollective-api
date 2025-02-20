/**
 * Converts an independent collective into a Host organization.
 */

import '../../server/env';

import { Command } from 'commander';

import { CollectiveType } from '../../server/constants/collectives';
import MemberRoles from '../../server/constants/roles';
import logger from '../../server/lib/logger';
import { Collective, Member, sequelize } from '../../server/models';
import { MemberModelInterface } from '../../server/models/Member';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const program = new Command();

program.argument('<slug>', 'The account slug to convert');
program.option('--projects-to-collectives', 'Convert projects to collectives');

export const main = async (slug: string, options: { isDryRun: boolean; projectsToCollectives: boolean }) => {
  const collective = await Collective.findOne({ where: { slug } });
  if (!collective) {
    throw new Error(`Account with slug ${slug} not found`);
  }

  // Sanity checks
  if (collective.type !== CollectiveType.COLLECTIVE || collective.HostCollectiveId !== collective.id) {
    throw new Error(`Account with slug ${slug} is not an independent collective`);
  }

  // Start a transaction to ensure data consistency
  const transaction = await sequelize.transaction();

  try {
    logger.info(`Converting ${collective.slug} to a host organization...`);
    await collective.update(
      {
        type: CollectiveType.ORGANIZATION,
        isHostAccount: true,
      },
      { transaction },
    );

    // Convert projects to collectives (if requested)
    let projects: Collective[] = [];
    const projectAdmins: Record<number, MemberModelInterface[]> = {};
    if (options.projectsToCollectives) {
      logger.info('Converting projects to collectives...');
      [, projects] = await Collective.update(
        {
          type: CollectiveType.COLLECTIVE,
          ParentCollectiveId: null,
        },
        {
          transaction,
          returning: true,
          where: {
            ParentCollectiveId: collective.id,
            type: CollectiveType.PROJECT,
          },
        },
      );

      if (!projects.length) {
        logger.info('No projects found');
      } else {
        // Add all admins of the main account to the projects (converted to collectives)
        const admins = await collective.getAdminMembers({
          transaction,
          include: [{ association: 'memberCollective' }],
        });
        for (const project of projects) {
          logger.info(`Adding admins to project ${project.slug}...`);
          projectAdmins[project.id] = admins;
          for (const admin of admins) {
            await Member.create(
              {
                CollectiveId: project.id,
                MemberCollectiveId: admin.MemberCollectiveId,
                role: MemberRoles.ADMIN,
                CreatedByUserId: admin.CreatedByUserId,
              },
              { transaction },
            );
          }
        }
      }
    }

    if (!options.isDryRun) {
      await transaction.commit();
      logger.info('Conversion completed successfully!');
    } else {
      await transaction.rollback();
      logger.info('---- Main account ----');
      logger.info(JSON.stringify(collective.dataValues, null, 2));
      logger.info('--------------------');
      if (projects.length) {
        logger.info('---- Projects ----');
        for (const project of projects) {
          logger.info(JSON.stringify(project.dataValues, null, 2));
          logger.info('Project admins:');
          projectAdmins[project.id].forEach(admin => {
            logger.info(
              ` - ${admin.memberCollective.name} (@${admin.memberCollective.slug}, #${admin.memberCollective.id})`,
            );
          });
        }
        logger.info('--------------------');
      }
      logger.info('Dry run completed - no changes were made');
    }
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

program.action(async (slug, options) => {
  logger.info('Starting conversion...');
  logger.info(`DRY_RUN: ${DRY_RUN}`);
  await main(slug, { ...options, isDryRun: DRY_RUN });
});

if (!module.parent) {
  program
    .parseAsync()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      logger.error(e.toString());
      process.exit(1);
    });
}
