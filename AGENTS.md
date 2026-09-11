# Network Bond — OCT extension

This is a **standalone ConsolePlugin** (`oct-network-bond`). It is **OpenShift Community Tools (OCT)**, a **community project, not officially supported by Red Hat**. Do not describe it as official Red Hat software.

Do not add Community Tools category nav here. Users open this page from the storefront Network hub (**Open** / `/community-tools/network/bond`).

## Identifiers

| | Value |
| --- | --- |
| Plugin ID / ConsolePlugin / `package.json` `consolePlugin.name` | **`oct-network-bond`** |
| Image | `quay.io/cjanisze/oct-network-bond:0.1.2-ocp4.22` (`<semver>-ocp<major.minor>`; optional aliases `:0.1.2` / `:4.22`) |
| Git | https://github.com/OOsemka/oct-network-bond |
| i18n | `plugin__oct-network-bond` |

Old ID `community-network-bond` needs a cluster reinstall. Do not `oc apply` unless asked.

Display name is **Network Bond**. No PVC or discovery sidecar.

**Current version:** `0.1.2` (package.json / consolePlugin.version).

## OpenShift and extension versions

Two axes in the catalog: git tag **`v1.x.x`** (semver) and optional branch **`ocp-X.Y`** when PatternFly or APIs diverge. Image tags **always** `<semver>-ocp<major.minor>` (e.g. `0.1.2-ocp4.22`). Storefront Add installs the newest stable semver compatible with the cluster; Update is explicit; one ConsolePlugin name runs one version.

- Git: `main` tracks the newest supported minor (currently **4.22**). Optional `ocp-4.22`, `ocp-4.21`. Tags `v1.0.0`, `v1.1.0`.
- Images: `oct-network-bond:0.1.2-ocp4.22` and `:0.1.2-ocp4.21`. **Always publish both** OpenShift minor tags (same digest if bits match). Catalog `versions[].image` must be the combined tag. Never catalog `:0.1.2` or `:4.22` as the install image unless that exact combined tag exists and is public.
- PatternFly 6 on 4.22; do not mix PF majors on one branch.

## What this plugin owns

- Route `/community-tools/network/bond`
- NIC discovery from NodeNetworkState, grouping by MachineConfigPool
- Creating NodeNetworkConfigurationPolicy (implementation detail; UI says Network Bond)
- Removing a bond: apply NNCP `state: absent` first (NMState does **not** drop a live bond when the create-NNCP is deleted). Wait for NNCE/NNCP SuccessfullyConfigured, then delete the policy. **Never** absent the bond (or parent interface) that `br-ex` uses — that is the OVN default network and taking it absent bricks the node. Protection is per apply-set: if any selected MCP/node has br-ex on that bond, Remove is disabled.

## Supported bond modes

| Type | Mode | Description | Warnings |
| --- | --- | --- | --- |
| Linux | `active-backup` (1) | Active-backup | Safe default |
| Linux | `balance-xor` (2) | XOR | Not recommended |
| Linux | `802.3ad` (4) | LACP | Requires switch support; exposes xmit hash policy |
| Linux | `balance-tlb` (5) | Adaptive transmit load balancing | Not recommended |
| Linux | `balance-alb` (6) | Adaptive load balancing | Not recommended |
| OVS | `balance-slb` | OVS source-load balancing | — |

- **Not-recommended warnings** are shown in the UI for `balance-xor`, `balance-tlb`, and `balance-alb`. The mode dropdown appends ⚠ to those labels and shows PatternFly warning HelperText.
- **LACP xmit hash policy** (802.3ad only): `layer2`, `layer2+3`, `layer3+4`. Hash policy FormSelect appears only when `bondMode === '802.3ad'`.
- **Single-NIC bond** is allowed but shows a warning ("single-NIC bond provides no redundancy").

## MachineConfigPool targeting

MCPs are watched cluster-wide. `buildMcpNicGroups` fingerprints physical NIC names per pool (identical vs mixed NICs). UI checkboxes only allow combining MCPs with the same NIC fingerprint. `planNncpTargets`: one covering `nodeSelector` for compact/SNO overlap; one NNCP per MCP when disjoint; per-hostname selectors to avoid double-apply when MCPs overlap.

## Navigation (React Router v6 via v5-compat)

Uses `useNavigate` from `react-router-dom-v5-compat` (^6.30.0). Breadcrumb and "Back to Network" navigate to `/community-tools/network`. NNCP deep links use plain `href` to the console k8s resource path, not `useNavigate`. Route registered at `/community-tools/network/bond` via `console-extensions.json`.

## Storefront registration

Catalog PR against `oct-storefront` `catalog/community.yaml` (`source: community`, `category: network`, `spec.git: https://github.com/OOsemka/oct-network-bond`, `spec.versions[]` with `version` + `openshift` + combined `image`). `spec.href` must stay `/community-tools/network/bond` unless `console-extensions.json` changes.

## Add must go Ready

Storefront **Add** can succeed while the plugin never becomes Ready (**Open** 404s). Follow **oct-storefront** `docs/extension-standard.md`: catalog `versions[].image` must be the **combined** tag `<semver>-ocp<major.minor>`, **exist**, and be **public** (no pull secret); do not list `:0.1.2` if only `:4.22` exists; include every required volume/RBAC/Service in the storefront bundle Add applies; confirm the plugin Deployment is Running. This plugin has no PVC or discovery sidecar.

## PatternFly 6

No PatternFly CSS imports. Prefix CSS `netbond-` / existing `network-bond-`.

## No environment-specific hardcoding

Never bake in lab networks, StorageClasses, hostnames, or similar. Bonds, VLANs, and interfaces come from the user’s form and live NMState — not from constants. See `.cursor/rules/oct-no-env-hardcoding.mdc`.

## Verify

```bash
yarn install
yarn build
```
