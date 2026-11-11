// Hand-written types for the parts of the vendored Yjs bundle (yjs.js) that AIB's docs server uses. Not the full Yjs API.

export interface ID {
  client: number;
  clock: number;
}

export interface Item {
  id: ID;
  deleted: boolean;
}

export type Attributes = Record<string, unknown>;
export interface DeltaInsert {
  insert: string | object;
  attributes?: Attributes;
}
export type DeltaOp = DeltaInsert | { retain: number; attributes?: Attributes } | { delete: number };

export interface Transaction {
  doc: Doc;
  origin: unknown;
  local: boolean;
  changed: Map<AbstractType, Set<string | null>>;
  deleteSet: { clients: Map<number, unknown[]> };
}

export class AbstractType {
  _item: Item | null;
  doc: Doc | null;
  parent: AbstractType | null;
  readonly length: number;
  observeDeep(f: (events: unknown[], tr: Transaction) => void): void;
  unobserveDeep(f: (events: unknown[], tr: Transaction) => void): void;
}

export class Doc {
  constructor(opts?: { gc?: boolean; guid?: string });
  clientID: number;
  gc: boolean;
  getXmlFragment(name?: string): XmlFragment;
  transact<T>(f: (tr: Transaction) => T, origin?: unknown): T;
  on(event: 'update', f: (update: Uint8Array, origin: unknown, doc: Doc, tr: Transaction) => void): void;
  on(event: 'afterTransaction', f: (tr: Transaction, doc: Doc) => void): void;
  off(event: string, f: (...args: never[]) => void): void;
  destroy(): void;
}

export type XmlChild = XmlElement | XmlText;

export class XmlFragment extends AbstractType {
  constructor();
  insert(index: number, content: XmlChild[]): void;
  delete(index: number, length?: number): void;
  get(index: number): XmlChild;
  toArray(): XmlChild[];
  toString(): string;
}

export class XmlElement extends XmlFragment {
  constructor(nodeName?: string);
  nodeName: string;
  setAttribute(name: string, value: unknown): void;
  getAttribute(name: string): unknown;
  getAttributes(): Record<string, unknown>;
}

export class XmlText extends AbstractType {
  constructor(text?: string);
  insert(index: number, text: string, attributes?: Attributes): void;
  delete(index: number, length: number): void;
  format(index: number, length: number, attributes: Attributes): void;
  applyDelta(delta: DeltaOp[]): void;
  toDelta(): DeltaInsert[];
  toString(): string;
}

export class UndoManager {
  constructor(scope: AbstractType | AbstractType[], opts?: { trackedOrigins?: Set<unknown>; captureTimeout?: number });
  undo(): unknown;
  redo(): unknown;
  stopCapturing(): void;
  clear(): void;
  destroy(): void;
  undoStack: unknown[];
}

export function encodeStateAsUpdate(doc: Doc, encodedTargetStateVector?: Uint8Array): Uint8Array;
export function encodeStateVector(doc: Doc): Uint8Array;
export function applyUpdate(doc: Doc, update: Uint8Array, origin?: unknown): void;

export declare namespace encoding {
  interface Encoder {
    readonly __encoder: unique symbol;
  }
  function createEncoder(): Encoder;
  function writeVarUint(e: Encoder, n: number): void;
  function writeVarUint8Array(e: Encoder, a: Uint8Array): void;
  function toUint8Array(e: Encoder): Uint8Array;
  function length(e: Encoder): number;
}

export declare namespace decoding {
  interface Decoder {
    readonly __decoder: unique symbol;
  }
  function createDecoder(a: Uint8Array): Decoder;
  function readVarUint(d: Decoder): number;
  function readVarUint8Array(d: Decoder): Uint8Array;
}

export declare namespace sync {
  function writeSyncStep1(e: encoding.Encoder, doc: Doc): void;
  function writeUpdate(e: encoding.Encoder, update: Uint8Array): void;
  function readSyncMessage(d: decoding.Decoder, e: encoding.Encoder, doc: Doc, origin: unknown): number;
}

export declare namespace awareness {
  class Awareness {
    constructor(doc: Doc);
    clientID: number;
    getStates(): Map<number, Record<string, unknown>>;
    getLocalState(): Record<string, unknown> | null;
    setLocalState(state: Record<string, unknown> | null): void;
    setLocalStateField(field: string, value: unknown): void;
    on(event: 'update', f: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void): void;
    off(event: string, f: (...args: never[]) => void): void;
    destroy(): void;
  }
  function encodeAwarenessUpdate(a: Awareness, clients: number[]): Uint8Array;
  function applyAwarenessUpdate(a: Awareness, update: Uint8Array, origin: unknown): void;
  function removeAwarenessStates(a: Awareness, clients: number[], origin: unknown): void;
}
