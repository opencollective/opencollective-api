import config from 'config';
import winston, { format } from 'winston';

const logger = winston.createLogger();

const winstonLevel = config.log.level;

const padLines = (str, spaces) =>
  str
    .split('\n')
    .map(line => ' '.repeat(spaces) + line)
    .join('\n');

const simpleWithPaddedMeta = format.printf(({ level, message, ...props }) => {
  let m = `${level}: ${message}`;
  const padding = props[Symbol.for('level')].length + 2;
  const extras = props[Symbol.for('splat')];
  if (extras && extras.length === 1 && typeof extras[0] === 'string') {
    m += ` ${extras[0]}`;
  } else if (Object.keys(props).length > 0) {
    m += `\n\n${' '.repeat(padding)}Meta:\n${padLines(JSON.stringify(props, null, 2), padding)}`;
  }
  return m;
});

const winstonFormat = format.combine(format.colorize(), format.splat(), simpleWithPaddedMeta);

const winstonConsole = new winston.transports.Console({
  level: winstonLevel,
  format: winstonFormat,
});

logger.add(winstonConsole);
logger.exceptions.handle(winstonConsole);

export default logger;
