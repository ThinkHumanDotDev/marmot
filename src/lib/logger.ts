import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'marmot' },
})

export const childLogger = (name: string) => logger.child({ module: name })
