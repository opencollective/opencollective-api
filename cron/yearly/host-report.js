#!/usr/bin/env node
import '../../server/env.js';
import '../../server/lib/sentry.js';

import config from 'config';

import HostReport from '../../reports/host-report.js';

// Only run on the first of the month
const today = new Date();
if (config.env === 'production' && today.getDate() !== 1 && today.getMonth() !== 0 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the first of the first month of the year, script aborted!');
  process.exit();
}

process.env.PORT = 3066;

const d = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();
const year = new Date(d.getFullYear() - 1, 1, 1).getFullYear();

HostReport(year);
