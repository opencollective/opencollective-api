import { parseArgs } from 'node:util';

export const parseOptions = () => {
  const { values } = parseArgs({
    options: {
      fix: {
        type: 'boolean',
        default: false,
      },
    },
  });

  return values;
};

type CheckFn = (options: { fix: boolean }) => Promise<void>;

export const runCheckThenExit = async (check: CheckFn): Promise<void> => {
  const options = parseOptions();
  return check(options)
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
};
