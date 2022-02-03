import { Project } from '../object/Project';

import { buildAccountQuery } from './AccountQuery';

const ProjectQuery = buildAccountQuery({ objectType: Project });

export default ProjectQuery;
