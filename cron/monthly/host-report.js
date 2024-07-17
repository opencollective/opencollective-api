import '../../server/env';

import config from 'config';

// Only run on the first of the month
const today = new Date();
if (config.env === 'production' && today.getDate() !== 1 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the first of month, script aborted!');
  process.exit();
} else if (parseToBoolean(process.env.SKIP_HOST_REPORT)) {
  console.log('Skipping because SKIP_HOST_REPORT is set.');
  process.exit();
}

process.env.PORT = 3066;

import HostReport from '../../reports/host-report';
import { parseToBoolean } from '../../server/lib/utils';
import { runCronJob } from '../utils';

const hostId = process.env.HOST_ID;

const d = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();
const rd = new Date(d.getFullYear(), d.getMonth() - 1);

if (require.main === module) {
  runCronJob('host-report', () => HostReport(rd.getFullYear(), rd.getMonth(), hostId), 23 * 60 * 60);
}
