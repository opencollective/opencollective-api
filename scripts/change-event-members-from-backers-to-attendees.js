import MemberRoles from '../server/constants/roles';
import models, { sequelize } from '../server/models';

async function run() {
  const members = await sequelize.query(
    `SELECT m.* FROM "Members" m
      INNER JOIN "Tiers" t ON m."TierId" = t.id
      INNER JOIN "Collectives" c ON m."CollectiveId" = c.id
    WHERE t."type" = 'TICKET'
      AND m."role" != 'ATTENDEE'
      AND c."type" = 'EVENT'
    ORDER BY "createdAt" DESC`,
    {
      type: sequelize.QueryTypes.SELECT,
      model: models.Member,
      mapToModel: true,
    },
  );

  for (const member of members) {
    await member.update({ role: MemberRoles.ATTENDEE });
  }

  await sequelize.close();
}

run();
