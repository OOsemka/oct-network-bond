/**
 * Per-node targeting and per-node static IPv4 addresses.
 *
 * A MachineConfigPool selects many nodes, but a static address belongs to one
 * node. When the user narrows the pools to some of their nodes, or assigns
 * static addresses, the tool writes one NodeNetworkConfigurationPolicy per
 * node, pinned with `kubernetes.io/hostname`. This module holds the address
 * arithmetic and the checks; it has no dependency on the page so it is the
 * same file in oct-network-bridge and oct-network-bond.
 */

export type NodeIpv4Message = {
  key: string;
  values?: Record<string, string>;
};

/** Minimal NodeNetworkState shape: interface addresses per node. */
export type NodeIpv4NnsLite = {
  metadata: { name: string };
  status?: {
    currentState?: {
      interfaces?: Array<{
        name?: string;
        ipv4?: { address?: Array<{ ip?: string }> };
      }>;
    };
  };
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export const HOSTNAME_LABEL = 'kubernetes.io/hostname';

export function isIpv4(value: string | undefined): boolean {
  return Boolean(value && IPV4.test(value.trim()));
}

/** Unsigned 32-bit value of a dotted IPv4 address, or undefined. */
export function ipv4ToInt(value: string | undefined): number | undefined {
  if (!isIpv4(value)) return undefined;
  return (
    value!
      .trim()
      .split('.')
      .reduce((acc, octet) => acc * 256 + parseInt(octet, 10), 0) >>> 0
  );
}

export function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
}

function maskFor(prefix: number): number {
  return prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** `a.b.c.d/p` network of an address. */
export function ipv4Subnet(address: string, prefix: number): string | undefined {
  const n = ipv4ToInt(address);
  if (n === undefined) return undefined;
  return `${intToIpv4((n & maskFor(prefix)) >>> 0)}/${prefix}`;
}

/** Nodes of the selected pools minus the ones the user left out, sorted. */
export function selectTargetNodes(poolNodeNames: string[], excludedNodeNames: string[]): string[] {
  const excluded = new Set(excludedNodeNames);
  return Array.from(new Set(poolNodeNames))
    .filter((n) => !excluded.has(n))
    .sort();
}

/**
 * Addresses counting up from `first`, one per node in the given order.
 * Stops (leaves the rest empty) instead of wrapping past 255.255.255.255.
 */
export function fillSequentialAddresses(first: string, nodeNames: string[]): Record<string, string> {
  const start = ipv4ToInt(first);
  const out: Record<string, string> = {};
  if (start === undefined) return out;
  nodeNames.forEach((node, i) => {
    if (start + i <= 0xffffffff) out[node] = intToIpv4(start + i);
  });
  return out;
}

/** One NNCP per node: hostname selectors, unique policy names. */
export function perNodeTargets(
  nodeNames: string[],
  policyBase: string,
  sanitize: (raw: string) => string,
): { nodeName: string; nodeSelector: Record<string, string>; policyName: string }[] {
  const used = new Set<string>();
  return nodeNames.map((nodeName) => {
    const base = sanitize(`${policyBase}-${nodeName}`);
    let policyName = base;
    // Long FQDNs can collide once sanitized/truncated; keep names unique. The
    // suffix replaces the tail so a length limit in sanitize cannot drop it.
    for (let i = 2; used.has(policyName); i++) {
      const suffix = `-${i}`;
      policyName = `${base.slice(0, Math.max(1, base.length - suffix.length))}${suffix}`;
    }
    used.add(policyName);
    return { nodeName, nodeSelector: { [HOSTNAME_LABEL]: nodeName }, policyName };
  });
}

export type NodeIpv4Check = {
  issues: NodeIpv4Message[];
  warnings: NodeIpv4Message[];
};

/**
 * Checks for static per-node addresses sharing one prefix length and an
 * optional gateway. Issues block Create; warnings do not.
 */
export function checkNodeAddresses(opts: {
  nodeNames: string[];
  addresses: Record<string, string>;
  prefixLength: number;
  gateway?: string;
  nns?: NodeIpv4NnsLite[];
}): NodeIpv4Check {
  const issues: NodeIpv4Message[] = [];
  const warnings: NodeIpv4Message[] = [];
  const prefix = opts.prefixLength;

  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) {
    issues.push({ key: 'Prefix length must be an integer from 1 to 32' });
    return { issues, warnings };
  }
  const gateway = opts.gateway?.trim() || '';
  if (gateway && !isIpv4(gateway)) {
    issues.push({ key: 'Enter a valid gateway IPv4 address, or leave it empty' });
    return { issues, warnings };
  }

  const valid: { node: string; ip: string }[] = [];
  for (const node of opts.nodeNames) {
    const ip = (opts.addresses[node] || '').trim();
    if (!isIpv4(ip)) {
      issues.push({ key: 'Enter a valid IPv4 address for {{node}}', values: { node } });
    } else {
      valid.push({ node, ip });
    }
  }

  const byIp = new Map<string, string[]>();
  for (const { node, ip } of valid) byIp.set(ip, [...(byIp.get(ip) || []), node]);
  byIp.forEach((nodes, ip) => {
    if (nodes.length > 1) {
      issues.push({
        key: '{{address}} is assigned to more than one node: {{nodes}}',
        values: { address: ip, nodes: nodes.join(', ') },
      });
    }
  });

  // /31 and /32 have no network or broadcast address.
  if (prefix <= 30) {
    for (const { node, ip } of valid) {
      const n = ipv4ToInt(ip)!;
      const mask = maskFor(prefix);
      if ((n & ~mask) >>> 0 === 0 || (n | ~mask) >>> 0 === n) {
        issues.push({
          key: '{{address}} ({{node}}) is the network or broadcast address of {{subnet}}',
          values: { address: ip, node, subnet: ipv4Subnet(ip, prefix)! },
        });
      }
    }
  }

  if (gateway) {
    const gwSubnet = ipv4Subnet(gateway, prefix)!;
    for (const { node, ip } of valid) {
      if (ip === gateway) {
        issues.push({
          key: '{{address}} ({{node}}) is the gateway address',
          values: { address: ip, node },
        });
      } else if (ipv4Subnet(ip, prefix) !== gwSubnet) {
        issues.push({
          key: '{{address}} ({{node}}) is not in the gateway subnet {{subnet}}',
          values: { address: ip, node, subnet: gwSubnet },
        });
      }
    }
  } else if (valid.length > 1) {
    const subnets = Array.from(new Set(valid.map(({ ip }) => ipv4Subnet(ip, prefix)!)));
    if (subnets.length > 1) {
      warnings.push({
        key: 'The node addresses are in different /{{prefix}} subnets: {{subnets}}',
        values: { prefix: String(prefix), subnets: subnets.join(', ') },
      });
    }
  }

  for (const use of addressesInUse(opts.nns || [], valid.map(({ ip }) => ip))) {
    warnings.push({
      key: '{{address}} is already configured on {{iface}} on node {{node}}',
      values: use,
    });
  }

  return { issues, warnings };
}

/** Where the given addresses are already configured, from NodeNetworkState. */
export function addressesInUse(
  nns: NodeIpv4NnsLite[],
  addresses: string[],
): { address: string; node: string; iface: string }[] {
  const wanted = new Set(addresses.map((a) => a.trim()));
  const found: { address: string; node: string; iface: string }[] = [];
  for (const item of nns) {
    for (const iface of item.status?.currentState?.interfaces || []) {
      for (const addr of iface.ipv4?.address || []) {
        if (addr.ip && wanted.has(addr.ip)) {
          found.push({ address: addr.ip, node: item.metadata.name, iface: iface.name || '?' });
        }
      }
    }
  }
  return found;
}
