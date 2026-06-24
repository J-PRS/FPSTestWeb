declare module 'msgpack-lite' {
  export function encode(data: any): Uint8Array;
  export function decode(buffer: Uint8Array): any;
}
