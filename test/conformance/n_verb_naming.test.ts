// Conformance Suite N — Verb Naming (§8, §14)

import { describe, it, expect } from 'vitest';
import { SmartwareCore } from '../../src/core.js';
import { handleRecall } from '../../src/protocol/recall.js';
import { handleReflect } from '../../src/protocol/reflect.js';
import { handleRevise } from '../../src/protocol/revise.js';

describe('Verb Naming', () => {
  it('N1: mcp_tools_use_spec_verb_names', () => {
    // The spec-named handlers exist and are importable from the spec-named files.
    expect(typeof handleRecall).toBe('function');
    expect(typeof handleReflect).toBe('function');
    expect(typeof handleRevise).toBe('function');
  });

  it('N2: core_api_uses_spec_verb_names', () => {
    // SmartwareCore has .recall(), .reflect(), .revise() methods.
    expect(typeof SmartwareCore.prototype.recall).toBe('function');
    expect(typeof SmartwareCore.prototype.reflect).toBe('function');
    expect(typeof SmartwareCore.prototype.revise).toBe('function');
  });
});
