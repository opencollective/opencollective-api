import { GraphQLProject } from '../object/Project';

import { buildAccountQuery } from './AccountQuery';

const ProjectQuery = buildAccountQuery({ objectType: GraphQLProject });

export default ProjectQuery;
