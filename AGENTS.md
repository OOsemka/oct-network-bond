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

Catalog PR against `oct-storefront` `catalog/community.yaml` (`source: community`, `category: network`, `spec.versions[]` with `version` + `openshift`). `spec.href` must stay `/community-tools/network/bond` unless `console-extensions.json` changes.

## Add must go Ready

Storefront **Add** can succeed while the plugin never becomes Ready (**Open** 404s). Follow **oct-storefront** `docs/extension-standard.md`: catalog `versions[].image` tag must **exist** and be **public** (no pull secret); publish the semver tag the catalog lists (do not list `:1.1.0` if only `:4.22` exists); include every required volume/RBAC/Service in the storefront bundle Add applies; confirm the plugin Deployment is Running.

## PatternFly 6

No PatternFly CSS imports. Prefix CSS `nb-` / existing `network-bond-`.

## Verify

```bash
yarn install
yarn build
```
