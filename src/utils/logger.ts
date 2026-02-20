import pinoModule from 'pino';

import { config } from './config.js';

const pino = pinoModule as unknown as typeof pinoModule.default;

export const logger = pino({
  level: config.LOG_LEVEL,
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
