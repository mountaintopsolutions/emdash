import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@renderer/lib/ui/select';
import { Switch } from '@renderer/lib/ui/switch';
import type { ConnectionTestResult, K8sConfig } from '@shared/kubernetes';
import { k8sConnectionFormSchema } from './k8s-connection-form-schema';

export interface AddK8sConnModalProps extends BaseModalProps<{ connectionId: string }> {
  initialConfig?: K8sConfig;
  dismissControl?: 'back' | 'close';
}

type TestState = 'idle' | 'testing' | 'success' | 'error';

export function AddK8sConnModal({
  onSuccess,
  onClose,
  initialConfig,
  dismissControl = 'back',
}: AddK8sConnModalProps) {
  const k8sConnections = appState.k8sConnections;
  const isEditing = !!initialConfig;
  const showBackButton = dismissControl === 'back';

  const [testState, setTestState] = useState<TestState>('idle');
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [showDebugLogs, setShowDebugLogs] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(!!initialConfig?.kubeconfigPath);
  // Track the kubeconfig path used for discovery; only the advanced field updates it.
  const [kubeconfigPath, setKubeconfigPath] = useState(initialConfig?.kubeconfigPath ?? '');

  const form = useForm({
    defaultValues: {
      name: initialConfig?.name ?? '',
      context: initialConfig?.context ?? '',
      namespace: initialConfig?.namespace ?? '',
      podName: initialConfig?.podName ?? '',
      containerName: initialConfig?.containerName ?? '',
      kubeconfigPath: initialConfig?.kubeconfigPath ?? '',
      tmux: initialConfig?.tmux ?? true,
      shell: initialConfig?.shell ?? 'sh',
      isEditing,
    },
    validators: {
      onSubmit: k8sConnectionFormSchema,
    },
    onSubmit: async ({ value }) => {
      setIsSubmitting(true);
      try {
        const config: Partial<Pick<K8sConfig, 'id'>> & Omit<K8sConfig, 'id'> = {
          id: initialConfig?.id,
          name: value.name,
          context: value.context,
          namespace: value.namespace,
          podName: value.podName,
          containerName: value.containerName.trim() || undefined,
          kubeconfigPath: value.kubeconfigPath.trim() || undefined,
          tmux: value.tmux,
          shell: value.shell,
        };
        const saved = await k8sConnections.saveConnection(config);
        onSuccess({ connectionId: saved.id });
      } catch (err) {
        setTestState('error');
        setTestResult({ success: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        setIsSubmitting(false);
      }
    },
  });

  const trimmedKubeconfigPath = kubeconfigPath.trim() || undefined;

  // Cascading discovery: contexts → namespaces → pods.
  // Each level only loads once its parent selection exists; switching a parent
  // resets every dependent field below it.
  const contextsQuery = useQuery({
    queryKey: ['k8sContexts', trimmedKubeconfigPath],
    queryFn: () => k8sConnections.getContexts(trimmedKubeconfigPath),
    retry: false,
  });
  const contexts = contextsQuery.data ?? [];

  const selectedContext = form.state.values.context;
  // Namespace/pod listing can be denied by RBAC (namespace-scoped users often
  // cannot list cluster namespaces) or be slow, so these power optional
  // suggestions only — the fields stay free-text. retry:false surfaces failures
  // immediately instead of spinning.
  const namespacesQuery = useQuery({
    queryKey: ['k8sNamespaces', trimmedKubeconfigPath, selectedContext],
    queryFn: () => k8sConnections.getNamespaces(selectedContext, trimmedKubeconfigPath),
    enabled: selectedContext.length > 0,
    retry: false,
  });
  const namespaces = namespacesQuery.data ?? [];

  const selectedNamespace = form.state.values.namespace;
  const podsQuery = useQuery({
    queryKey: ['k8sPods', trimmedKubeconfigPath, selectedContext, selectedNamespace],
    queryFn: () =>
      k8sConnections.getPods(selectedContext, selectedNamespace, trimmedKubeconfigPath),
    enabled: selectedContext.length > 0 && selectedNamespace.length > 0,
    retry: false,
  });
  const pods = podsQuery.data ?? [];

  const selectedPod = pods.find((pod) => pod.name === form.state.values.podName);
  const containers = selectedPod?.containers ?? [];

  const buildTestConfig = (): K8sConfig => {
    const v = form.state.values;
    return {
      id: initialConfig?.id ?? '',
      name: v.name,
      context: v.context,
      namespace: v.namespace,
      podName: v.podName,
      containerName: v.containerName.trim() || undefined,
      kubeconfigPath: v.kubeconfigPath.trim() || undefined,
      tmux: v.tmux,
      shell: v.shell,
    };
  };

  const validateConnectionForm = async (): Promise<boolean> => {
    await form.validateAllFields('submit');
    await form.validate('submit');
    return form.state.isValid;
  };

  const handleTestConnection = async () => {
    setTestResult(null);
    setShowDebugLogs(false);
    const isValid = await validateConnectionForm();
    if (!isValid) {
      setTestState('idle');
      return;
    }

    setTestState('testing');
    try {
      const result = await k8sConnections.testConnection(buildTestConfig());
      setTestResult(result);
      setTestState(result.success ? 'success' : 'error');
    } catch (err) {
      setTestState('error');
      setTestResult({ success: false, error: String(err) });
    }
  };

  return (
    <ModalLayout
      header={
        <DialogHeader
          showCloseButton={!showBackButton}
          className="-mt-2 w-full flex-row items-center justify-between gap-2"
        >
          <div className={`flex items-center gap-2 ${showBackButton ? '-ml-2' : ''}`}>
            {showBackButton && (
              <Button variant="ghost" size="icon-xs" onClick={onClose}>
                <ArrowLeftIcon className="h-4 w-4" />
              </Button>
            )}
            <DialogTitle>
              {isEditing ? 'Edit Kubernetes Connection' : 'Add Kubernetes Connection'}
            </DialogTitle>
          </div>
        </DialogHeader>
      }
      footer={
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={handleTestConnection}
            disabled={testState === 'testing'}
          >
            {testState === 'testing' ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                Testing…
              </>
            ) : (
              'Test Connection'
            )}
          </Button>
          <div className="flex gap-2">
            {!showBackButton && (
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </Button>
            )}
            <ConfirmButton type="submit" form="add-k8s-conn-form" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save'
              )}
            </ConfirmButton>
          </div>
        </DialogFooter>
      }
    >
      <DialogContentArea className="max-h-[calc(100dvh-10rem)] overflow-y-auto">
        <form
          id="add-k8s-conn-form"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            {/* Connection name */}
            <form.Field name="name">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Connection Name</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={isInvalid}
                      placeholder="My Cluster"
                    />
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                );
              }}
            </form.Field>

            {/* Context */}
            <form.Field name="context">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Context</FieldLabel>
                    <Select
                      value={field.state.value || undefined}
                      onValueChange={(value) => {
                        if (!value) return;
                        field.handleChange(value);
                        // Selecting a new context invalidates the dependent fields.
                        form.setFieldValue('namespace', '');
                        form.setFieldValue('podName', '');
                        form.setFieldValue('containerName', '');
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                          {field.state.value ? (
                            <span className="truncate">{field.state.value}</span>
                          ) : (
                            <span className="text-muted-foreground">
                              {contextsQuery.isPending ? 'Loading contexts…' : 'Select a context'}
                            </span>
                          )}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {contexts.map((context) => (
                          <SelectItem key={context.name} value={context.name}>
                            <span className="truncate">{context.name}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {contextsQuery.error && (
                      <FieldDescription>
                        {contextsQuery.error instanceof Error
                          ? contextsQuery.error.message
                          : String(contextsQuery.error)}
                      </FieldDescription>
                    )}
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                );
              }}
            </form.Field>

            {/* Namespace — free-text with optional, best-effort suggestions */}
            <form.Subscribe selector={(state) => state.values.context}>
              {(context) => (
                <form.Field name="namespace">
                  {(field) => {
                    const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                    const disabled = !context;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>Namespace</FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          list="k8s-namespace-suggestions"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                          aria-invalid={isInvalid}
                          autoComplete="off"
                          placeholder={disabled ? 'Select a context first' : 'e.g. default'}
                          disabled={disabled}
                        />
                        <datalist id="k8s-namespace-suggestions">
                          {namespaces.map((namespace) => (
                            <option key={namespace} value={namespace} />
                          ))}
                        </datalist>
                        <FieldDescription>
                          {namespacesQuery.isFetching
                            ? 'Loading namespace suggestions…'
                            : namespacesQuery.error
                              ? 'Could not list namespaces (you may lack cluster-wide list permission) — type it in manually.'
                              : 'Type a namespace, or pick from suggestions.'}
                        </FieldDescription>
                        {isInvalid && <FieldError errors={field.state.meta.errors} />}
                      </Field>
                    );
                  }}
                </form.Field>
              )}
            </form.Subscribe>

            {/* Pod — free-text with optional, best-effort suggestions */}
            <form.Subscribe selector={(state) => state.values.namespace}>
              {(namespace) => (
                <form.Field name="podName">
                  {(field) => {
                    const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                    const disabled = !namespace;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>Pod</FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          list="k8s-pod-suggestions"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                          aria-invalid={isInvalid}
                          autoComplete="off"
                          placeholder={disabled ? 'Enter a namespace first' : 'e.g. my-pod'}
                          disabled={disabled}
                        />
                        <datalist id="k8s-pod-suggestions">
                          {pods.map((pod) => (
                            <option key={pod.name} value={pod.name}>
                              {pod.phase ? `${pod.name} (${pod.phase})` : pod.name}
                            </option>
                          ))}
                        </datalist>
                        <FieldDescription>
                          {podsQuery.isFetching
                            ? 'Loading pod suggestions…'
                            : podsQuery.error
                              ? 'Could not list pods — type the pod name manually.'
                              : 'Type a pod name, or pick from suggestions.'}
                        </FieldDescription>
                        {isInvalid && <FieldError errors={field.state.meta.errors} />}
                      </Field>
                    );
                  }}
                </form.Field>
              )}
            </form.Subscribe>

            {/* Container (optional) */}
            <form.Subscribe selector={(state) => state.values.podName}>
              {(podName) => (
                <form.Field name="containerName">
                  {(field) => {
                    const disabled = !podName;
                    return (
                      <Field>
                        <FieldLabel htmlFor={field.name}>Container</FieldLabel>
                        {containers.length > 0 ? (
                          <Select
                            value={field.state.value || undefined}
                            onValueChange={(value) => {
                              if (value) field.handleChange(value);
                            }}
                            disabled={disabled}
                          >
                            <SelectTrigger className="w-full">
                              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                {field.state.value ? (
                                  <span className="truncate">{field.state.value}</span>
                                ) : (
                                  <span className="text-muted-foreground">
                                    Default (first container)
                                  </span>
                                )}
                              </span>
                            </SelectTrigger>
                            <SelectContent>
                              {containers.map((container) => (
                                <SelectItem key={container} value={container}>
                                  <span className="truncate">{container}</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            id={field.name}
                            name={field.name}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                            placeholder="Optional (defaults to first container)"
                            disabled={disabled}
                          />
                        )}
                        <FieldDescription>
                          Leave empty to use the pod&apos;s first container.
                        </FieldDescription>
                      </Field>
                    );
                  }}
                </form.Field>
              )}
            </form.Subscribe>

            {/* tmux toggle (defaults ON for new k8s connections) */}
            <form.Field name="tmux">
              {(field) => (
                <Field className="flex-row items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                  <FieldLabel htmlFor={field.name}>
                    Use tmux (persists sessions across reconnects)
                  </FieldLabel>
                  <Switch
                    id={field.name}
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                  />
                </Field>
              )}
            </form.Field>

            {/* Terminal shell (defaults to /bin/sh) */}
            <form.Field name="shell">
              {(field) => {
                const shellLabels: Record<string, string> = {
                  sh: '/bin/sh',
                  bash: 'bash',
                  zsh: 'zsh',
                };
                return (
                  <Field>
                    <FieldLabel htmlFor={field.name}>Terminal shell</FieldLabel>
                    <Select
                      value={field.state.value}
                      onValueChange={(value) => {
                        if (value === 'sh' || value === 'bash' || value === 'zsh') {
                          field.handleChange(value);
                        }
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                          <span className="truncate">{shellLabels[field.state.value]}</span>
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sh">/bin/sh</SelectItem>
                        <SelectItem value="bash">bash</SelectItem>
                        <SelectItem value="zsh">zsh</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                );
              }}
            </form.Field>

            <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
              <CollapsibleTrigger
                type="button"
                className="flex h-8 w-full items-center justify-between rounded-md px-0 text-sm font-medium text-foreground-muted hover:text-foreground"
              >
                <span>Advanced</span>
                {isAdvancedOpen ? (
                  <ChevronUp className="size-4" />
                ) : (
                  <ChevronDown className="size-4" />
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-3 pt-2">
                <form.Field name="kubeconfigPath">
                  {(field) => (
                    <Field>
                      <FieldLabel htmlFor={field.name}>Kubeconfig Path</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => {
                          field.handleChange(e.target.value);
                          setKubeconfigPath(e.target.value);
                          // Changing the kubeconfig invalidates every discovered field.
                          form.setFieldValue('context', '');
                          form.setFieldValue('namespace', '');
                          form.setFieldValue('podName', '');
                          form.setFieldValue('containerName', '');
                        }}
                        placeholder="~/.kube/config"
                      />
                      <FieldDescription>
                        Leave empty to use the default kubeconfig discovery (KUBECONFIG or
                        ~/.kube/config).
                      </FieldDescription>
                    </Field>
                  )}
                </form.Field>
              </CollapsibleContent>
            </Collapsible>
          </FieldGroup>
        </form>
        {/* Test connection result */}
        {testState !== 'idle' && (
          <div className="border-input rounded-md border px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              {testState === 'testing' && (
                <LoaderCircle className="text-muted-foreground size-4 animate-spin" />
              )}
              {testState === 'success' && (
                <CheckCircle2 className="size-4 text-foreground-success" />
              )}
              {testState === 'error' && <XCircle className="text-destructive size-4" />}
              <span className="flex-1 font-medium">
                {testState === 'testing' && 'Testing connection…'}
                {testState === 'success' &&
                  'Connected' + (testResult?.latency ? ' (' + testResult.latency + 'ms)' : '')}
                {testState === 'error' && (testResult?.error ?? 'Connection failed')}
              </span>
              {testState === 'error' &&
                testResult?.debugLogs &&
                testResult.debugLogs.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowDebugLogs((v) => !v)}
                    className="text-muted-foreground flex items-center gap-1 text-xs hover:text-foreground"
                  >
                    {showDebugLogs ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                    Logs
                  </button>
                )}
            </div>
            {showDebugLogs && testResult?.debugLogs && (
              <pre className="bg-muted text-muted-foreground mt-2 max-h-32 overflow-y-auto rounded px-2 py-1.5 text-xs">
                {testResult.debugLogs.join('\n')}
              </pre>
            )}
          </div>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
}
