# Network Bond (OpenShift Community Tools)

**Community project. Not officially supported by Red Hat.**

Standalone OpenShift Console plugin that bonds physical NICs by MachineConfigPool using NMState NodeNetworkConfigurationPolicy.

Deleting a policy does **not** remove a live Linux bond. **Remove** applies `state: absent` first, waits for NMState, then deletes the policy. The bond that carries `br-ex` (cluster default network) cannot be removed.

- **Plugin ID:** `oct-network-bond`
- **Version:** `0.2.2`
- **Image:** `quay.io/cjanisze/oct-network-bond:0.2.2-ocp4.22` and `:0.2.2-ocp4.21` (`<semver>-ocp<major.minor>`; always publish both minors; aliases `:0.1.2` / `:4.22` may still exist)
- **Git:** https://github.com/OOsemka/oct-network-bond — `main` / optional `ocp-4.22` when PF/API differ; tags `v1.x.x`

Validated on OpenShift **4.22** (PatternFly 6). Open from **Community Tools → Network** after the storefront (`oct-storefront`) and this plugin are enabled.

Old plugin ID `community-network-bond` requires a reinstall.

## Supported bond modes

**Linux kernel bonds:**

| Mode | Name | Notes |
| --- | --- | --- |
| 1 | `active-backup` | Safe default. |
| 2 | `balance-xor` | XOR hash. Requires switch support: a static LAG (port-channel/EtherChannel with LACP disabled, e.g. `mode on`). UI warns "not recommended". Xmit hash policy: `layer2`, `layer2+3`, `layer3+4`, `vlan+srcmac`. |
| 4 | `802.3ad` (LACP) | Requires switch support. Xmit hash policy: `layer2`, `layer2+3`, `layer3+4`. |
| 5 | `balance-tlb` | Adaptive transmit LB. UI warns "not recommended". |
| 6 | `balance-alb` | Adaptive LB. UI warns "not recommended". |

**OVS bonds:** `balance-slb`. Creates an `ovs-bridge` named `br-<bond name>` (bond name up to 12 characters) whose bond port uses `mode: balance-slb`, with `allow-extra-patch-ports: true` so OVN localnet patch ports survive. Options:

- **Dynamic rebalancing interval** (`ovs-db.other_config.bond-rebalance-interval`, ms, OVS default `10000`). Tick **Disable dynamic rebalancing** to set `"0"`, which keeps each source MAC on its member NIC until a link fails.
- **IPv4:** L2 only (no IP), DHCP or static, the same as Linux bonds. With an IP, an internal `ovs-interface` named after the bridge carries it.
- miimon does not apply to OVS bonds and is hidden.

**Remove** on an OVS bond absents its bridge (and internal interface) and brings the NICs back up. It is blocked if the bridge carries `br-ex` or other ports still use it (for example OVN localnet patch ports).

- **Single-NIC bond** is allowed but shows a warning ("single-NIC bond provides no redundancy").
- **MachineConfigPool targeting:** MCPs fingerprinted by physical NIC names. Only MCPs with identical NIC sets can be combined. One NNCP per disjoint MCP; per-hostname selectors when MCPs overlap.
- **Node targeting and per-node static IPv4:** after picking pools, untick nodes to leave them out (down to a single node). Static IPv4 takes one address per selected node (shared prefix length and gateway, optional sequential fill) and creates one policy per node, pinned with `kubernetes.io/hostname`.

## Navigation

Uses `useNavigate` from `react-router-dom-v5-compat` (React Router v6 bridge). Route: `/community-tools/network/bond`.

```bash
yarn install
yarn build
```

Deploy: edit the image in `deploy/install.yaml`, `oc apply -f deploy/install.yaml` (only when asked), then enable `oct-network-bond` in `consoles.operator.openshift.io/cluster` `spec.plugins` (or use the storefront **Add** action).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): setup, `yarn verify`, testing on your own cluster and the project rules. Do **not** hardcode environment-specific values (VLAN IDs, CIDRs, lab bond names, StorageClasses, hostnames); the UI reads live NMState and the user supplies the bond. Agents: `.cursor/rules/oct-no-env-hardcoding.mdc`.

## NMState

The page needs the Kubernetes NMState operator. If it is not installed, the page offers a one-click install from `redhat-operators`.
