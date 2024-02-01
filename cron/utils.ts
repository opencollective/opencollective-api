import config from 'config';

/**
 * Heroku scheduler only has daily or hourly cron jobs, we only want to run
 * this script once per week on Monday (1). If the day is not Monday on production
 * we won't execute the script
 */
export function onlyExecuteInProdOnMondays() {
  const today = new Date();
  if (config.env === 'production' && today.getDay() !== 1) {
    console.log('OC_ENV is production and day is not Monday, script aborted!');
    process.exit(0);
  }
}
