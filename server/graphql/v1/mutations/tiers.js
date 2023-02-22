import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import { Unauthorized } from '../../errors';

export function editTiers(_, args, req) {
  let collective;
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to edit tiers');
  }

  return req.loaders.Collective.byId
    .load(args.id)
    .then(c => {
      if (!c) {
        throw new Error(`Collective with id ${args.id} not found`);
      }
      collective = c;
      return req.remoteUser.isAdminOfCollective(collective);
    })
    .then(canEdit => {
      if (!canEdit) {
        throw new Unauthorized(
          `You need to be logged in as a core contributor or as a host of the ${collective.name} collective`,
        );
      } else {
        return twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });
      }
    })
    .then(() => collective.editTiers(args.tiers));
}

/**
 * Edit a single tier
 */
export async function editTier(_, args, req) {
  if (!req.remoteUser) {
    throw new Unauthorized();
  }

  const tier = await req.loaders.Tier.byId.load(args.tier.id);

  const collective = await req.loaders.Collective.byId.load(tier.CollectiveId);
  if (!req.remoteUser.isAdminOfCollective(collective)) {
    throw new Unauthorized();
  }

  await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

  return tier.update(args.tier);
}
