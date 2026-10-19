import { registerBeforeRoutesHook } from '../lib/express-hooks';

import { installE2EFixtures } from './fixtures';

registerBeforeRoutesHook(installE2EFixtures);
