import { type SourceSpan } from '@glimmer/syntax';
import _debug from 'debug';
import {
  createLogger as _createLogger,
  format,
  transports,
  type Logform,
  type Logger,
} from 'winston';
import Transport from 'winston-transport';

export { type Logger } from 'winston';

type LogInfo = Logform.TransformableInfo & {
  label: string;
  timestamp: string;
};

export default function createLogger(namespace: string, label: string): Logger {
  const debug = _debug(namespace);

  class DebugTransport extends Transport {
    public override log(info: LogInfo, next: () => void): void {
      debug(info[Symbol.for('message')]);
      next();
    }
  }

  return _createLogger({
    level: 'debug',
    transports: [
      new transports.File({
        level: 'info',
        filename: `${namespace}.log`,
        format: format.combine(
          joinLines(),
          format.label({ label }),
          format.timestamp(),
          format.splat(),
          logFormatter
        ),
      }),
      new DebugTransport({
        level: 'debug',
        format: format.combine(
          joinLines(),
          format.label({ label }),
          format.timestamp(),
          format.splat(),
          debugFormatter
        ),
      }),
    ],
  });
}

const joinLines = format((info) => {
  if (
    Array.isArray(info.message) &&
    info.message.every((m): m is string => typeof m === 'string')
  ) {
    info.message = joinLogLines(info.message);
  }
  return info;
});

const logFormatter = format.printf(
  ({ level, label, timestamp, message, loc }) => {
    return `${String(timestamp)} [${level}] ${concatMessage(
      String(label),
      String(message),
      loc as SourceSpan | undefined
    )}`;
  }
);

const debugFormatter = format.printf(({ label, message }) => {
  return concatMessage(String(label), String(message));
});

function concatMessage(
  label: string,
  message: string,
  loc?: SourceSpan | undefined
): string {
  if (loc) {
    const start = loc.startPosition;
    label += `:${start.line}:${start.column + 1}`;
  }
  return joinLogLines([label, message]);
}

function joinLogLines(lines: string[]): string {
  return lines.join('\n\t');
}
