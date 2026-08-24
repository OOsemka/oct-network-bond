# Network Bond — OCT extension

This is a **standalone ConsolePlugin** (`oct-network-bond`). It is **OpenShift Community Tools (OCT)**, a **community project, not officially supported by Red Hat**.

Do not add Community Tools category nav here. Users open this page from the storefront Network hub (**Open** / `/community-tools/network/bond`).

## Plugin ID

**`oct-network-bond`**. Old ID `community-network-bond` needs a cluster reinstall. Do not `oc apply` unless asked.

Image: `quay.io/<org>/oct-network-bond:1.0.0` (semver; optional `:1.0.0-ocp4.22`). Git: tags `v1.x.x`; `main` / optional `ocp-4.22` when PF/API differ. PatternFly 6 on 4.22.

## What this plugin owns

- Route `/community-tools/network/bond`
- NIC discovery from NodeNetworkState, grouping by MachineConfigPool
- Creating NodeNetworkConfigurationPolicy (implementation detail; UI says Network Bond)

## Storefront registration

Catalog PR against `oct-storefront` `catalog/community.yaml` (`source: community`, `category: network`, `spec.versions[]` with `version` + `openshift`).

## PatternFly 6

No PatternFly CSS imports. Prefix CSS `nb-` / existing `network-bond-`.

## Verify

```bash
yarn install
yarn build
```
