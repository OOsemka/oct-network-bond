# Network Bond (OpenShift Community Tools)

**Community project. Not officially supported by Red Hat.**

Standalone OpenShift Console plugin that bonds physical NICs by MachineConfigPool using NMState NodeNetworkConfigurationPolicy.

Deleting a policy does **not** remove a live Linux bond. **Remove** applies `state: absent` first, waits for NMState, then deletes the policy. The bond that carries `br-ex` (cluster default network) cannot be removed.

- **Plugin ID:** `oct-network-bond`
- **Version:** `0.1.2`
- **Image:** `quay.io/cjanisze/oct-network-bond:0.1.2-ocp4.22` and `:0.1.2-ocp4.21` (`<semver>-ocp<major.minor>`; always publish both minors; aliases `:0.1.2` / `:4.22` may still exist)
- **Git:** https://github.com/OOsemka/oct-network-bond — `main` / optional `ocp-4.22` when PF/API differ; tags `v1.x.x`

Validated on OpenShift **4.22** (PatternFly 6). Open from **Community Tools → Network** after the storefront (`oct-storefront`) and this plugin are enabled.

Old plugin ID `community-network-bond` requires a reinstall.

## Supported bond modes

**Linux kernel bonds:**

| Mode | Name | Notes |
| --- | --- | --- |
| 0 | `balance-rr` | Round-robin. UI warns "not recommended" (packet reordering). |
| 1 | `active-backup` | Safe default. |
| 2 | `balance-xor` | XOR hash. |
| 3 | `broadcast` | UI warns "not recommended" (bandwidth waste). |
| 4 | `802.3ad` (LACP) | Requires switch support. Xmit hash policy: `layer2`, `layer2+3`, `layer3+4`. |
| 5 | `balance-tlb` | Adaptive transmit LB. |
| 6 | `balance-alb` | Adaptive LB. |

**OVS bonds:** `active-backup`, `balance-slb`.

- **Single-NIC bond** is allowed but shows a warning ("single-NIC bond provides no redundancy").
- **MachineConfigPool targeting:** MCPs fingerprinted by physical NIC names. Only MCPs with identical NIC sets can be combined. One NNCP per disjoint MCP; per-hostname selectors when MCPs overlap.

## Navigation

Uses `useNavigate` from `react-router-dom-v5-compat` (React Router v6 bridge). Route: `/community-tools/network/bond`.

```bash
yarn install
yarn build
```

Deploy: edit the image in `deploy/install.yaml`, `oc apply -f deploy/install.yaml` (only when asked), then enable `oct-network-bond` in `consoles.operator.openshift.io/cluster` `spec.plugins` (or use the storefront **Add** action).

## Contributing — cluster-portable code

Do **not** hardcode environment-specific values (VLAN IDs, CIDRs, lab bond names, StorageClasses, hostnames). The UI reads live NMState; the user supplies the bond. Agents: `.cursor/rules/oct-no-env-hardcoding.mdc`.
