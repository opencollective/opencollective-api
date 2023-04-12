import { pick } from 'lodash';

import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import { Unauthorized } from '../../errors';

const editableAttributes = ['settings'];

export async function editConnectedAccount(req, connectedAccountData) {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to edit a connected account');
  }

  const connectedAccount = await models.ConnectedAccount.findByPk(connectedAccountData.id, {
    include: [{ association: 'collective', required: true }],
  });

  if (!connectedAccount) {
    throw new Unauthorized('Connected account not found');
  } else if (!req.remoteUser.isAdmin(connectedAccount.CollectiveId)) {
    throw new Unauthorized("You don't have permission to edit this connected account");
  } else if (
    connectedAccount.service === 'transferwise' &&
    connectedAccount.collective.settings?.transferwise?.isolateUsers &&
    req.remoteUser.id !== connectedAccount.CreatedByUserId
  ) {
    throw new Unauthorized("You don't have permission to edit this connected account");
  }

  await twoFactorAuthLib.enforceForAccount(req, connectedAccount.collective, { onlyAskOnLogin: true });

  await connectedAccount.update(pick(connectedAccountData, editableAttributes));
  return connectedAccount;
}
