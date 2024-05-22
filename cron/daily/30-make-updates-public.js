import '../../server/env';

import models from '../../server/models';

models.Update.makeUpdatesPublic().then(process.exit);
