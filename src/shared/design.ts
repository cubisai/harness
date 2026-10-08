/** A design thread's folder, relative to the thread's working folder: stable, since titles change. */
export function designDirName(threadId: string): string {
  return `designs/${threadId.slice(0, 8)}`;
}

