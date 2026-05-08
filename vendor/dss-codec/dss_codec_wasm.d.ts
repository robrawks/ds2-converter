/* tslint:disable */
/* eslint-disable */

export class DecodeResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly format: string;
    readonly nativeRate: number;
    readonly samples: Float32Array;
}

export class InspectResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly encryption: string;
    readonly format: string;
    readonly nativeRate: number;
}

export class StreamDecoder {
    free(): void;
    [Symbol.dispose](): void;
    finish(): Float32Array;
    constructor();
    push(data: Uint8Array): Float32Array;
    static withPassword(password: Uint8Array): StreamDecoder;
    readonly format: string | undefined;
    readonly nativeRate: number | undefined;
}

export function decode(data: Uint8Array): DecodeResult;

export function decodeWithPassword(data: Uint8Array, password: Uint8Array): DecodeResult;

export function decrypt(data: Uint8Array): Uint8Array;

export function decryptWithPassword(data: Uint8Array, password: Uint8Array): Uint8Array;

export function inspect(data: Uint8Array): InspectResult;

export function isEncryptedDs2(data: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_decoderesult_free: (a: number, b: number) => void;
    readonly __wbg_inspectresult_free: (a: number, b: number) => void;
    readonly __wbg_streamdecoder_free: (a: number, b: number) => void;
    readonly decode: (a: number, b: number) => [number, number, number];
    readonly decodeWithPassword: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly decoderesult_format: (a: number) => [number, number];
    readonly decoderesult_nativeRate: (a: number) => number;
    readonly decoderesult_samples: (a: number) => [number, number];
    readonly decrypt: (a: number, b: number) => [number, number, number, number];
    readonly decryptWithPassword: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly inspect: (a: number, b: number) => [number, number, number];
    readonly inspectresult_encryption: (a: number) => [number, number];
    readonly inspectresult_format: (a: number) => [number, number];
    readonly isEncryptedDs2: (a: number, b: number) => number;
    readonly streamdecoder_finish: (a: number) => [number, number, number, number];
    readonly streamdecoder_format: (a: number) => [number, number];
    readonly streamdecoder_nativeRate: (a: number) => number;
    readonly streamdecoder_new: () => number;
    readonly streamdecoder_push: (a: number, b: number, c: number) => [number, number, number, number];
    readonly streamdecoder_withPassword: (a: number, b: number) => number;
    readonly inspectresult_nativeRate: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
