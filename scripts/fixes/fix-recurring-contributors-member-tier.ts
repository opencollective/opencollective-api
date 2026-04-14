import '../../server/env';

import { get } from 'lodash';
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
    const newTierId = get(member.dataValues, 'NewTierId') as number;
    if (process.env.DRY) {
      console.log(`Would fix Member #${member.id} with TierId ${newTierId}`);
    } else {
      await member.update({ TierId: newTierId });
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
