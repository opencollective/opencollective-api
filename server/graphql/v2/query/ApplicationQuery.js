import { pick } from 'lodash';

import { assertCanSeeAccount } from '../../../lib/private-accounts';
import { ApplicationReferenceFields, fetchApplicationWithReference } from '../input/ApplicationReferenceInput';
import { GraphQLApplication } from '../object/Application';

const ApplicationQuery = {
  type: GraphQLApplication,
  args: {
    ...ApplicationReferenceFields,
  },
  async resolve(_, args, req) {
    // Read https://github.com/opencollective/opencollective/issues/4656
    const applicationReference = pick(args, ['id', 'legacyId', 'clientId']);
    const application = await fetchApplicationWithReference(applicationReference);
    const collective = await req.loaders.Collective.byId.load(application.CollectiveId);
    await assertCanSeeAccount(req, collective);
    return application;
  },
};

export default ApplicationQuery;
