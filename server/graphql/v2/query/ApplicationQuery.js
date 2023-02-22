import { pick } from 'lodash';

import { ApplicationReferenceFields, fetchApplicationWithReference } from '../input/ApplicationReferenceInput';
import { GraphQLApplication } from '../object/Application';

const ApplicationQuery = {
  type: GraphQLApplication,
  args: {
    ...ApplicationReferenceFields,
  },
  async resolve(_, args) {
    // Read https://github.com/opencollective/opencollective/issues/4656
    const applicationReference = pick(args, ['id', 'legacyId', 'clientId']);
    return fetchApplicationWithReference(applicationReference);
  },
};

export default ApplicationQuery;
