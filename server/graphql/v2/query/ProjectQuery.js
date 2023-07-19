import { GraphQLProject } from '../object/Project.js';

import { buildAccountQuery } from './AccountQuery.js';

const ProjectQuery = buildAccountQuery({ objectType: GraphQLProject });

export default ProjectQuery;
