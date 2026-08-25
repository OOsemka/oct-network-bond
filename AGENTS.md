# Network Bond — OCT extension

This is a **standalone ConsolePlugin** (`oct-network-bond`). It is **OpenShift Community Tools (OCT)**, a **community project, not officially supported by Red Hat**. Do not describe it as official Red Hat software.

Do not add Community Tools category nav here. Users open this page from the storefront Network hub (**Open** / `/community-tools/network/bond`).

## Identifiers

| | Value |
| --- | --- |
| Plugin ID / ConsolePlugin / `package.json` `consolePlugin.name` | **`oct-network-bond`** |
| Image | `quay.io/cjanisze/oct-network-bond:1.1.0-ocp4.22` (`<semver>-ocp<major.minor>`; optional aliases `:1.1.0` / `:4.22`) |
| Git | https://github.com/OOsemka/oct-network-bond |
| i18n | `plugin__oct-network-bond` |

Old ID `community-network-bond` needs a cluster reinstall. Do not `oc apply` unless asked.

Display name is **Network Bond**. No PVC or discovery sidecar.

## OpenShift and extension versions

Two axes in the catalog: git tag **`v1.x.x`** (semver) and optional branch **`ocp-X.Y`** when PatternFly or APIs diverge. Image tags **always** `<semver>-ocp<major.minor>` (e.g. `1.1.0-ocp4.22`). Storefront Add installs the newest stable semver compatible with the cluster; Update is explicit; one ConsolePlugin name runs one version.

- Git: `main` tracks the newest supported minor (currently **4.22**). Optional `ocp-4.22`, `ocp-4.21`. Tags `v1.0.0`, `v1.1.0`.
- Images: `oct-network-bond:1.1.0-ocp4.22`. Catalog `versions[].image` must be that combined tag. Never catalog `:1.1.0` or `:4.22` as the install image unless that exact combined tag exists and is public.
- PatternFly 6 on 4.22; do not mix PF majors on one branch.

## What this plugin owns

- Route `/community-tools/network/bond`
- NIC discovery from NodeNetworkState, grouping by MachineConfigPool
- Creating NodeNetworkConfigurationPolicy (implementation detail; UI says Network Bond)

## Storefront registration

Catalog PR against `oct-storefront` `catalog/community.yaml` (`source: community`, `category: network`, `spec.git: https://github.com/OOsemka/oct-network-bond`, `spec.versions[]` with `version` + `openshift` + combined `image`). `spec.href` must stay `/community-tools/network/bond` unless `console-extensions.json` changes.

## Add must go Ready

Storefront **Add** can succeed while the plugin never becomes Ready (**Open** 404s). Follow **oct-storefront** `docs/extension-standard.md`: catalog `versions[].image` must be the **combined** tag `<semver>-ocp<major.minor>`, **exist**, and be **public** (no pull secret); do not list `:1.1.0` if only `:4.22` exists; include every required volume/RBAC/Service in the storefront bundle Add applies; confirm the plugin Deployment is Running. This plugin has no PVC or discovery sidecar.

## PatternFly 6

No PatternFly CSS imports. Prefix CSS `nb-` / existing `network-bond-`.

## Verify

```bash
yarn install
yarn build
```
