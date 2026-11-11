/**
 * The drawing module's only outside dependencies, in one place. On merge these move to deno.json "imports" (shared with the
 * doc core, which needs the same Yjs) while re-exported npm: specifiers here keep this spike self-contained.
 */
export * as Y from 'npm:yjs@13.6.33';
export { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from 'npm:y-protocols@1.0.7/awareness';
