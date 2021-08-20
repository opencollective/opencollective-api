import { types } from '../server/constants/collectives';
import MemberRoles from '../server/constants/roles';
import tiers from '../server/constants/tiers';
import models, { Op, sequelize } from '../server/models';

async function run() {
  const members = await models.Member.findAll({
    where: {
      role: { [Op.ne]: MemberRoles.ATTENDEE },
    },
    include: [
      { model: models.Tier, where: { type: tiers.TICKET }, as: 'Tier' },
      { model: models.Collective, where: { type: types.EVENT }, as: 'collective' },
    ],
    order: [['createdAt', 'DESC']],
    paranoid: false,
  });

  for (const member of members) {
    await member.update({ role: MemberRoles.ATTENDEE });
  }

  await sequelize.close();
}

run();
