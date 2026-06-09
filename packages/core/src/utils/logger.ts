export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function createConsoleLogger(): Logger {
  return {
    debug(message, context) {
      if (context) {
        console.debug(message, context);
        return;
      }

      console.debug(message);
    },
    info(message, context) {
      if (context) {
        console.info(message, context);
        return;
      }

      console.info(message);
    },
    warn(message, context) {
      if (context) {
        console.warn(message, context);
        return;
      }

      console.warn(message);
    },
    error(message, context) {
      if (context) {
        console.error(message, context);
        return;
      }

      console.error(message);
    },
  };
}
