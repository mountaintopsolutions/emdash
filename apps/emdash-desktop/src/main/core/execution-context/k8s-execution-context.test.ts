import { describe, expect, it } from 'vitest';
import type { RemoteShellProfile } from '@main/core/execution-context/remote-shell-profile';
import { buildK8sCommand } from './k8s-execution-context';

describe('buildK8sCommand', () => {
  it('uses the shared remote shell command builder for fallback exec commands', () => {
    const command = buildK8sCommand('/workspace/project', 'which', ['claude']);

    expect(command).toBe(
      "'/bin/sh' -c 'cd '\\''/workspace/project'\\'' && which '\\''claude'\\'''"
    );
  });

  it('uses the remote shell profile and cwd when building exec commands', () => {
    const profile: RemoteShellProfile = {
      shell: '/bin/zsh',
      env: {
        PATH: '/Users/jona/.local/bin:/opt/homebrew/bin:/usr/bin',
      },
    };

    const command = buildK8sCommand('/workspace/project', 'which', ['claude'], profile);

    expect(command).toBe(
      "'/bin/zsh' -lc 'export PATH='\\''/Users/jona/.local/bin:/opt/homebrew/bin:/usr/bin'\\''; cd '\\''/workspace/project'\\'' && which '\\''claude'\\'''"
    );
  });

  it('disables interactive Git credential prompts for exec commands', () => {
    const command = buildK8sCommand('/workspace/project', 'git', ['fetch', 'origin']);

    expect(command).toBe(
      "'/bin/sh' -c 'cd '\\''/workspace/project'\\'' && GIT_ASKPASS='\\'''\\'' GIT_TERMINAL_PROMPT='\\''0'\\'' GCM_INTERACTIVE='\\''never'\\'' SSH_ASKPASS='\\'''\\'' git '\\''fetch'\\'' '\\''origin'\\'''"
    );
  });
});
