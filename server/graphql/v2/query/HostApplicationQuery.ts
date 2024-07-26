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
  async resolve(_, args) {
    return fetchHostApplicationWithReference(args.hostApplication, { throwIfMissing: true });
  },
};

export default HostApplicationQuery;
