import { loaders } from '../../graphql/loaders';
import { type User } from '../../models';

/**
 * A req object that only contains the necessary fields for the import/export process.
 */
export type PartialRequest = {
  remoteUser: User;
  loaders: ReturnType<typeof loaders>;
};
