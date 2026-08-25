/**
 * NIC discovery + NNCP generation for the Network Bond tool.
 * NodeNetworkConfigurationPolicy is an implementation detail; the UI talks about bonds.
 */

export type NodeRole = 'control-plane' | 'worker' | 'other';

export type BondMode =
  | '802.3ad'
  | 'active-backup'
  | 'balance-xor'
  | 'balance-tlb'
  | 'balance-alb';

export type Ipv4Mode = 'none' | 'dhcp' | 'static';

export type BondIpv4Config = {
  mode: Ipv4Mode;
  address?: string;
  prefixLength?: number;
  gateway?: string;
};

export type PhysicalNic = {
  id: string;
  nodeName: string;
  nodeRole: NodeRole;
  name: string;
  macAddress: string;
  state: string;
  speedMbps?: number;
  mtu?: number;
  controller?: string;
};

export type NodeKindLite = {
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
};

export type NmstateVlan = {
  'base-iface'?: string;
  id?: number;
};

export type NmstateBridgePort = {
  name?: string;
};

export type NmstateRoute = {
  destination?: string;
  'next-hop-address'?: string;
  'next-hop-interface'?: string;
  'table-id'?: number;
};

export type NmstateInterfaceStatus = {
  name?: string;
  type?: string;
  state?: string;
  'mac-address'?: string;
  mtu?: number;
  controller?: string;
  ethernet?: {
    speed?: number;
    'auto-negotiation'?: boolean;
    duplex?: string;
  };
  vlan?: NmstateVlan;
  bridge?: {
    port?: Array<NmstateBridgePort | string>;
  };
  'link-aggregation'?: {
    mode?: string;
    port?: string[];
    options?: Record<string, unknown>;
  };
  ipv4?: {
    enabled?: boolean;
    dhcp?: boolean;
    address?: Array<{ ip?: string; 'prefix-length'?: number }>;
  };
};

export type NodeNetworkStateKind = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
  };
  status?: {
    currentState?: {
      interfaces?: NmstateInterfaceStatus[];
      routes?: {
        running?: NmstateRoute[];
        config?: NmstateRoute[];
      };
    };
  };
};

export type NncpResource = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
  };
  spec: {
    nodeSelector: Record<string, string>;
    desiredState: Record<string, unknown>;
  };
};

export type K8sCondition = {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastHeartbeatTime?: string;
  lastTransitionTime?: string;
};

export type NncpDesiredInterface = {
  name?: string;
  type?: string;
  state?: string;
  'link-aggregation'?: {
    port?: string[];
  };
  vlan?: NmstateVlan;
};

/** Watched NNCP (looser than the policy we create). */
export type NncpKind = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
    generation?: number;
    resourceVersion?: string;
    uid?: string;
  };
  spec?: {
    nodeSelector?: Record<string, string>;
    desiredState?: {
      interfaces?: NncpDesiredInterface[];
    };
  };
  status?: {
    conditions?: K8sCondition[];
  };
};

/** Per-node apply of an NNCP. Name is `{node}.{policy}`; labels `nmstate.io/policy` + `nmstate.io/node`. */
export type NnceKind = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
  };
  status?: {
    policyGeneration?: number;
    conditions?: K8sCondition[];
  };
};

export type LabelSelector = {
  matchLabels?: Record<string, string>;
  matchExpressions?: Array<{
    key: string;
    operator: string;
    values?: string[];
  }>;
};

export type MachineConfigPoolKind = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
  };
  spec?: {
    paused?: boolean;
    machineConfigSelector?: LabelSelector;
    nodeSelector?: LabelSelector;
  };
  status?: {
    machineCount?: number;
    readyMachineCount?: number;
  };
};

export type PlanMessage = {
  key: string;
  values?: Record<string, string>;
};

export type NncpPlan = {
  policies: NncpResource[];
  strategy: 'mcp' | 'per-node';
  issues: PlanMessage[];
  warnings: PlanMessage[];
  targetNodeNames: string[];
  suggestedBondName?: string;
};

/** One MachineConfigPool plus the NIC fingerprint of its member nodes. */
export type McpNicGroup = {
  mcpName: string;
  nodeSelector: Record<string, string>;
  nodeNames: string[];
  /** Sorted physical ethernet names, joined by comma. Empty when mixed/unknown. */
  fingerprint: string;
  identical: boolean;
  mixed: boolean;
  missingNns: string[];
  noPhysicalNics: boolean;
};

/** One physical interface name across every targeted node (shared fingerprint). */
export type LayoutNic = {
  name: string;
  speedMbps?: number;
  speedMixed: boolean;
  state: string;
  stateMixed: boolean;
  enslavedControllers: string[];
  enslavedNodeCount: number;
  targetNodeCount: number;
};

const EXCLUDED_TYPES = new Set([
  'loopback',
  'bond',
  'linux-bridge',
  'ovs-bridge',
  'ovs-interface',
  'veth',
  'vlan',
  'vxlan',
  'geneve',
  'dummy',
  'mac-vlan',
  'macvlan',
  'mac-vtap',
  'tun',
  'tap',
  'vrf',
  'ipsec',
  'infiniband',
  'wifi',
]);

const EXCLUDED_NAME =
  /^(lo|veth|cali|flannel|cni|docker|tun|tap|geneve|ovn-|br-|vxlan|dummy|kube-|lxc|nodelocaldns|virbr)/i;

const LINUX_IFACE_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export const BOND_MODES: { value: BondMode; label: string }[] = [
  { value: '802.3ad', label: '802.3ad (LACP)' },
  { value: 'active-backup', label: 'Active-Backup' },
  { value: 'balance-xor', label: 'Balance XOR' },
  { value: 'balance-tlb', label: 'Balance TLB' },
  { value: 'balance-alb', label: 'Balance ALB' },
];

export function formatSpeed(mbps?: number): string {
  if (mbps === undefined || mbps <= 0) return '—';
  if (mbps >= 1000) return `${mbps / 1000} Gbps`;
  return `${mbps} Mbps`;
}

export function getK8sErrorMessage(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const obj = err as {
    message?: string;
    json?: { message?: string; code?: number };
    status?: number;
  };
  return obj.json?.message || obj.message || String(err);
}

export function getK8sErrorCode(err: unknown): number | undefined {
  const obj = err as { json?: { code?: number }; status?: number; code?: number };
  return obj.json?.code ?? obj.status ?? obj.code;
}

export function isMissingCrdError(err: unknown): boolean {
  const code = getK8sErrorCode(err);
  if (code === 404) return true;
  const msg = getK8sErrorMessage(err).toLowerCase();
  return (
    msg.includes('could not find the requested resource') ||
    msg.includes('no matches for kind') ||
    (msg.includes('nodenetworkstate') && msg.includes('not found'))
  );
}

export function isForbiddenError(err: unknown): boolean {
  const code = getK8sErrorCode(err);
  if (code === 403) return true;
  const msg = getK8sErrorMessage(err).toLowerCase();
  return msg.includes('forbidden') || msg.includes('cannot list resource');
}

export function nodeRoleFromLabels(labels?: Record<string, string>): NodeRole {
  if (!labels) return 'other';
  if (
    'node-role.kubernetes.io/control-plane' in labels ||
    'node-role.kubernetes.io/master' in labels
  ) {
    return 'control-plane';
  }
  if ('node-role.kubernetes.io/worker' in labels) return 'worker';
  return 'other';
}

export function isPhysicalEthernet(iface: NmstateInterfaceStatus): boolean {
  const name = iface.name || '';
  if (!name || EXCLUDED_NAME.test(name)) return false;
  const type = (iface.type || '').toLowerCase();
  if (EXCLUDED_TYPES.has(type)) return false;
  if (type && type !== 'ethernet') return false;
  return true;
}

export function physicalNicsFromNns(
  nnsList: NodeNetworkStateKind[],
  nodes: NodeKindLite[],
): PhysicalNic[] {
  const nodeByName = new Map(nodes.map((n) => [n.metadata.name, n]));
  const nics: PhysicalNic[] = [];

  for (const nns of nnsList) {
    const nodeName = nns.metadata.name;
    const node = nodeByName.get(nodeName);
    const role = nodeRoleFromLabels(node?.metadata.labels || nns.metadata.labels);
    const interfaces = nns.status?.currentState?.interfaces || [];

    for (const iface of interfaces) {
      if (!isPhysicalEthernet(iface) || !iface.name) continue;
      const speed = iface.ethernet?.speed;
      nics.push({
        id: `${nodeName}/${iface.name}`,
        nodeName,
        nodeRole: role,
        name: iface.name,
        macAddress: iface['mac-address'] || '—',
        state: iface.state || 'unknown',
        speedMbps: typeof speed === 'number' && speed > 0 ? speed : undefined,
        mtu: iface.mtu,
        controller: iface.controller,
      });
    }
  }

  nics.sort((a, b) => {
    const nodeCmp = a.nodeName.localeCompare(b.nodeName);
    if (nodeCmp !== 0) return nodeCmp;
    return a.name.localeCompare(b.name);
  });

  return nics;
}

export function validateBondName(name: string): PlanMessage | undefined {
  const trimmed = name.trim();
  if (!trimmed) return { key: 'Bond name is required' };
  if (trimmed.length > 15) return { key: 'Bond name must be 15 characters or fewer' };
  if (!LINUX_IFACE_NAME.test(trimmed)) {
    return {
      key: 'Bond name must start with a letter and use only letters, digits, underscore, or hyphen',
    };
  }
  if (trimmed === 'lo') return { key: 'Bond name cannot be lo' };
  return undefined;
}

export function validateIpv4(ipv4: BondIpv4Config): PlanMessage | undefined {
  if (ipv4.mode !== 'static') return undefined;
  if (!ipv4.address || !IPV4.test(ipv4.address.trim())) {
    return { key: 'Enter a valid IPv4 address' };
  }
  const prefix = ipv4.prefixLength ?? 24;
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) {
    return { key: 'Prefix length must be an integer from 1 to 32' };
  }
  if (ipv4.gateway && !IPV4.test(ipv4.gateway.trim())) {
    return { key: 'Enter a valid gateway IPv4 address, or leave it empty' };
  }
  return undefined;
}

export function validateMiimon(miimon: string): PlanMessage | undefined {
  const n = parseInt(miimon, 10);
  if (!Number.isInteger(n) || n < 0) return { key: 'miimon must be a non-negative integer' };
  return undefined;
}

export function fingerprintNicNames(names: string[]): string {
  return Array.from(new Set(names.filter(Boolean)))
    .sort()
    .join(',');
}

function nicsForNode(allNics: PhysicalNic[], nodeName: string): PhysicalNic[] {
  return allNics.filter((n) => n.nodeName === nodeName);
}

export function nodeMatchesSelector(
  labels: Record<string, string> | undefined,
  selector?: LabelSelector,
): boolean {
  if (!selector) return false;
  const nodeLabels = labels || {};
  const matchLabels = selector.matchLabels || {};
  const exprs = selector.matchExpressions || [];
  if (Object.keys(matchLabels).length === 0 && exprs.length === 0) return false;

  for (const [key, value] of Object.entries(matchLabels)) {
    if (nodeLabels[key] !== value) return false;
  }

  for (const expr of exprs) {
    const present = Object.prototype.hasOwnProperty.call(nodeLabels, expr.key);
    const val = nodeLabels[expr.key];
    const values = expr.values || [];
    switch (expr.operator) {
      case 'In':
        if (!present || !values.includes(val)) return false;
        break;
      case 'NotIn':
        if (present && values.includes(val)) return false;
        break;
      case 'Exists':
        if (!present) return false;
        break;
      case 'DoesNotExist':
        if (present) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

export function nodeMatchesNncpSelector(
  labels: Record<string, string> | undefined,
  nodeSelector?: Record<string, string>,
): boolean {
  if (!nodeSelector || Object.keys(nodeSelector).length === 0) return true;
  return nodeMatchesSelector(labels, { matchLabels: nodeSelector });
}

export function nodesForMcp(mcp: MachineConfigPoolKind, nodes: NodeKindLite[]): NodeKindLite[] {
  return nodes.filter((n) => nodeMatchesSelector(n.metadata.labels, mcp.spec?.nodeSelector));
}

function mcpSortKey(name: string): string {
  if (name === 'master') return '0-master';
  if (name === 'worker') return '1-worker';
  return `2-${name}`;
}

export function buildMcpNicGroups(
  mcps: MachineConfigPoolKind[],
  nodes: NodeKindLite[],
  allNics: PhysicalNic[],
  nnsNames: Set<string>,
): McpNicGroup[] {
  const groups = mcps.map((mcp) => {
    const mcpName = mcp.metadata.name;
    const matchLabels = mcp.spec?.nodeSelector?.matchLabels || {};
    const members = nodesForMcp(mcp, nodes);
    const nodeNames = members.map((n) => n.metadata.name).sort();
    const missingNns = nodeNames.filter((name) => !nnsNames.has(name));
    const fps = new Set<string>();
    let noPhysicalNics = nodeNames.length > 0 && missingNns.length === 0;

    for (const name of nodeNames) {
      if (!nnsNames.has(name)) continue;
      const names = nicsForNode(allNics, name).map((n) => n.name);
      const fp = fingerprintNicNames(names);
      fps.add(fp);
      if (fp) noPhysicalNics = false;
    }

    const identical =
      nodeNames.length > 0 && missingNns.length === 0 && fps.size === 1 && !fps.has('');
    const fingerprint = identical ? Array.from(fps)[0] : '';
    const mixed =
      nodeNames.length > 0 && missingNns.length === 0 && (fps.size > 1 || fps.has(''));

    return {
      mcpName,
      nodeSelector: { ...matchLabels },
      nodeNames,
      fingerprint,
      identical,
      mixed,
      missingNns,
      noPhysicalNics,
    };
  });

  groups.sort((a, b) => mcpSortKey(a.mcpName).localeCompare(mcpSortKey(b.mcpName)));
  return groups;
}

export function uniqueNodeNames(groups: McpNicGroup[]): string[] {
  return Array.from(new Set(groups.flatMap((g) => g.nodeNames))).sort();
}

function sameNodeSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((v, i) => v === bs[i]);
}

function pairwiseDisjoint(sets: string[][]): boolean {
  const seen = new Set<string>();
  for (const s of sets) {
    for (const n of s) {
      if (seen.has(n)) return false;
      seen.add(n);
    }
  }
  return true;
}

export function canSelectMcpWith(selected: McpNicGroup[], candidate: McpNicGroup): boolean {
  if (!candidate.identical) return false;
  if (selected.length === 0) return true;
  return selected.every((g) => g.identical && g.fingerprint === candidate.fingerprint);
}

export function isControlPlaneMcp(group: McpNicGroup): boolean {
  if (group.mcpName === 'master') return true;
  const keys = Object.keys(group.nodeSelector);
  return (
    keys.includes('node-role.kubernetes.io/master') ||
    keys.includes('node-role.kubernetes.io/control-plane')
  );
}

export function layoutNicsForNodes(
  allNics: PhysicalNic[],
  nodeNames: string[],
  nicNames: string[],
): LayoutNic[] {
  const target = new Set(nodeNames);
  const ordered = [...nicNames].sort();
  return ordered.map((name) => {
    const rows = allNics.filter((n) => n.name === name && target.has(n.nodeName));
    const speeds = Array.from(
      new Set(
        rows.map((n) => n.speedMbps).filter((s): s is number => typeof s === 'number' && s > 0),
      ),
    );
    const states = Array.from(new Set(rows.map((n) => n.state || 'unknown')));
    const enslaved = rows.filter((n) => n.controller);
    const controllers = Array.from(
      new Set(enslaved.map((n) => n.controller).filter((c): c is string => Boolean(c))),
    );
    return {
      name,
      speedMbps: speeds.length === 1 ? speeds[0] : undefined,
      speedMixed: speeds.length > 1,
      state: states.length === 1 ? states[0] : 'mixed',
      stateMixed: states.length > 1,
      enslavedControllers: controllers,
      enslavedNodeCount: enslaved.length,
      targetNodeCount: nodeNames.length,
    };
  });
}

export function existingBondNamesOnNodes(
  nnsList: NodeNetworkStateKind[],
  nodeNames: string[],
): Map<string, string[]> {
  const want = new Set(nodeNames);
  const out = new Map<string, string[]>();
  for (const nns of nnsList) {
    const nodeName = nns.metadata.name;
    if (!want.has(nodeName)) continue;
    const names = (nns.status?.currentState?.interfaces || [])
      .filter((iface) => (iface.type || '').toLowerCase() === 'bond' && iface.name)
      .map((iface) => iface.name as string);
    if (names.length) out.set(nodeName, names);
  }
  return out;
}

function nncpInterfaceNames(nncp: NncpKind): string[] {
  const ifaces = nncp.spec?.desiredState?.interfaces || [];
  return ifaces.map((i) => i.name).filter((n): n is string => Boolean(n));
}

export function nncpsDefiningNameForNodes(
  nncps: NncpKind[],
  nodes: NodeKindLite[],
  nodeNames: string[],
  interfaceName: string,
): string[] {
  const want = new Set(nodeNames);
  const nodeByName = new Map(nodes.map((n) => [n.metadata.name, n]));
  const hits: string[] = [];
  for (const nncp of nncps) {
    if (!nncpInterfaceNames(nncp).includes(interfaceName)) continue;
    const matches = Array.from(want).some((name) => {
      const node = nodeByName.get(name);
      return node ? nodeMatchesNncpSelector(node.metadata.labels, nncp.spec?.nodeSelector) : false;
    });
    if (matches) hits.push(nncp.metadata.name);
  }
  return hits.sort();
}

export function collectUsedBondNames(
  nnsList: NodeNetworkStateKind[],
  nncps: NncpKind[],
  nodes: NodeKindLite[],
  nodeNames: string[],
): Set<string> {
  const used = new Set<string>();
  Array.from(existingBondNamesOnNodes(nnsList, nodeNames).values()).forEach((names) => {
    names.forEach((n) => used.add(n));
  });
  const want = new Set(nodeNames);
  const nodeByName = new Map(nodes.map((n) => [n.metadata.name, n]));
  for (const nncp of nncps) {
    const applies = Array.from(want).some((name) => {
      const node = nodeByName.get(name);
      return node ? nodeMatchesNncpSelector(node.metadata.labels, nncp.spec?.nodeSelector) : false;
    });
    if (applies) nncpInterfaceNames(nncp).forEach((n) => used.add(n));
  }
  return used;
}

export function suggestBondName(used: Set<string>, preferred = 'bond0'): string {
  if (!used.has(preferred)) return preferred;
  for (let i = 1; i < 100; i += 1) {
    const candidate = `bond${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return 'bond99';
}

export type NncpTarget = {
  mcpName?: string;
  nodeSelector: Record<string, string>;
  nodeNames: string[];
};

/**
 * Cover selected MCP node sets exactly once.
 * Compact/SNO (same nodes in master+worker): one covering selector.
 * Disjoint pools (typical HA master vs worker): one NNCP per pool.
 * Partial overlap: per-hostname so the same bond is never applied twice.
 */
export function planNncpTargets(groups: McpNicGroup[]): {
  mode: 'mcp' | 'per-node';
  targets: NncpTarget[];
} {
  if (groups.length === 0) return { mode: 'mcp', targets: [] };
  const union = uniqueNodeNames(groups);
  const hasSelector = (g: McpNicGroup) => Object.keys(g.nodeSelector).length > 0;
  const covers = groups.filter((g) => sameNodeSet(g.nodeNames, union) && hasSelector(g));
  if (covers.length > 0) {
    const cover =
      covers.find((g) => g.mcpName === 'worker') ||
      covers.find((g) => 'node-role.kubernetes.io/worker' in g.nodeSelector) ||
      [...covers].sort((a, b) => a.mcpName.localeCompare(b.mcpName))[0];
    return {
      mode: 'mcp',
      targets: [
        {
          mcpName: cover.mcpName,
          nodeSelector: cover.nodeSelector,
          nodeNames: union,
        },
      ],
    };
  }
  if (pairwiseDisjoint(groups.map((g) => g.nodeNames)) && groups.every(hasSelector)) {
    return {
      mode: 'mcp',
      targets: groups.map((g) => ({
        mcpName: g.mcpName,
        nodeSelector: g.nodeSelector,
        nodeNames: g.nodeNames,
      })),
    };
  }
  return {
    mode: 'per-node',
    targets: union.map((nodeName) => ({
      nodeSelector: { 'kubernetes.io/hostname': nodeName },
      nodeNames: [nodeName],
    })),
  };
}

export function sanitizeK8sName(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 253);
  return s || 'netbond';
}

function ipv4Spec(ipv4: BondIpv4Config): Record<string, unknown> {
  if (ipv4.mode === 'dhcp') {
    return { enabled: true, dhcp: true };
  }
  if (ipv4.mode === 'static') {
    return {
      enabled: true,
      dhcp: false,
      address: [
        {
          ip: ipv4.address!.trim(),
          'prefix-length': ipv4.prefixLength ?? 24,
        },
      ],
    };
  }
  return { enabled: false };
}

export function buildBondDesiredState(opts: {
  bondName: string;
  bondMode: BondMode;
  miimon: string;
  ports: string[];
  ipv4: BondIpv4Config;
}): Record<string, unknown> {
  const uniquePorts = Array.from(new Set(opts.ports));
  const interfaces: Record<string, unknown>[] = [
    {
      name: opts.bondName,
      type: 'bond',
      state: 'up',
      ipv4: ipv4Spec(opts.ipv4),
      ipv6: { enabled: false },
      'link-aggregation': {
        mode: opts.bondMode,
        options: { miimon: String(opts.miimon) },
        port: uniquePorts,
      },
    },
    ...uniquePorts.map((port) => ({
      name: port,
      type: 'ethernet',
      state: 'up',
    })),
  ];

  const desired: Record<string, unknown> = { interfaces };

  if (opts.ipv4.mode === 'static' && opts.ipv4.gateway?.trim()) {
    desired.routes = {
      config: [
        {
          destination: '0.0.0.0/0',
          'next-hop-address': opts.ipv4.gateway.trim(),
          'next-hop-interface': opts.bondName,
          'table-id': 254,
        },
      ],
    };
  }

  return desired;
}

function buildNncp(opts: {
  name: string;
  nodeSelector: Record<string, string>;
  bondName: string;
  bondMode: BondMode;
  miimon: string;
  ports: string[];
  ipv4: BondIpv4Config;
}): NncpResource {
  return {
    apiVersion: 'nmstate.io/v1',
    kind: 'NodeNetworkConfigurationPolicy',
    metadata: {
      name: opts.name,
      labels: {
        'app.kubernetes.io/managed-by': 'oct-network-bond',
        'app.kubernetes.io/name': 'network-bond',
      },
    },
    spec: {
      nodeSelector: opts.nodeSelector,
      desiredState: buildBondDesiredState({
        bondName: opts.bondName,
        bondMode: opts.bondMode,
        miimon: opts.miimon,
        ports: opts.ports,
        ipv4: opts.ipv4,
      }),
    },
  };
}

/**
 * Plan NNCPs from selected MachineConfigPools and shared NIC names.
 * Deduplicates compact clusters where the same node is in master and worker.
 */
export function planMcpNncps(opts: {
  selectedGroups: McpNicGroup[];
  selectedPorts: string[];
  nodes: NodeKindLite[];
  nnsList: NodeNetworkStateKind[];
  nncps: NncpKind[];
  bondName: string;
  bondMode: BondMode;
  miimon: string;
  ipv4: BondIpv4Config;
  /** NNCP names created in this browser session — do not treat as a name conflict. */
  ignoreNncpNames?: string[];
  /** Bond interface names created in this browser session — do not treat as a name conflict. */
  ignoreBondNames?: string[];
}): NncpPlan {
  const issues: PlanMessage[] = [];
  const warnings: PlanMessage[] = [];
  const targetNodeNames = uniqueNodeNames(opts.selectedGroups);
  const usedNames = collectUsedBondNames(
    opts.nnsList,
    opts.nncps,
    opts.nodes,
    targetNodeNames,
  );
  const suggestedBondName = suggestBondName(usedNames);
  const empty: NncpPlan = {
    policies: [],
    strategy: 'mcp',
    issues,
    warnings,
    targetNodeNames,
    suggestedBondName,
  };

  const nameIssue = validateBondName(opts.bondName);
  if (nameIssue) issues.push(nameIssue);
  const miimonIssue = validateMiimon(opts.miimon);
  if (miimonIssue) issues.push(miimonIssue);
  const ipv4Issue = validateIpv4(opts.ipv4);
  if (ipv4Issue) issues.push(ipv4Issue);

  if (opts.selectedGroups.length === 0) {
    issues.push({ key: 'Select at least one MachineConfigPool' });
    return empty;
  }

  if (opts.selectedGroups.some((g) => !g.identical)) {
    issues.push({
      key: 'Selected pools must have identical physical NIC names on every node',
    });
    return empty;
  }

  const fingerprints = new Set(opts.selectedGroups.map((g) => g.fingerprint));
  if (fingerprints.size > 1) {
    issues.push({
      key: 'Selected MachineConfigPools have different NIC layouts and cannot be combined',
    });
    return empty;
  }

  const ports = Array.from(new Set(opts.selectedPorts.map((p) => p.trim()).filter(Boolean)));
  if (ports.length < 2) {
    issues.push({ key: 'Select at least two NICs' });
  }

  const bondName = opts.bondName.trim();
  if (bondName && ports.includes(bondName)) {
    issues.push({
      key: 'Bond name {{name}} collides with a selected interface',
      values: { name: bondName },
    });
  }

  const ignoreNncp = new Set(opts.ignoreNncpNames || []);
  const ignoreBond = new Set(opts.ignoreBondNames || []);
  const nodesWithBond: string[] = [];
  const existingBonds = existingBondNamesOnNodes(opts.nnsList, targetNodeNames);
  Array.from(existingBonds.entries()).forEach(([nodeName, names]) => {
    if (names.includes(bondName) && !ignoreBond.has(bondName)) nodesWithBond.push(nodeName);
  });
  const conflictingNncps = bondName
    ? nncpsDefiningNameForNodes(opts.nncps, opts.nodes, targetNodeNames, bondName).filter(
        (name) => !ignoreNncp.has(name),
      )
    : [];

  if (nodesWithBond.length > 0 || conflictingNncps.length > 0) {
    const values: Record<string, string> = {
      name: bondName,
      suggestion: suggestedBondName,
    };
    if (nodesWithBond.length > 0 && conflictingNncps.length > 0) {
      issues.push({
        key: 'Bond name {{name}} already exists on {{nodes}} and is defined by policy {{policies}}. Pick another name, for example {{suggestion}}.',
        values: {
          ...values,
          nodes: nodesWithBond.join(', '),
          policies: conflictingNncps.join(', '),
        },
      });
    } else if (nodesWithBond.length > 0) {
      issues.push({
        key: 'Bond name {{name}} already exists on {{nodes}}. Pick another name, for example {{suggestion}}.',
        values: { ...values, nodes: nodesWithBond.join(', ') },
      });
    } else {
      issues.push({
        key: 'Bond name {{name}} is already defined by policy {{policies}} for these nodes. Pick another name, for example {{suggestion}}.',
        values: { ...values, policies: conflictingNncps.join(', ') },
      });
    }
  }

  if (opts.selectedGroups.some(isControlPlaneMcp)) {
    warnings.push({
      key: 'Bonding NICs on control-plane nodes can disrupt cluster networking if you select the primary interface.',
    });
  }

  if (opts.ipv4.mode === 'static' && targetNodeNames.length > 1) {
    issues.push({
      key: 'Static IPv4 can only be applied when a single node is targeted. Use L2 only or DHCP for multiple nodes.',
    });
  }

  if (issues.length > 0) {
    return empty;
  }

  const { mode, targets } = planNncpTargets(opts.selectedGroups);
  const selectedMcpSuffix = opts.selectedGroups
    .map((g) => g.mcpName)
    .sort()
    .join('-');

  const policies = targets.map((target) => {
    let name: string;
    if (mode === 'per-node') {
      name = sanitizeK8sName(`${bondName}-${target.nodeNames[0]}`);
    } else if (targets.length === 1) {
      name = sanitizeK8sName(`${bondName}-${selectedMcpSuffix}`);
    } else {
      name = sanitizeK8sName(`${bondName}-${target.mcpName || 'node'}`);
    }
    return buildNncp({
      name,
      nodeSelector: target.nodeSelector,
      bondName,
      bondMode: opts.bondMode,
      miimon: opts.miimon,
      ports,
      ipv4: opts.ipv4,
    });
  });

  return {
    policies,
    strategy: mode,
    issues,
    warnings,
    targetNodeNames,
    suggestedBondName,
  };
}
