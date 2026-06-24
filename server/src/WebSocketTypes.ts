/**
 * TypeScript interfaces for uWS.js WebSocket types
 * uWS.js has poor TypeScript support, so we define our own interfaces
 * based on the library's documentation
 */

export interface WebSocket {
  send(message: string | ArrayBuffer, isBinary?: boolean, compress?: boolean): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

export interface WebSocketBehavior {
  open: (ws: WebSocket) => void;
  message: (ws: WebSocket, message: ArrayBuffer, isBinary: boolean) => void;
  close: (ws: WebSocket, code: number, message: ArrayBuffer) => void;
}

export interface App {
  ws(pattern: string, behavior: WebSocketBehavior): App;
  listen(port: number, callback: (token: any) => void): void;
}

export interface ListenToken {
  name: string;
}
