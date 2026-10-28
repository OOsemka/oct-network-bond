/**
 * One-click install of the Kubernetes NMState operator (redhat-operators,
 * stable channel) and its NMState instance. Runs as the logged-in console
 * user. Idempotent: existing objects are kept.
 */
import { K8sModel, K8sResourceCommon, k8sCreate, k8sGet, k8sListItems } from '@openshift-console/dynamic-plugin-sdk';

const model = (apiGroup: string | undefined, apiVersion: string, kind: string, plural: string, namespaced: boolean): K8sModel => ({
  ...(apiGroup ? { apiGroup } : {}),
  apiVersion,
  kind,
  plural,
  namespaced,
  abbr: kind.slice(0, 3).toUpperCase(),
  label: kind,
  labelPlural: `${kind}s`,
});

const NamespaceModel = model(undefined, 'v1', 'Namespace', 'namespaces', false);
const OperatorGroupModel = model('operators.coreos.com', 'v1', 'OperatorGroup', 'operatorgroups', true);
const SubscriptionModel = model('operators.coreos.com', 'v1alpha1', 'Subscription', 'subscriptions', true);
const ClusterServiceVersionModel = model('operators.coreos.com', 'v1alpha1', 'ClusterServiceVersion', 'clusterserviceversions', true);
const NMStateModel = model('nmstate.io', 'v1', 'NMState', 'nmstates', false);
const NodeNetworkStateModel = model('nmstate.io', 'v1beta1', 'NodeNetworkState', 'nodenetworkstates', false);
export const CustomResourceDefinitionModel = model('apiextensions.k8s.io', 'v1', 'CustomResourceDefinition', 'customresourcedefinitions', false);

/** CRD whose presence means the NMState operator is installed. */
export const NNS_CRD = 'nodenetworkstates.nmstate.io';

const NMSTATE_NS = 'openshift-nmstate';
const SUBSCRIPTION = 'kubernetes-nmstate-operator';

function code(err: unknown): number | undefined {
  const o = err as { json?: { code?: number }; status?: number; code?: number };
  return o?.json?.code ?? o?.status ?? o?.code;
}

export function isNotFound(err: unknown): boolean {
  if (code(err) === 404) return true;
  const o = err as { message?: string; json?: { message?: string } };
  const m = (o?.json?.message || o?.message || '').toLowerCase();
  return m.includes('not found') || m.includes('could not find the requested resource') || m.includes('no matches for kind');
}

export function nmstateErrorMessage(err: unknown): string {
  const o = err as { message?: string; json?: { message?: string } };
  return o?.json?.message || o?.message || String(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll(what: string, timeoutMs: number, everyMs: number, check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(everyMs);
  }
}

async function createOrKeep(m: K8sModel, data: K8sResourceCommon): Promise<void> {
  try {
    await k8sCreate({ model: m, data });
  } catch (e) {
    if (code(e) !== 409) throw e;
  }
}

export async function installNmstate(progress: (message: string) => void): Promise<void> {
  progress(`Creating namespace ${NMSTATE_NS}`);
  await createOrKeep(NamespaceModel, {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: NMSTATE_NS, labels: { 'openshift.io/cluster-monitoring': 'true' } },
  });
  progress('Creating OperatorGroup and Subscription');
  await createOrKeep(OperatorGroupModel, {
    apiVersion: 'operators.coreos.com/v1',
    kind: 'OperatorGroup',
    metadata: { name: NMSTATE_NS, namespace: NMSTATE_NS },
    spec: { targetNamespaces: [NMSTATE_NS] },
  } as K8sResourceCommon);
  await createOrKeep(SubscriptionModel, {
    apiVersion: 'operators.coreos.com/v1alpha1',
    kind: 'Subscription',
    metadata: { name: SUBSCRIPTION, namespace: NMSTATE_NS },
    spec: {
      channel: 'stable',
      name: SUBSCRIPTION,
      source: 'redhat-operators',
      sourceNamespace: 'openshift-marketplace',
      installPlanApproval: 'Automatic',
    },
  } as K8sResourceCommon);
  progress('Waiting for the NMState operator to install');
  await poll('the NMState operator', 15 * 60_000, 10_000, async () => {
    const sub = (await k8sGet({ model: SubscriptionModel, name: SUBSCRIPTION, ns: NMSTATE_NS })) as {
      status?: { installedCSV?: string };
    };
    if (!sub.status?.installedCSV) return false;
    try {
      const csv = (await k8sGet({ model: ClusterServiceVersionModel, name: sub.status.installedCSV, ns: NMSTATE_NS })) as {
        status?: { phase?: string };
      };
      return csv.status?.phase === 'Succeeded';
    } catch {
      return false;
    }
  });
  progress('Creating the NMState instance');
  await poll('the NMState API', 5 * 60_000, 5_000, async () => {
    try {
      await createOrKeep(NMStateModel, { apiVersion: 'nmstate.io/v1', kind: 'NMState', metadata: { name: 'nmstate' } });
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  });
  progress('Waiting for nodes to report their interfaces');
  await poll('NodeNetworkState reports', 10 * 60_000, 10_000, async () => {
    try {
      return (await k8sListItems({ model: NodeNetworkStateModel, queryParams: {} })).length > 0;
    } catch {
      return false;
    }
  });
}
