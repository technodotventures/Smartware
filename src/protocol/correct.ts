// Legacy CORRECT handler — backward compatibility.
// New code should use revise.ts (spec verb REVISE) with the §9 admission payload.
export { handleCorrect, type CorrectParams, type CorrectResult, type CorrectReason } from './_correct_legacy.js';

// Also re-export the new REVISE handler for consumers that want to migrate.
export { handleRevise, type ReviseParams, type ReviseResult } from './revise.js';
