import '../../server/env';

import { QueryTypes } from 'sequelize';

import models, { sequelize } from '../../server/models';

const migrate = async () => {
  const members = await sequelize.query(
    `
        select m.*, o."TierId" as "NewTierId"
        from
            "Members" m
            inner join "Orders" o on (o."FromCollectiveId" = m."MemberCollectiveId" and o."CollectiveId" = m."CollectiveId")
            inner join "Subscriptions" s on (o."SubscriptionId" = s.id)
        where
            s."isActive"= true
            AND m."TierId" <> o."TierId"
  `,
    {
      type: QueryTypes.SELECT,
      model: models.Member,
      mapToModel: true,
    },
  );

  for (const member of members) {
    if (process.env.DRY) {
      console.log(`Would fix Member #${member.id} with TierId ${member.dataValues.NewTierId}`);
    } else {
      await member.update({ TierId: member.dataValues.NewTierId });
    }
  }
};

const main = async () => {
  return migrate();
};

if (require.main === module) {
  main()
    .then(() => process.exit())
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
