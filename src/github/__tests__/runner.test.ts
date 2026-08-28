import { describe, it, expect, vi } from 'vitest';
import { AppClient, AppClientRegistry } from '../runner.js';

function mockClient(label = 'default'): AppClient {
  return { createRunnerToken: vi.fn().mockResolvedValue(`token-${label}`) } as unknown as AppClient;
}

describe('AppClientRegistry', () => {
  describe('fromDefault', () => {
    it('returns the default client for any owner', () => {
      const def = mockClient('default');
      const registry = AppClientRegistry.fromDefault(def);
      expect(registry.clientFor('acme')).toBe(def);
      expect(registry.clientFor('other-org')).toBe(def);
    });
  });

  describe('register + clientFor', () => {
    it('routes to the registered client for that org', () => {
      const def = mockClient('default');
      const acmeClient = mockClient('acme');
      const registry = AppClientRegistry.fromDefault(def);
      registry.register('acme', acmeClient);
      expect(registry.clientFor('acme')).toBe(acmeClient);
    });

    it('falls back to default for unregistered orgs', () => {
      const def = mockClient('default');
      const registry = AppClientRegistry.fromDefault(def);
      registry.register('acme', mockClient('acme'));
      expect(registry.clientFor('unknown-org')).toBe(def);
    });

    it('matches case-insensitively', () => {
      const def = mockClient('default');
      const acmeClient = mockClient('acme');
      const registry = AppClientRegistry.fromDefault(def);
      registry.register('Acme', acmeClient);
      expect(registry.clientFor('ACME')).toBe(acmeClient);
      expect(registry.clientFor('acme')).toBe(acmeClient);
      expect(registry.clientFor('Acme')).toBe(acmeClient);
    });

    it('supports multiple independent orgs', () => {
      const def = mockClient('default');
      const clientA = mockClient('a');
      const clientB = mockClient('b');
      const registry = AppClientRegistry.fromDefault(def);
      registry.register('org-a', clientA);
      registry.register('org-b', clientB);
      expect(registry.clientFor('org-a')).toBe(clientA);
      expect(registry.clientFor('org-b')).toBe(clientB);
      expect(registry.clientFor('org-c')).toBe(def);
    });

    it('overwrites a previously registered org', () => {
      const def = mockClient('default');
      const first = mockClient('first');
      const second = mockClient('second');
      const registry = AppClientRegistry.fromDefault(def);
      registry.register('acme', first);
      registry.register('acme', second);
      expect(registry.clientFor('acme')).toBe(second);
    });
  });
});
