// Copyright © 2020 IOHK
// License: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Cheap and cheerful logging functions.
 * Same as what is already in Daedalus.
 * Plug in your own logging by implementing [[Logger]].
 *
 * @packageDocumentation
 /*

/**
 * Logging adapter.
 */
export interface Logger {
  debug: LogFunc;
  info: LogFunc;
  warn: LogFunc;
  error: LogFunc;
}

/**
 * Function which logs a message and optional object.
 */
export interface LogFunc {
  (msg: string, param?: any): void;
}

/**
 * Create a new logger with a context name added.
 *
 * @param logger - existing logger.
 * @param name - context to prepend.
 * @return - a new logger.
 */
export function prependName(logger: Logger, name: string): Logger {
  const prefix = (
    severity: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    param?: any
  ): void => {
    const prefixed = `${name}: ${msg}`;
    if (param) {
      logger[severity](prefixed, param);
    } else {
      logger[severity](prefixed);
    }
  };
  return {
    debug: (msg: string, param?: any): void => prefix('debug', msg, param),
    info: (msg: string, param?: any): void => prefix('info', msg, param),
    warn: (msg: string, param?: any): void => prefix('warn', msg, param),
    error: (msg: string, param?: any): void => prefix('error', msg, param),
  };
}
