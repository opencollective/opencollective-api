#!/usr/bin/env node
import '../../server/env.js';

import models from '../../server/models/index.js';

models.Update.makeUpdatesPublic().then(process.exit);
