import { createLogger, format as _format, transports as _transports } from 'winston';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: _format.combine(
    _format.timestamp(),
    _format.errors({ stack: true }),
    _format.json()
  ),
  defaultMeta: { service: 'frontend' },
  transports: [
    new _transports.Console({
      format: _format.combine(
        _format.colorize(),
        _format.simple()
      )
    })
  ]
});

export default logger;