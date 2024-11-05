import { Readable, Writable } from 'stream';

export default function streamToBuffer(stream: Readable): Promise<Buffer> {
  const data: Buffer[] = [];
  const writable = new Writable({
    write(chunk: Buffer, _, next: () => void): void {
      data.push(chunk);
      next();
    },
  });

  return new Promise((resolve: (Buffer) => void, reject: (Error) => void) => {
    stream
      .on('error', (error: Error): void => {
        writable.emit('error', error);
      })
      .pipe(writable)
      .on('finish', (): void => {
        resolve(Buffer.concat(data.map(d => new Uint8Array(d))));
      })
      .on('error', (error: Error): void => {
        reject(error);
      });
  });
}
