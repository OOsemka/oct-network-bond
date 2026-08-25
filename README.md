# Network Bond (OpenShift Community Tools)

**Community project. Not officially supported by Red Hat.**

Standalone OpenShift Console plugin that bonds physical NICs by MachineConfigPool using NMState NodeNetworkConfigurationPolicy.

- **Plugin ID:** `oct-network-bond`
- **Image:** `quay.io/cjanisze/oct-network-bond:1.1.0-ocp4.22` (`<semver>-ocp<major.minor>`; aliases `:1.1.0` / `:4.22` may still exist)
- **Git:** `main` / optional `ocp-4.22` when PF/API differ; tags `v1.x.x`

Validated on OpenShift **4.22** (PatternFly 6). Open from **Community Tools → Network** after the storefront (`oct-storefront`) and this plugin are enabled.

Old plugin ID `community-network-bond` requires a reinstall.

```bash
yarn install
yarn build
```

Deploy: edit the image in `deploy/install.yaml`, `oc apply -f deploy/install.yaml` (only when asked), then enable `oct-network-bond` in `consoles.operator.openshift.io/cluster` `spec.plugins` (or use the storefront **Add** action).
