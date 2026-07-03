import * as z from 'zod';

function hasLeadingOrTrailingWhitespace(value: string): boolean {
  return value !== value.trim();
}

function addWhitespaceIssue(
  ctx: z.RefinementCtx,
  path: 'name' | 'context' | 'namespace' | 'podName' | 'containerName' | 'kubeconfigPath',
  label: string
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `${label} cannot start or end with spaces`,
    path: [path],
  });
}

export const k8sConnectionFormSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    context: z.string().min(1, 'Context is required'),
    namespace: z.string().min(1, 'Namespace is required'),
    podName: z.string().min(1, 'Pod is required'),
    containerName: z.string(),
    kubeconfigPath: z.string(),
    tmux: z.boolean(),
    shell: z.enum(['sh', 'bash', 'zsh']),
    isEditing: z.boolean(),
  })
  .superRefine((val, ctx) => {
    if (hasLeadingOrTrailingWhitespace(val.name)) {
      addWhitespaceIssue(ctx, 'name', 'Connection name');
    }
    if (hasLeadingOrTrailingWhitespace(val.context)) {
      addWhitespaceIssue(ctx, 'context', 'Context');
    }
    if (hasLeadingOrTrailingWhitespace(val.namespace)) {
      addWhitespaceIssue(ctx, 'namespace', 'Namespace');
    }
    if (hasLeadingOrTrailingWhitespace(val.podName)) {
      addWhitespaceIssue(ctx, 'podName', 'Pod');
    }
    if (hasLeadingOrTrailingWhitespace(val.containerName)) {
      addWhitespaceIssue(ctx, 'containerName', 'Container');
    }
    if (hasLeadingOrTrailingWhitespace(val.kubeconfigPath)) {
      addWhitespaceIssue(ctx, 'kubeconfigPath', 'Kubeconfig path');
    }
  });

export type K8sConnectionFormValues = z.infer<typeof k8sConnectionFormSchema>;
