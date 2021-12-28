import readline from 'readline';

export const confirm = question => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise(resolve => {
    rl.question(`${question}\n> `, input => {
      if (input.toLowerCase() === 'yes') {
        resolve(true);
      } else {
        rl.close();
        resolve(false);
      }
    });
  });
};
