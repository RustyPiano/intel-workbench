export class FileMutationQueue {
  private readonly inFlight = new Map<string, Promise<void>>();

  async runExclusive<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.inFlight.get(filePath) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.inFlight.set(filePath, previous.then(() => current));

    await previous;

    try {
      return await operation();
    } finally {
      release?.();
      if (this.inFlight.get(filePath) === current) {
        this.inFlight.delete(filePath);
      }
    }
  }
}
