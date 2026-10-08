import { assertCanSeeAllAccounts } from '../../../lib/private-accounts';
import { checkRemoteUserCanUseApplications } from '../../common/scope-check';
import { Unauthorized } from '../../errors';
import {
  fetchHostApplicationWithReference,
  GraphQLHostApplicationReferenceInput,
} from '../input/HostApplicationReferenceInput';
import { GraphQLHostApplication } from '../object/HostApplication';

const HostApplicationQuery = {
  type: GraphQLHostApplication,
  description: 'Fetch a host application. Scope: "applications".',
  args: {
    hostApplication: {
      type: GraphQLHostApplicationReferenceInput,
    },
  },
  async resolve(_, args, req) {
    const hostApplication = await fetchHostApplicationWithReference(args.hostApplication, { throwIfMissing: true });
    const [account, host] = await Promise.all([
      req.loaders.Collective.byId.load(hostApplication.CollectiveId),
      req.loaders.Collective.byId.load(hostApplication.HostCollectiveId),
    ]);
    await assertCanSeeAllAccounts(req, [account, host].filter(Boolean));
    if (
      !req.remoteUser?.isAdmin(hostApplication.HostCollectiveId) &&
      !req.remoteUser?.isAdmin(hostApplication.CollectiveId)
    ) {
      throw new Unauthorized(
        'You need to be logged in as an admin of the host or the collective to see this host application',
      );
    }
    checkRemoteUserCanUseApplications(req);
    return hostApplication;
  },
};

export default HostApplicationQuery;
