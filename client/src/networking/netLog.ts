/**
 * Worker-safe logger seam for transport code. The transport stack
 * (tiers/WebSocketConnection/WebTransport) runs in BOTH contexts: main
 * thread and the dedicated net worker. It can't import Logger directly —
 * Logger pulls in settings/urlParams which touch window/localStorage at
 * module level and would crash a worker on import.
 *
 * A sink injects the real destination: main thread wires it to
 * ChildLogger (so Alt+Q keeps seeing transport logs), the worker wires it
 * to postMessage (main relays into the buffer). Without a sink, console.
 */

export type NetLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type NetLogSink = (level: NetLogLevel, name: string, msg: string, ctx?: unknown) => void;

let sink: NetLogSink | null = null;
export function setNetLogSink(s: NetLogSink | null): void { sink = s; }

export interface NetLogger {
  debug(msg: string, ctx?: unknown): void;
  info(msg: string, ctx?: unknown): void;
  warn(msg: string, ctx?: unknown): void;
  error(msg: string, ctx?: unknown): void;
}

export function netLogger(name: string): NetLogger {
  const emit = (level: NetLogLevel, msg: string, ctx?: unknown) => {
    if (sink) { sink(level, name, msg, ctx); return; }
    if (level === 'debug') {return;}
    const line = `[${name}] ${msg}`;
    // oxlint-disable-next-line no-console
    if (level === 'error') {console.error(line, ctx ?? '');}
    // oxlint-disable-next-line no-console
    else if (level === 'warn') {console.warn(line, ctx ?? '');}
    // oxlint-disable-next-line no-console
    else {console.info(line, ctx ?? '');}
  };
  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
  };
}
