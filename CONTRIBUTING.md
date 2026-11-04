# Contributing to Network Bond

Thanks for helping. Network Bond is part of OpenShift Community Tools (OCT), a
community project that is not officially supported by Red Hat. Bug fixes, new
options and docs improvements are all welcome. For larger changes, open an
issue first so we can agree on the approach before you spend time on it.

## Setup

Requirements: Node.js 20 and Corepack (it provides the Yarn version pinned in
`package.json`).

```bash
corepack enable
yarn install
yarn verify    # type check, translation keys, repository rules, production build
```

The same checks run in GitHub Actions on every pull request. A pull request
can be merged when they pass and a maintainer has reviewed it.

## Test on your own cluster

Use a lab cluster you can afford to break. This plugin changes node networking
through NMState; a wrong bond can take a node off the network. Prefer spare
NICs that nothing else uses.

```bash
# Build and push to a registry you own (make the repository public, or add a pull secret)
podman build -t quay.io/<you>/oct-network-bond:dev -f Containerfile .
podman push quay.io/<you>/oct-network-bond:dev

# Deploy with your image instead of the released one
sed 's|quay.io/cjanisze/oct-network-bond:[^ ]*|quay.io/<you>/oct-network-bond:dev|' deploy/install.yaml | oc apply -f -

# Enable the plugin in the console (skip if the storefront already enabled it)
oc patch console.operator cluster --type=json \
  -p '[{"op":"add","path":"/spec/plugins/-","value":"oct-network-bond"}]'
```

The page is at **Community Tools → Network → Bond** (`/community-tools/network/bond`)
when the storefront is installed. After pushing a new `:dev` image, restart the
plugin pod (`oc rollout restart deploy/oct-network-bond -n oct-network-bond`)
and reload the console.

Not able to test on a cluster? Say so in the pull request and paste the
generated YAML from the page's YAML preview (or from `buildBondDesiredState`).
A maintainer tests it before the release.

## Rules

- **PatternFly 6** components only. Do not import PatternFly CSS; the console provides it.
- **Translations:** every UI string goes through `t('...')` and has an entry in
  `locales/en/plugin__oct-network-bond.json`. `yarn check-i18n --fix` adds missing ones.
- **No environment-specific values:** no hostnames, IPs, VLAN IDs, NIC or bond
  names, StorageClasses or tokens in code or docs. The page reads live cluster
  state (NodeNetworkState) and the user chooses.
- **Never take down the cluster network:** the bond that carries `br-ex` must
  never be changed or removed. Changes apply only to what the user selected.
- **Wording:** this is a community project; do not describe it as official Red Hat software.
- [AGENTS.md](AGENTS.md) describes the design in detail. It is also the guide
  for AI coding assistants, which are welcome; please review what they produce.

## Releases (maintainers)

Leave these to the maintainers. Do not change them in a pull request:

- the version in `package.json` (both places), README, AGENTS.md and `deploy/install.yaml`
- container images (`<version>-ocp4.22` and `-ocp4.21`, published tags are never overwritten)
- git tags and the storefront catalog rows

## License

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), the license of this project.
