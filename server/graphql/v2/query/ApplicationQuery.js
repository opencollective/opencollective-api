import { pick } from 'lodash';

import { ApplicationReferenceFields, fetchApplicationWithReference } from '../input/ApplicationReferenceInput';
import { Application } from '../object/Application';

const ApplicationQuery = {
  type: Application,
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
