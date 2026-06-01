import { describe, expect, it } from 'vitest';
import type { K8sConnectionRow } from '@main/db/schema';
import {
  k8sConfigFromRow,
  mergeK8sConnectionMetadata,
  parseK8sConnectionMetadata,
  serializeK8sConnectionMetadata,
} from './connection-metadata';

describe('k8s connection metadata', () => {
  describe('parse/serialize round-trip', () => {
    it('round-trips kubeconfigPath and tmux', () => {
      const serialized = serializeK8sConnectionMetadata({
        kubeconfigPath: '/home/user/.kube/config',
        tmux: true,
      });
      const parsed = parseK8sConnectionMetadata(serialized);
      expect(parsed).toEqual({ kubeconfigPath: '/home/user/.kube/config', tmux: true });
    });

    it('round-trips tmux: false', () => {
      const parsed = parseK8sConnectionMetadata(serializeK8sConnectionMetadata({ tmux: false }));
      expect(parsed.tmux).toBe(false);
    });

    it('omits tmux when unset', () => {
      const parsed = parseK8sConnectionMetadata(serializeK8sConnectionMetadata({}));
      expect(parsed.tmux).toBeUndefined();
    });

    it('ignores non-boolean tmux values', () => {
      const parsed = parseK8sConnectionMetadata(JSON.stringify({ tmux: 'yes' }));
      expect(parsed.tmux).toBeUndefined();
    });

    it('round-trips shell', () => {
      for (const shell of ['sh', 'bash', 'zsh'] as const) {
        const parsed = parseK8sConnectionMetadata(serializeK8sConnectionMetadata({ shell }));
        expect(parsed.shell).toBe(shell);
      }
    });

    it('omits shell when unset', () => {
      const parsed = parseK8sConnectionMetadata(serializeK8sConnectionMetadata({}));
      expect(parsed.shell).toBeUndefined();
    });

    it('ignores invalid shell values', () => {
      const parsed = parseK8sConnectionMetadata(JSON.stringify({ shell: 'fish' }));
      expect(parsed.shell).toBeUndefined();
    });

    it('returns empty object for null or malformed metadata', () => {
      expect(parseK8sConnectionMetadata(null)).toEqual({});
      expect(parseK8sConnectionMetadata('not json')).toEqual({});
    });
  });

  describe('mergeK8sConnectionMetadata', () => {
    it('overwrites tmux when present in the update', () => {
      const merged = mergeK8sConnectionMetadata({ tmux: true }, { tmux: false });
      expect(merged.tmux).toBe(false);
    });

    it('preserves existing tmux when absent from the update', () => {
      const merged = mergeK8sConnectionMetadata({ tmux: true }, { kubeconfigPath: '/x' });
      expect(merged.tmux).toBe(true);
      expect(merged.kubeconfigPath).toBe('/x');
    });

    it('clears tmux when the update explicitly sets it to undefined', () => {
      const merged = mergeK8sConnectionMetadata({ tmux: true }, { tmux: undefined });
      expect(merged.tmux).toBeUndefined();
    });

    it('overwrites shell when present in the update', () => {
      const merged = mergeK8sConnectionMetadata({ shell: 'sh' }, { shell: 'zsh' });
      expect(merged.shell).toBe('zsh');
    });

    it('preserves existing shell when absent from the update', () => {
      const merged = mergeK8sConnectionMetadata({ shell: 'bash' }, { tmux: false });
      expect(merged.shell).toBe('bash');
    });

    it('clears shell when the update explicitly sets it to undefined', () => {
      const merged = mergeK8sConnectionMetadata({ shell: 'bash' }, { shell: undefined });
      expect(merged.shell).toBeUndefined();
    });
  });

  describe('k8sConfigFromRow', () => {
    const baseRow: K8sConnectionRow = {
      id: 'conn-1',
      name: 'My Cluster',
      context: 'ctx',
      namespace: 'ns',
      podName: 'pod',
      containerName: null,
      kubeconfigPath: null,
      metadata: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    it('reads tmux from metadata', () => {
      const config = k8sConfigFromRow({
        ...baseRow,
        metadata: serializeK8sConnectionMetadata({ tmux: true }),
      });
      expect(config.tmux).toBe(true);
    });

    it('leaves tmux undefined when metadata has none (legacy rows default ON downstream)', () => {
      const config = k8sConfigFromRow(baseRow);
      expect(config.tmux).toBeUndefined();
    });

    it('reads shell from metadata', () => {
      const config = k8sConfigFromRow({
        ...baseRow,
        metadata: serializeK8sConnectionMetadata({ shell: 'zsh' }),
      });
      expect(config.shell).toBe('zsh');
    });

    it('leaves shell undefined when metadata has none (defaults to /bin/sh downstream)', () => {
      const config = k8sConfigFromRow(baseRow);
      expect(config.shell).toBeUndefined();
    });
  });
});
