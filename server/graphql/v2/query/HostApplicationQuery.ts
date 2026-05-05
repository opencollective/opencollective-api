import { assertCanSeeAllAccounts } from '../../../lib/private-accounts';
import {
  fetchHostApplicationWithReference,
  GraphQLHostApplicationReferenceInput,
} from '../input/HostApplicationReferenceInput';
import { GraphQLHostApplication } from '../object/HostApplication';

const HostApplicationQuery = {
  type: GraphQLHostApplication,
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
    return hostApplication;
  },
};

export default HostApplicationQuery;
