import '../../server/env';

import models from '../../server/models';
import { runCronJob } from '../utils';

if (require.main === module) {
  runCronJob('make-updates-public', () => models.Update.makeUpdatesPublic(), 24 * 60 * 60);
}
