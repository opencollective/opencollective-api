/** Convert `v` to negative if possitive, don't touch it otherwise. */
export function toNegative(v: number) {
  return v > 0 ? -v : v;
}

/** Format a byte count as a human-readable size, e.g. `512 B`, `2.0 KB`, `5.0 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}
