import { GraphQLNonNull } from 'graphql';

import { ApplicationReferenceInput, fetchApplicationWithReference } from '../input/ApplicationReferenceInput';
import { Application } from '../object/Application';

const ApplicationQuery = {
  type: Application,
  args: {
    application: {
      type: new GraphQLNonNull(ApplicationReferenceInput),
      description: 'Identifiers to retrieve the Order',
    },
  },
  async resolve(_, args) {
    return fetchApplicationWithReference(args.application);
  },
};

export default ApplicationQuery;
