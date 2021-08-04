import '../server/env';

import models from '../server/models';
import { login } from '../server/paymentProviders/thegivingblock';

async function run() {
  const hostId = 9805;
  const username = 'opencollective';
  const password = 'XXXXXXXXX';

  const { accessToken, refreshToken } = await login(username, password);

  let account = await models.ConnectedAccount.findOne({
    where: { CollectiveId: hostId, username, service: 'thegivingblock' },
  });
  if (!account) {
    account = await models.ConnectedAccount.create({
      where: { CollectiveId: hostId, username, service: 'thegivingblock' },
    });
  }
  await account.update({ data: { ...account.data, accessToken, refreshToken } });
}

run();
