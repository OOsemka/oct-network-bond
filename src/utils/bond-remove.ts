/**
 * Clean bond removal for OpenShift NMState.
 *
 * Deleting a NodeNetworkConfigurationPolicy does **not** remove a live Linux bond.
 * The Kubernetes NMState operator applies each NNCP to matching nodes (the same
 * label grouping operators use for MachineConfigPools). Live state is
 * NodeNetworkState. To drop a bond you must apply `state: absent` first, wait for
 * the NNCP/NNCE to report SuccessfullyConfigured, then delete the policy so it
 * does not clutter the cluster. After a successful absent, deleting the NNCP does
 * not recreate the bond.
 *
 * Never absent the interface that carries `br-ex` (OVN default network). Taking
 * that uplink absent bricks the node. Lab NNS (az1): `br-ex` is an ovs-bridge
 * whose ports include VLAN `bond0.2102`; that VLAN's `base-iface` is `bond0`;
 * the default route next-hop-interface is `br-ex`.
 *
 * OVS bonds (balance-slb) are not top-level interfaces: they are ports with
 * `link-aggregation` on an ovs-bridge. Removing one absents the owning bridge
 * (and its internal ovs-interface, if any) and brings the member NICs back up.
 */

import {
  McpNicGroup,
  NnceKind,
  NncpDesiredInterface,
  NncpKind,
  NncpResource,
  NodeKindLite,
  NodeNetworkStateKind,
  NmstateInterfaceStatus,
  PlanMessage,
  OVS_BRIDGE_PREFIX,
  lagPortNames,
  nodeMatchesNncpSelector,
  ovsBondsInInterfaces,
  planNncpTargets,
  sanitizeK8sName,
  uniqueNodeNames,
  NncpTarget,
} from './network-bond';

export const BOND_TOOL_MANAGED_BY = new Set([
  'oct-network-bond',
  'openshift-baremetal-dashboard',
]);

export const BOND_TOOL_NAME_LABEL = 'network-bond';

export const NNCP_APPLY_TIMEOUT_MS = 180_000;
export const NNCP_APPLY_POLL_MS = 2_000;

const BR_EX = 'br-ex';

export type BondKind = 'linux' | 'ovs';

/** A bond found in NodeNetworkState or an NNCP desired state. */
export type BondRef = {
  name: string;
  kind: BondKind;
  /** OVS only: the ovs-bridge that owns the bond port. */
  bridge?: string;
  ports: string[];
  /** Bond state (Linux) or owning bridge state (OVS), lower-case. */
  state: string;
};

export type BondInventoryItem = {
  name: string;
  kind: BondKind;
  /** OVS only: owning bridge. */
  bridge?: string;
  ports: string[];
  /** Nodes whose NNS currently lists this bond. */
  nodeNames: string[];
  nncpNames: string[];
  managedByTool: boolean;
  inNns: boolean;
  /** Every matching NNCP already has this bond `state: absent`. */
  nncpAlreadyAbsent: boolean;
  /** Nodes in the removal apply-set where this iface is on the br-ex uplink chain. */
  brExNodeNames: string[];
  /** Non-slave dependents (VLAN, bridge, …) that would keep the bond in use. */
  dependentNames: string[];
  canRemove: boolean;
  blockReason?: PlanMessage;
};

export type BondRemovePlan = {
  bondName: string;
  desiredState: Record<string, unknown>;
  targetNodeNames: string[];
  patchPolicyNames: string[];
  createPolicies: NncpResource[];
  deletePolicyNames: string[];
  /** Skip NMState apply — bond already absent; only delete leftover NNCPs. */
  skipApply: boolean;
  issues: PlanMessage[];
  warnings: PlanMessage[];
};

function ifaceType(iface: { type?: string }): string {
  return (iface.type || '').toLowerCase();
}

function isLinuxBondIface(iface: { type?: string; 'link-aggregation'?: unknown }): boolean {
  const type = ifaceType(iface);
  if (type === 'ovs-bridge') return false;
  return type === 'bond' || Boolean(iface['link-aggregation']);
}

/**
 * Linux and OVS bonds in a list of interfaces. `managed` (an NNCP created by this
 * tool) also maps an absent `br-<name>` ovs-bridge back to OVS bond `<name>`,
 * because the absent payload carries no bridge ports.
 */
export function bondRefsInInterfaces(
  ifaces: Array<NmstateInterfaceStatus | NncpDesiredInterface>,
  opts: { managed?: boolean } = {},
): BondRef[] {
  const refs: BondRef[] = [];
  for (const iface of ifaces) {
    if (!iface.name || !isLinuxBondIface(iface)) continue;
    refs.push({
      name: iface.name,
      kind: 'linux',
      ports: lagPortNames(iface['link-aggregation']?.port),
      state: (iface.state || '').toLowerCase(),
    });
  }
  const ovs = ovsBondsInInterfaces(ifaces);
  for (const b of ovs) {
    refs.push({ name: b.name, kind: 'ovs', bridge: b.bridge, ports: b.ports, state: b.state });
  }
  if (opts.managed) {
    const bridgesWithBond = new Set(ovs.map((b) => b.bridge));
    for (const iface of ifaces) {
      const name = iface.name || '';
      if (
        ifaceType(iface) === 'ovs-bridge' &&
        (iface.state || '').toLowerCase() === 'absent' &&
        name.startsWith(OVS_BRIDGE_PREFIX) &&
        name.length > OVS_BRIDGE_PREFIX.length &&
        name !== BR_EX &&
        !bridgesWithBond.has(name)
      ) {
        refs.push({
          name: name.slice(OVS_BRIDGE_PREFIX.length),
          kind: 'ovs',
          bridge: name,
          ports: [],
          state: 'absent',
        });
      }
    }
  }
  return refs;
}

function nnsBondRef(nns: NodeNetworkStateKind, bondName: string): BondRef | undefined {
  return bondRefsInInterfaces(nnsInterfaces(nns)).find((b) => b.name === bondName);
}

function bridgePortNames(iface: NmstateInterfaceStatus): string[] {
  const ports = iface.bridge?.port || [];
  const names: string[] = [];
  for (const p of ports) {
    if (typeof p === 'string' && p) names.push(p);
    else if (p && typeof p === 'object' && p.name) names.push(p.name);
  }
  return names;
}

function nnsInterfaces(nns: NodeNetworkStateKind): NmstateInterfaceStatus[] {
  return nns.status?.currentState?.interfaces || [];
}

export function defaultRouteInterfaces(nns: NodeNetworkStateKind): string[] {
  const routes = nns.status?.currentState?.routes;
  const lists = [...(routes?.running || []), ...(routes?.config || [])];
  const names = lists
    .filter((r) => r.destination === '0.0.0.0/0' && r['next-hop-interface'])
    .map((r) => r['next-hop-interface'] as string);
  return Array.from(new Set(names));
}

/**
 * Interface names `br-ex` is built on, walking OVS/linux-bridge ports, VLAN
 * `base-iface`, and `controller`. Seeds from `br-ex` when present; also walks
 * the default-route next-hop when that hop is `br-ex` (or when `br-ex` is missing).
 */
export function brExUplinkChain(nns: NodeNetworkStateKind): Set<string> {
  const ifaces = nnsInterfaces(nns);
  const byName = new Map<string, NmstateInterfaceStatus[]>();
  for (const iface of ifaces) {
    if (!iface.name) continue;
    const list = byName.get(iface.name) || [];
    list.push(iface);
    byName.set(iface.name, list);
  }

  const seeds: string[] = [];
  if (byName.has(BR_EX)) seeds.push(BR_EX);
  for (const hop of defaultRouteInterfaces(nns)) {
    if (hop === BR_EX || !byName.has(BR_EX)) {
      if (!seeds.includes(hop)) seeds.push(hop);
    }
  }

  // Walk down from br-ex (and the default-route interface): its ports, VLAN
  // bases and bond members. Only the seeds climb to their controller, so a
  // bridge that merely shares a NIC with br-ex (e.g. another OVS bridge on
  // bond0) is not treated as part of br-ex.
  const chain = new Set<string>();
  const queue: Array<{ name: string; seed: boolean }> = seeds.map((name) => ({ name, seed: true }));
  while (queue.length > 0) {
    const { name, seed } = queue.pop() as { name: string; seed: boolean };
    if (!name || chain.has(name)) continue;
    chain.add(name);

    for (const iface of byName.get(name) || []) {
      for (const port of bridgePortNames(iface)) queue.push({ name: port, seed: false });
      const base = iface.vlan?.['base-iface'];
      if (base) queue.push({ name: base, seed: false });
      if (seed && iface.controller) queue.push({ name: iface.controller, seed: false });
    }

    for (const iface of ifaces) {
      if (iface.controller === name && iface.name) queue.push({ name: iface.name, seed: false });
    }
  }

  return chain;
}

/** Nodes where the bond (or, for OVS, its bridge) is on the br-ex uplink chain. */
export function brExCarrierBondNodes(
  nnsList: NodeNetworkStateKind[],
  bondName: string,
  nodeNames: string[],
  bridge?: string,
): string[] {
  const want = new Set(nodeNames);
  const hits: string[] = [];
  for (const nns of nnsList) {
    const node = nns.metadata.name;
    if (!want.has(node)) continue;
    const chain = brExUplinkChain(nns);
    const nodeBridge = bridge || nnsBondRef(nns, bondName)?.bridge;
    if (chain.has(bondName) || (nodeBridge && (nodeBridge === BR_EX || chain.has(nodeBridge)))) {
      hits.push(node);
    }
  }
  return hits.sort();
}

export function isManagedByBondTool(nncp: NncpKind): boolean {
  const labels = nncp.metadata.labels || {};
  if (BOND_TOOL_MANAGED_BY.has(labels['app.kubernetes.io/managed-by'] || '')) return true;
  return labels['app.kubernetes.io/name'] === BOND_TOOL_NAME_LABEL;
}

export function nncpBondRefs(nncp: NncpKind): BondRef[] {
  return bondRefsInInterfaces(nncp.spec?.desiredState?.interfaces || [], {
    managed: isManagedByBondTool(nncp),
  });
}

function nncpBondRef(nncp: NncpKind, bondName: string): BondRef | undefined {
  return nncpBondRefs(nncp).find((b) => b.name === bondName);
}

function nncpDefinesBond(nncp: NncpKind, bondName: string): boolean {
  return Boolean(nncpBondRef(nncp, bondName));
}

function nncpBondState(nncp: NncpKind, bondName: string): string {
  return nncpBondRef(nncp, bondName)?.state || '';
}

function nncpBondPorts(nncp: NncpKind, bondName: string): string[] {
  return nncpBondRef(nncp, bondName)?.ports || [];
}

export function nncpAppliesToAnyNode(
  nncp: NncpKind,
  nodes: NodeKindLite[],
  nodeNames: string[],
): boolean {
  const want = new Set(nodeNames);
  return nodes.some(
    (n) =>
      want.has(n.metadata.name) &&
      nodeMatchesNncpSelector(n.metadata.labels, nncp.spec?.nodeSelector),
  );
}

export function nodesMatchingNncp(nncp: NncpKind, nodes: NodeKindLite[]): string[] {
  return nodes
    .filter((n) => nodeMatchesNncpSelector(n.metadata.labels, nncp.spec?.nodeSelector))
    .map((n) => n.metadata.name)
    .sort();
}

function nnsBondPorts(nns: NodeNetworkStateKind, bondName: string): string[] {
  return nnsBondRef(nns, bondName)?.ports || [];
}

/**
 * VLANs, bridges, and other non-ethernet controllers that still use this bond.
 * Ethernet slaves are restored as standalone NICs, so they are not dependents.
 *
 * For an OVS bond the unit being removed is its bridge: anything else on the
 * bridge (other ports, OVN localnet patch ports) or built on its internal
 * interface is a dependent. The bridge's own internal ovs-interface is not.
 */
export function bondDependentsOnNode(nns: NodeNetworkStateKind, bondName: string): string[] {
  const names = new Set<string>();
  const ifaces = nnsInterfaces(nns);
  const ref = nnsBondRef(nns, bondName);

  if (ref?.kind === 'ovs' && ref.bridge) {
    const bridge = ref.bridge;
    const own = new Set([bondName, bridge]);
    for (const iface of ifaces) {
      if (!iface.name) continue;
      if (iface.name === bridge && ifaceType(iface) === 'ovs-bridge') {
        bridgePortNames(iface)
          .filter((p) => !own.has(p) && !ref.ports.includes(p))
          .forEach((p) => names.add(p));
        continue;
      }
      if (own.has(iface.name) || ifaceType(iface) === 'ethernet') continue;
      if (iface.vlan?.['base-iface'] === bridge) names.add(iface.name);
      if (bridgePortNames(iface).includes(bridge)) names.add(iface.name);
      if (iface.controller === bridge) names.add(iface.name);
    }
    return Array.from(names).sort();
  }

  for (const iface of ifaces) {
    if (!iface.name || iface.name === bondName) continue;
    const type = ifaceType(iface);
    if (type === 'ethernet') continue;
    if (iface.vlan?.['base-iface'] === bondName) names.add(iface.name);
    if (bridgePortNames(iface).includes(bondName)) names.add(iface.name);
    if (iface.controller === bondName) names.add(iface.name);
  }
  return Array.from(names).sort();
}

function extraAbsentFromNncp(
  nncp: NncpKind,
  bondName: string,
  bridge?: string,
): Array<{ name: string; type: string }> {
  const extra: Array<{ name: string; type: string }> = [];
  const own = new Set([bondName, bridge].filter(Boolean));
  for (const iface of nncp.spec?.desiredState?.interfaces || []) {
    if (!iface.name || own.has(iface.name)) continue;
    if (ifaceType(iface) === 'ethernet') continue;
    const base = iface.vlan?.['base-iface'];
    if (base === bondName || (bridge && base === bridge) || ifaceType(iface) === 'vlan') {
      extra.push({ name: iface.name, type: iface.type || 'vlan' });
    }
  }
  return extra;
}

export function buildAbsentBondDesiredState(opts: {
  bondName: string;
  ports: string[];
  extraAbsent?: Array<{ name: string; type: string }>;
  kind?: BondKind;
  /** OVS only: bridge to absent. */
  bridge?: string;
  /** OVS only: also absent the bridge's internal ovs-interface. */
  bridgeHasInternalIface?: boolean;
}): Record<string, unknown> {
  const ports = Array.from(new Set(opts.ports.filter(Boolean)));
  const extra = opts.extraAbsent || [];
  const seen = new Set<string>();
  const interfaces: Record<string, unknown>[] = [];

  for (const item of extra) {
    if (!item.name || seen.has(item.name)) continue;
    seen.add(item.name);
    interfaces.push({ name: item.name, type: item.type || 'vlan', state: 'absent' });
  }

  if (opts.kind === 'ovs' && opts.bridge) {
    if (opts.bridgeHasInternalIface) {
      interfaces.push({ name: opts.bridge, type: 'ovs-interface', state: 'absent' });
    }
    interfaces.push({ name: opts.bridge, type: 'ovs-bridge', state: 'absent' });
    seen.add(opts.bridge);
  } else {
    interfaces.push({
      name: opts.bondName,
      type: 'bond',
      state: 'absent',
    });
  }
  seen.add(opts.bondName);

  for (const port of ports) {
    if (seen.has(port)) continue;
    seen.add(port);
    interfaces.push({
      name: port,
      type: 'ethernet',
      state: 'up',
    });
  }

  return { interfaces };
}

function k8sCondition(
  conditions: { type?: string; status?: string; reason?: string; message?: string; lastHeartbeatTime?: string; lastTransitionTime?: string }[] | undefined,
  type: string,
) {
  return (conditions || []).find((c) => c.type === type);
}

export function nncpApplyOutcome(
  nncp: NncpKind,
  opts: { minGeneration: number; startedAtMs: number; nnces?: NnceKind[] },
): 'pending' | 'success' | 'failed' {
  const gen = nncp.metadata.generation ?? 0;
  const available = k8sCondition(nncp.status?.conditions, 'Available');
  const degraded = k8sCondition(nncp.status?.conditions, 'Degraded');
  const progressing = k8sCondition(nncp.status?.conditions, 'Progressing');

  if (degraded?.status === 'True') {
    const hb = Date.parse(degraded.lastHeartbeatTime || degraded.lastTransitionTime || '') || 0;
    if (hb >= opts.startedAtMs - 1000 || (degraded.reason || '').toLowerCase().includes('fail')) {
      return 'failed';
    }
  }

  const enactments = nncesForPolicy(opts.nnces || [], nncp.metadata.name);
  if (enactments.length > 0) {
    const failed = enactments.some((e) => {
      const failing = k8sCondition(e.status?.conditions, 'Failing');
      const eGen = e.status?.policyGeneration ?? 0;
      return failing?.status === 'True' && eGen >= opts.minGeneration;
    });
    if (failed) return 'failed';
    const allReady = enactments.every((e) => {
      const eGen = e.status?.policyGeneration ?? 0;
      const av = k8sCondition(e.status?.conditions, 'Available');
      return eGen >= opts.minGeneration && av?.status === 'True';
    });
    if (allReady) return 'success';
    return 'pending';
  }

  if (progressing?.status === 'True') return 'pending';

  if (
    gen >= opts.minGeneration &&
    available?.status === 'True' &&
    (available.reason === 'SuccessfullyConfigured' || !available.reason)
  ) {
    const hb = Date.parse(available.lastHeartbeatTime || available.lastTransitionTime || '') || 0;
    if (hb >= opts.startedAtMs - 2000) return 'success';
  }

  return 'pending';
}

export function nncpFailMessage(nncp: NncpKind): string {
  const degraded = k8sCondition(nncp.status?.conditions, 'Degraded');
  return degraded?.message || degraded?.reason || 'NMState failed to apply the absent policy';
}

export function nncesForPolicy(nnces: NnceKind[], policyName: string): NnceKind[] {
  return nnces.filter((e) => (e.metadata.labels || {})['nmstate.io/policy'] === policyName);
}

export function nnceProgressSummary(
  nnces: NnceKind[],
  policyName: string,
  minGeneration: number,
): { ready: number; total: number } {
  const list = nncesForPolicy(nnces, policyName);
  const ready = list.filter((e) => {
    const gen = e.status?.policyGeneration ?? 0;
    const available = k8sCondition(e.status?.conditions, 'Available');
    return gen >= minGeneration && available?.status === 'True';
  }).length;
  return { ready, total: list.length };
}

export function listBondInventory(opts: {
  nnsList: NodeNetworkStateKind[];
  nncps: NncpKind[];
  nodes: NodeKindLite[];
  /** Nodes in the UI scope (selected MCP members, or all NNS nodes). */
  scopeNodeNames: string[];
}): BondInventoryItem[] {
  const scope = new Set(opts.scopeNodeNames);
  const scopedNodes = opts.nodes.filter((n) => scope.has(n.metadata.name));
  const byName = new Map<
    string,
    {
      kind: BondKind;
      bridge?: string;
      ports: Set<string>;
      nodeNames: Set<string>;
      nncpNames: Set<string>;
      managedByTool: boolean;
      absentNncps: number;
      bondNncps: number;
    }
  >();

  const ensure = (ref: BondRef) => {
    const name = ref.name;
    let row = byName.get(name);
    if (!row) {
      row = {
        kind: ref.kind,
        bridge: ref.bridge,
        ports: new Set(),
        nodeNames: new Set(),
        nncpNames: new Set(),
        managedByTool: false,
        absentNncps: 0,
        bondNncps: 0,
      };
      byName.set(name, row);
    }
    if (ref.kind === 'ovs') {
      row.kind = 'ovs';
      row.bridge = row.bridge || ref.bridge;
    }
    return row;
  };

  for (const nns of opts.nnsList) {
    if (!scope.has(nns.metadata.name)) continue;
    for (const ref of bondRefsInInterfaces(nnsInterfaces(nns))) {
      const row = ensure(ref);
      row.nodeNames.add(nns.metadata.name);
      ref.ports.forEach((p) => row.ports.add(p));
    }
  }

  for (const nncp of opts.nncps) {
    if (!nncpAppliesToAnyNode(nncp, scopedNodes.length ? scopedNodes : opts.nodes, opts.scopeNodeNames)) {
      continue;
    }
    for (const ref of nncpBondRefs(nncp)) {
      const row = ensure(ref);
      row.nncpNames.add(nncp.metadata.name);
      row.bondNncps += 1;
      if (ref.state === 'absent') row.absentNncps += 1;
      if (isManagedByBondTool(nncp)) row.managedByTool = true;
      ref.ports.forEach((p) => row.ports.add(p));
    }
  }

  const items: BondInventoryItem[] = [];
  Array.from(byName.keys())
    .sort()
    .forEach((name) => {
      const row = byName.get(name)!;
      const nncpNames = Array.from(row.nncpNames).sort();
      const matching = opts.nncps.filter((n) => nncpNames.includes(n.metadata.name));
      const applyNodes = new Set<string>(row.nodeNames);
      if (matching.length === 0) {
        opts.scopeNodeNames.forEach((n) => applyNodes.add(n));
      } else {
        matching.forEach((nncp) => {
          nodesMatchingNncp(nncp, opts.nodes).forEach((n) => applyNodes.add(n));
        });
      }

      const brExNodeNames = brExCarrierBondNodes(
        opts.nnsList,
        name,
        Array.from(applyNodes),
        row.bridge,
      );
      const dependent = new Set<string>();
      for (const nns of opts.nnsList) {
        if (!applyNodes.has(nns.metadata.name) && !row.nodeNames.has(nns.metadata.name)) continue;
        bondDependentsOnNode(nns, name).forEach((d) => dependent.add(d));
      }
      const ourExtra = new Set<string>();
      matching.filter(isManagedByBondTool).forEach((nncp) => {
        extraAbsentFromNncp(nncp, name, row.bridge).forEach((e) => ourExtra.add(e.name));
      });
      const unmanagedDependents = Array.from(dependent)
        .filter((d) => !ourExtra.has(d))
        .sort();

      const inNns = row.nodeNames.size > 0;
      const nncpAlreadyAbsent = row.bondNncps > 0 && row.absentNncps === row.bondNncps;
      let blockReason: PlanMessage | undefined;
      if (brExNodeNames.length > 0) {
        blockReason = {
          key: 'Cannot remove {{name}}: it carries br-ex (cluster default network) on {{nodes}}.',
          values: { name, nodes: brExNodeNames.join(', ') },
        };
      } else if (unmanagedDependents.length > 0 && inNns) {
        blockReason = {
          key: 'Cannot remove {{name}}: VLAN or bridge dependents still use it ({{dependents}}). Remove those first.',
          values: { name, dependents: unmanagedDependents.join(', ') },
        };
      }

      items.push({
        name,
        kind: row.kind,
        bridge: row.bridge,
        ports: Array.from(row.ports).sort(),
        nodeNames: Array.from(row.nodeNames).sort(),
        nncpNames,
        managedByTool: row.managedByTool,
        inNns,
        nncpAlreadyAbsent,
        brExNodeNames,
        dependentNames: unmanagedDependents,
        canRemove: !blockReason,
        blockReason,
      });
    });

  return items;
}

function portsForBond(
  bondName: string,
  nnsList: NodeNetworkStateKind[],
  nncps: NncpKind[],
  nodeNames: string[],
): string[] {
  const ports = new Set<string>();
  const want = new Set(nodeNames);
  for (const nns of nnsList) {
    if (!want.has(nns.metadata.name)) continue;
    nnsBondPorts(nns, bondName).forEach((p) => ports.add(p));
  }
  for (const nncp of nncps) {
    nncpBondPorts(nncp, bondName).forEach((p) => ports.add(p));
  }
  return Array.from(ports).sort();
}

/**
 * Build the absent NNCP payload. Refuses if any node in the apply-set has br-ex
 * on this bond — including when another selected MCP does not use it.
 */
export function planBondRemoval(opts: {
  bondName: string;
  selectedGroups: McpNicGroup[];
  nodes: NodeKindLite[];
  nnsList: NodeNetworkStateKind[];
  nncps: NncpKind[];
  scopeNodeNames: string[];
}): BondRemovePlan {
  const bondName = opts.bondName.trim();
  const issues: PlanMessage[] = [];
  const warnings: PlanMessage[] = [];
  const empty: BondRemovePlan = {
    bondName,
    desiredState: { interfaces: [] },
    targetNodeNames: [],
    patchPolicyNames: [],
    createPolicies: [],
    deletePolicyNames: [],
    skipApply: false,
    issues,
    warnings,
  };

  if (!bondName) {
    issues.push({ key: 'Bond name is required' });
    return empty;
  }

  const matchingNncps = opts.nncps.filter((nncp) => {
    if (!nncpDefinesBond(nncp, bondName)) return false;
    return nncpAppliesToAnyNode(nncp, opts.nodes, opts.scopeNodeNames);
  });

  const applyNodes = new Set<string>();
  if (matchingNncps.length > 0) {
    matchingNncps.forEach((nncp) => {
      nodesMatchingNncp(nncp, opts.nodes).forEach((n) => applyNodes.add(n));
    });
  } else if (opts.selectedGroups.length > 0) {
    uniqueNodeNames(opts.selectedGroups).forEach((n) => applyNodes.add(n));
  } else {
    opts.scopeNodeNames.forEach((n) => applyNodes.add(n));
  }

  const targetNodeNames = Array.from(applyNodes).sort();

  // Linux or OVS? Prefer live state on the apply-set, then any matching policy.
  const nnsRefs = opts.nnsList
    .filter((nns) => applyNodes.has(nns.metadata.name))
    .map((nns) => nnsBondRef(nns, bondName))
    .filter((r): r is BondRef => Boolean(r));
  const ref: BondRef | undefined =
    nnsRefs[0] ||
    matchingNncps.map((n) => nncpBondRef(n, bondName)).find((r): r is BondRef => Boolean(r));
  const kind: BondKind = ref?.kind || 'linux';
  const bridge = kind === 'ovs' ? ref?.bridge : undefined;

  const brExNodes = brExCarrierBondNodes(opts.nnsList, bondName, targetNodeNames, bridge);
  if (brExNodes.length > 0) {
    issues.push({
      key: 'Cannot remove {{name}}: it carries br-ex (cluster default network) on {{nodes}}.',
      values: { name: bondName, nodes: brExNodes.join(', ') },
    });
    return { ...empty, targetNodeNames };
  }

  const dependent = new Set<string>();
  for (const nns of opts.nnsList) {
    if (!applyNodes.has(nns.metadata.name)) continue;
    bondDependentsOnNode(nns, bondName).forEach((d) => dependent.add(d));
  }
  const extraAbsent: Array<{ name: string; type: string }> = [];
  const extraNames = new Set<string>();
  matchingNncps.filter(isManagedByBondTool).forEach((nncp) => {
    extraAbsentFromNncp(nncp, bondName, bridge).forEach((e) => {
      if (!extraNames.has(e.name)) {
        extraNames.add(e.name);
        extraAbsent.push(e);
      }
    });
  });
  const unmanaged = Array.from(dependent).filter((d) => !extraNames.has(d));
  const stillInNns = nnsRefs.length > 0;

  if (unmanaged.length > 0 && stillInNns) {
    issues.push({
      key: 'Cannot remove {{name}}: VLAN or bridge dependents still use it ({{dependents}}). Remove those first.',
      values: { name: bondName, dependents: unmanaged.join(', ') },
    });
    return { ...empty, targetNodeNames };
  }

  const unmanagedPolicies = matchingNncps.filter((n) => !isManagedByBondTool(n));
  const stillPresentPolicies = matchingNncps.filter(
    (n) => nncpBondState(n, bondName) !== 'absent',
  );
  const foreignPresent = stillPresentPolicies.filter((n) => !isManagedByBondTool(n));
  if (foreignPresent.length > 0) {
    issues.push({
      key: 'Cannot remove {{name}}: policy {{policies}} still defines this bond and was not created by Network Bond.',
      values: {
        name: bondName,
        policies: foreignPresent.map((p) => p.metadata.name).join(', '),
      },
    });
    return { ...empty, targetNodeNames };
  }

  const ports = portsForBond(bondName, opts.nnsList, matchingNncps, targetNodeNames);
  const bridgeHasInternalIface =
    Boolean(bridge) &&
    (opts.nnsList.some(
      (nns) =>
        applyNodes.has(nns.metadata.name) &&
        nnsInterfaces(nns).some(
          (iface) => iface.name === bridge && ifaceType(iface) === 'ovs-interface',
        ),
    ) ||
      matchingNncps.some((nncp) =>
        (nncp.spec?.desiredState?.interfaces || []).some(
          (iface) => iface.name === bridge && ifaceType(iface) === 'ovs-interface',
        ),
      ));
  const desiredState = buildAbsentBondDesiredState({
    bondName,
    ports,
    extraAbsent,
    kind,
    bridge,
    bridgeHasInternalIface,
  });
  const alreadyAbsent =
    !stillInNns && matchingNncps.length > 0 && stillPresentPolicies.length === 0;

  if (unmanagedPolicies.length > 0 && alreadyAbsent) {
    warnings.push({
      key: 'Policy {{policies}} mentions {{name}} but was not created by this tool. Only leftover Network Bond policies will be deleted.',
      values: {
        policies: unmanagedPolicies.map((p) => p.metadata.name).join(', '),
        name: bondName,
      },
    });
  }

  const ours = matchingNncps.filter(isManagedByBondTool);
  const patchPolicyNames: string[] = [];
  const deletePolicyNames: string[] = [];
  const createPolicies: NncpResource[] = [];

  if (alreadyAbsent) {
    ours.forEach((n) => deletePolicyNames.push(n.metadata.name));
    return {
      bondName,
      desiredState,
      targetNodeNames,
      patchPolicyNames,
      createPolicies,
      deletePolicyNames,
      skipApply: true,
      issues,
      warnings,
    };
  }

  if (ours.length > 0) {
    ours.forEach((n) => {
      patchPolicyNames.push(n.metadata.name);
      deletePolicyNames.push(n.metadata.name);
    });
  } else {
    const groups = opts.selectedGroups.filter((g) => g.identical);
    let mode: 'mcp' | 'per-node';
    let targets: NncpTarget[];
    if (groups.length > 0) {
      const planned = planNncpTargets(groups);
      mode = planned.mode;
      targets = planned.targets;
    } else {
      mode = 'per-node';
      targets = targetNodeNames.map((nodeName) => ({
        nodeSelector: { 'kubernetes.io/hostname': nodeName },
        nodeNames: [nodeName],
      }));
    }

    if (targets.length === 0) {
      issues.push({ key: 'Select at least one MachineConfigPool' });
      return { ...empty, targetNodeNames };
    }

    const mcpSuffix = groups
      .map((g) => g.mcpName)
      .sort()
      .join('-');

    targets.forEach((target) => {
      let name: string;
      if (mode === 'per-node') {
        name = sanitizeK8sName(`${bondName}-absent-${target.nodeNames[0]}`);
      } else if (targets.length === 1) {
        name = sanitizeK8sName(`${bondName}-absent-${mcpSuffix || 'nodes'}`);
      } else {
        name = sanitizeK8sName(`${bondName}-absent-${target.mcpName || 'node'}`);
      }
      createPolicies.push({
        apiVersion: 'nmstate.io/v1',
        kind: 'NodeNetworkConfigurationPolicy',
        metadata: {
          name,
          labels: {
            'app.kubernetes.io/managed-by': 'oct-network-bond',
            'app.kubernetes.io/name': 'network-bond',
          },
        },
        spec: {
          nodeSelector: target.nodeSelector,
          desiredState,
        },
      });
      deletePolicyNames.push(name);
    });
  }

  return {
    bondName,
    desiredState,
    targetNodeNames,
    patchPolicyNames,
    createPolicies,
    deletePolicyNames,
    skipApply: false,
    issues,
    warnings,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
