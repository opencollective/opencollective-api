#!/usr/bin/env node
import '../../server/env';

import config from 'config';

// Only run on the first of the month
const today = new Date();
if (config.env === 'production' && today.getDate() !== 1 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the first of month, script aborted!');
  process.exit();
}

process.env.PORT = 3066;

import PlatformReport from '../../reports/platform-report';

const d = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();
const rd = new Date(d.getFullYear(), d.getMonth() - 1);
PlatformReport(rd.getFullYear(), rd.getMonth());
