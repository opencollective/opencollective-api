#!/usr/bin/env node
import '../../server/env.js';
import '../../server/lib/sentry.js';

import models from '../../server/models/index.js';

models.Update.makeUpdatesPublic().then(process.exit);
