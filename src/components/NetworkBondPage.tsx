import {
  K8sResourceCommon,
  DocumentTitle,
  ListPageHeader,
  k8sCreate,
  k8sDelete,
  k8sGet,
  k8sUpdate,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import {
  ActionGroup,
  Alert,
  Breadcrumb,
  BreadcrumbItem,
  Bullseye,
  Button,
  Card,
  CardBody,
  CardTitle,
  Checkbox,
  CodeBlock,
  CodeBlockCode,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  EmptyState,
  EmptyStateBody,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageSection,
  Radio,
  Spinner,
  Stack,
  StackItem,
  TextInput,
  Title,
} from '@patternfly/react-core';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import { NetworkIcon, ExclamationCircleIcon } from '@patternfly/react-icons';
import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  MachineConfigPoolModel,
  NodeModel,
  NodeNetworkStateModel,
  NodeNetworkConfigurationPolicyModel,
  NodeNetworkConfigurationEnactmentModel,
} from '../utils/k8s-resources';
import {
  BOND_MODES,
  BondIpv4Config,
  BondMode,
  Ipv4Mode,
  LayoutNic,
  MachineConfigPoolKind,
  McpNicGroup,
  NodeKindLite,
  NodeNetworkStateKind,
  NnceKind,
  NncpKind,
  buildMcpNicGroups,
  canSelectMcpWith,
  formatSpeed,
  getK8sErrorMessage,
  isForbiddenError,
  isMissingCrdError,
  layoutNicsForNodes,
  physicalNicsFromNns,
  planMcpNncps,
} from '../utils/network-bond';
import {
  BondInventoryItem,
  NNCP_APPLY_POLL_MS,
  NNCP_APPLY_TIMEOUT_MS,
  listBondInventory,
  nnceProgressSummary,
  nncpApplyOutcome,
  nncpFailMessage,
  planBondRemoval,
  sleep,
} from '../utils/bond-remove';
import { toYaml } from '../utils/yaml';
import dashboardLogger from '../utils/logger';
import CommunityDisclaimer from './CommunityDisclaimer';
import ExistingBondsCard from './ExistingBondsCard';

import './network-bond.css';

const LOG_ACTION = 'NETWORK_BOND';

const nncpConsolePath = (name: string) =>
  `/k8s/cluster/nmstate.io~v1~NodeNetworkConfigurationPolicy/${encodeURIComponent(name)}`;

const NetworkBondPage: FC = () => {
  const { t } = useTranslation('plugin__oct-network-bond');

  const [nnsList, nnsLoaded, nnsError] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: NodeNetworkStateModel.apiGroup,
      version: NodeNetworkStateModel.apiVersion,
      kind: NodeNetworkStateModel.kind,
    },
    isList: true,
    namespaced: false,
  });

  const [nodeList, nodesLoaded, nodesError] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: '',
      version: NodeModel.apiVersion,
      kind: NodeModel.kind,
    },
    isList: true,
    namespaced: false,
  });

  const [mcpList, mcpsLoaded, mcpError] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: MachineConfigPoolModel.apiGroup,
      version: MachineConfigPoolModel.apiVersion,
      kind: MachineConfigPoolModel.kind,
    },
    isList: true,
    namespaced: false,
  });

  const [nncpList, , nncpError] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: NodeNetworkConfigurationPolicyModel.apiGroup,
      version: NodeNetworkConfigurationPolicyModel.apiVersion,
      kind: NodeNetworkConfigurationPolicyModel.kind,
    },
    isList: true,
    namespaced: false,
  });

  const [nnceList] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: NodeNetworkConfigurationEnactmentModel.apiGroup,
      version: NodeNetworkConfigurationEnactmentModel.apiVersion,
      kind: NodeNetworkConfigurationEnactmentModel.kind,
    },
    isList: true,
    namespaced: false,
  });

  const [selectedMcpNames, setSelectedMcpNames] = useState<string[]>([]);
  const [selectedPorts, setSelectedPorts] = useState<string[]>([]);
  const [bondName, setBondName] = useState('bond0');
  const [bondMode, setBondMode] = useState<BondMode>('802.3ad');
  const [miimon, setMiimon] = useState('100');
  const [ipv4Mode, setIpv4Mode] = useState<Ipv4Mode>('none');
  const [ipAddress, setIpAddress] = useState('');
  const [prefixLength, setPrefixLength] = useState('24');
  const [gateway, setGateway] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ policyNames: string[]; bondName: string }>({
    policyNames: [],
    bondName: '',
  });
  const [removeTarget, setRemoveTarget] = useState<BondInventoryItem | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removePhase, setRemovePhase] = useState('');
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeSuccess, setRemoveSuccess] = useState<string | null>(null);

  const nodes = useMemo(() => (nodeList as NodeKindLite[]) || [], [nodeList]);
  const nns = useMemo(() => (nnsList as NodeNetworkStateKind[]) || [], [nnsList]);
  const mcps = useMemo(() => (mcpList as MachineConfigPoolKind[]) || [], [mcpList]);
  const nncps = useMemo(() => (nncpList as NncpKind[]) || [], [nncpList]);
  const nnces = useMemo(() => (nnceList as NnceKind[]) || [], [nnceList]);
  const nncesRef = useRef(nnces);
  nncesRef.current = nnces;

  const allNics = useMemo(() => physicalNicsFromNns(nns, nodes), [nns, nodes]);
  const nnsNames = useMemo(() => new Set(nns.map((item) => item.metadata.name)), [nns]);

  const mcpGroups = useMemo(
    () => buildMcpNicGroups(mcps, nodes, allNics, nnsNames),
    [mcps, nodes, allNics, nnsNames],
  );

  const selectedGroups = useMemo(
    () => mcpGroups.filter((g) => selectedMcpNames.includes(g.mcpName)),
    [mcpGroups, selectedMcpNames],
  );

  const selectedFingerprint = selectedGroups[0]?.identical ? selectedGroups[0].fingerprint : '';

  const scopeNodeNames = useMemo(() => {
    if (selectedGroups.length > 0) {
      return Array.from(new Set(selectedGroups.flatMap((g) => g.nodeNames))).sort();
    }
    return nns.map((item) => item.metadata.name).sort();
  }, [selectedGroups, nns]);

  const bondInventory = useMemo(
    () =>
      listBondInventory({
        nnsList: nns,
        nncps,
        nodes,
        scopeNodeNames,
      }),
    [nns, nncps, nodes, scopeNodeNames],
  );

  const removePlanPreview = useMemo(() => {
    if (!removeTarget) return null;
    return planBondRemoval({
      bondName: removeTarget.name,
      selectedGroups,
      nodes,
      nnsList: nns,
      nncps,
      scopeNodeNames,
    });
  }, [removeTarget, selectedGroups, nodes, nns, nncps, scopeNodeNames]);

  const createdNames = created.policyNames;
  const createdBondName = created.bondName;

  const clearCreated = useCallback(() => {
    setCreated({ policyNames: [], bondName: '' });
    setCreateError(null);
  }, []);

  useEffect(() => {
    setSelectedPorts([]);
    setCreated({ policyNames: [], bondName: '' });
    setCreateError(null);
  }, [selectedFingerprint]);

  const targetNodeNames = useMemo(
    () => Array.from(new Set(selectedGroups.flatMap((g) => g.nodeNames))).sort(),
    [selectedGroups],
  );

  const layoutNics: LayoutNic[] = useMemo(() => {
    if (!selectedFingerprint) return [];
    return layoutNicsForNodes(allNics, targetNodeNames, selectedFingerprint.split(','));
  }, [allNics, targetNodeNames, selectedFingerprint]);

  const ipv4: BondIpv4Config = useMemo(
    () => ({
      mode: ipv4Mode,
      address: ipAddress,
      prefixLength: parseInt(prefixLength, 10) || 24,
      gateway,
    }),
    [ipv4Mode, ipAddress, prefixLength, gateway],
  );

  const plan = useMemo(
    () =>
      planMcpNncps({
        selectedGroups,
        selectedPorts,
        nodes,
        nnsList: nns,
        nncps,
        bondName,
        bondMode,
        miimon,
        ipv4,
        ignoreNncpNames: createdNames,
        ignoreBondNames: createdBondName ? [createdBondName] : [],
      }),
    [
      selectedGroups,
      selectedPorts,
      nodes,
      nns,
      nncps,
      bondName,
      bondMode,
      miimon,
      ipv4,
      createdNames,
      createdBondName,
    ],
  );

  const previewYaml = useMemo(() => {
    if (plan.policies.length === 0) return '';
    return plan.policies
      .map((p) => toYaml(p as unknown as Parameters<typeof toYaml>[0]))
      .join('---\n');
  }, [plan.policies]);

  const toggleMcp = useCallback(
    (name: string, checked: boolean) => {
      setSelectedMcpNames((prev) => (checked ? [...prev, name] : prev.filter((x) => x !== name)));
      dashboardLogger.info(
        LOG_ACTION,
        'MCP selection changed',
        `${checked ? 'selected' : 'deselected'} ${name}`,
      );
      clearCreated();
    },
    [clearCreated],
  );

  const togglePort = useCallback(
    (name: string, checked: boolean) => {
      setSelectedPorts((prev) => (checked ? [...prev, name] : prev.filter((x) => x !== name)));
      dashboardLogger.info(
        LOG_ACTION,
        'NIC selection changed',
        `${checked ? 'selected' : 'deselected'} ${name}`,
      );
      clearCreated();
    },
    [clearCreated],
  );

  const goNetworkHub = () => {
    window.location.href = '/community-tools/network';
  };

  const handleCreate = useCallback(async () => {
    if (plan.policies.length === 0 || plan.issues.length > 0) return;
    setCreating(true);
    setCreateError(null);
    setCreated({ policyNames: [], bondName: '' });
    const policyNames = plan.policies.map((p) => p.metadata.name);
    dashboardLogger.info(
      LOG_ACTION,
      'Create started',
      `bond=${bondName.trim()} mode=${bondMode} nics=${selectedPorts.join(',')} policies=${policyNames.join(',')} nodes=${plan.targetNodeNames.join(',')}`,
    );

    const succeeded: string[] = [];
    try {
      for (const policy of plan.policies) {
        await k8sCreate({
          model: NodeNetworkConfigurationPolicyModel,
          data: policy as unknown as K8sResourceCommon,
        });
        succeeded.push(policy.metadata.name);
      }
      dashboardLogger.info(LOG_ACTION, 'Create succeeded', succeeded.join(', '));
      setCreated({ policyNames: succeeded, bondName: bondName.trim() });
    } catch (err) {
      const msg = getK8sErrorMessage(err);
      dashboardLogger.error(LOG_ACTION, 'Create failed', msg);
      const suffix =
        succeeded.length > 0
          ? ` ${t('Created before failure')}: ${succeeded.join(', ')}.`
          : '';
      setCreateError(`${msg}${suffix}`);
      if (succeeded.length > 0) {
        setCreated({ policyNames: succeeded, bondName: bondName.trim() });
      }
    } finally {
      setCreating(false);
    }
  }, [plan.policies, plan.issues.length, plan.targetNodeNames, bondName, bondMode, selectedPorts, t]);

  const handleCreateAnother = useCallback(() => {
    const nextName = plan.suggestedBondName || 'bond0';
    dashboardLogger.info(LOG_ACTION, 'Create another bond', `next=${nextName}`);
    clearCreated();
    setBondName(nextName);
  }, [plan.suggestedBondName, clearCreated]);

  const waitForNncpApply = useCallback(
    async (name: string, minGeneration: number, startedAtMs: number) => {
      const deadline = Date.now() + NNCP_APPLY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const nncp = (await k8sGet({
          model: NodeNetworkConfigurationPolicyModel,
          name,
        })) as NncpKind;
        const outcome = nncpApplyOutcome(nncp, {
          minGeneration,
          startedAtMs,
          nnces: nncesRef.current,
        });
        const progress = nnceProgressSummary(nncesRef.current, name, minGeneration);
        if (progress.total > 0) {
          setRemovePhase(
            t('Waiting for NMState to apply {{name}} ({{ready}}/{{total}} nodes)...', {
              name,
              ready: String(progress.ready),
              total: String(progress.total),
            }),
          );
        } else {
          setRemovePhase(t('Waiting for NMState to apply {{name}}...', { name }));
        }
        if (outcome === 'success') return;
        if (outcome === 'failed') {
          throw new Error(nncpFailMessage(nncp));
        }
        await sleep(NNCP_APPLY_POLL_MS);
      }
      throw new Error(t('Timed out waiting for NMState to apply {{name}}', { name }));
    },
    [t],
  );

  const closeRemoveModal = useCallback(() => {
    if (removing) return;
    setRemoveTarget(null);
    setRemoveError(null);
  }, [removing]);

  const handleRemove = useCallback(
    async (item: BondInventoryItem) => {
      const plan = planBondRemoval({
        bondName: item.name,
        selectedGroups,
        nodes,
        nnsList: nns,
        nncps,
        scopeNodeNames,
      });
      if (plan.issues.length > 0) {
        const msg = plan.issues.map((issue) => t(issue.key, issue.values)).join(' ');
        dashboardLogger.warn(LOG_ACTION, 'Remove blocked', msg);
        setRemoveError(msg);
        return;
      }

      setRemoving(true);
      setRemoveError(null);
      setRemoveSuccess(null);
      dashboardLogger.info(
        LOG_ACTION,
        'Remove started',
        `bond=${item.name} patch=${plan.patchPolicyNames.join(',')} create=${plan.createPolicies
          .map((p) => p.metadata.name)
          .join(',')} delete=${plan.deletePolicyNames.join(',')} skipApply=${plan.skipApply}`,
      );

      try {
        const applied: string[] = [];
        if (!plan.skipApply) {
          for (const name of plan.patchPolicyNames) {
            setRemovePhase(t('Setting {{name}} to absent...', { name: item.name }));
            const current = (await k8sGet({
              model: NodeNetworkConfigurationPolicyModel,
              name,
            })) as NncpKind;
            const updated = (await k8sUpdate({
              model: NodeNetworkConfigurationPolicyModel,
              data: {
                ...current,
                spec: {
                  ...(current.spec || {}),
                  nodeSelector: current.spec?.nodeSelector || {},
                  desiredState: plan.desiredState,
                },
              } as unknown as K8sResourceCommon,
            })) as NncpKind;
            const gen = updated.metadata.generation ?? (current.metadata.generation || 0) + 1;
            applied.push(updated.metadata.name);
            await waitForNncpApply(updated.metadata.name, gen, Date.now());
          }

          for (const policy of plan.createPolicies) {
            setRemovePhase(t('Setting {{name}} to absent...', { name: item.name }));
            const createdPolicy = (await k8sCreate({
              model: NodeNetworkConfigurationPolicyModel,
              data: policy as unknown as K8sResourceCommon,
            })) as NncpKind;
            const gen = createdPolicy.metadata.generation ?? 1;
            applied.push(createdPolicy.metadata.name);
            await waitForNncpApply(createdPolicy.metadata.name, gen, Date.now());
          }
        }

        dashboardLogger.info(
          LOG_ACTION,
          'Absent applied',
          applied.length > 0 ? applied.join(',') : 'skipped',
        );

        for (const name of plan.deletePolicyNames) {
          setRemovePhase(t('Deleting policy {{name}}...', { name }));
          await k8sDelete({
            model: NodeNetworkConfigurationPolicyModel,
            resource: {
              apiVersion: 'nmstate.io/v1',
              kind: 'NodeNetworkConfigurationPolicy',
              metadata: { name },
            },
          });
        }

        dashboardLogger.info(
          LOG_ACTION,
          'Remove succeeded',
          `bond=${item.name} policies=${plan.deletePolicyNames.join(',')}`,
        );
        setRemoveSuccess(
          plan.skipApply
            ? t('Deleted leftover policy for {{name}}.', { name: item.name })
            : t('Removed bond {{name}}.', { name: item.name }),
        );
        setRemoveTarget(null);
        setRemovePhase('');
      } catch (err) {
        const msg = getK8sErrorMessage(err);
        dashboardLogger.error(LOG_ACTION, 'Remove failed', msg);
        setRemoveError(msg);
      } finally {
        setRemoving(false);
      }
    },
    [selectedGroups, nodes, nns, nncps, scopeNodeNames, t, waitForNncpApply],
  );

  const requestRemove = useCallback((item: BondInventoryItem) => {
    setRemoveTarget(item);
    setRemoveError(null);
    setRemoveSuccess(null);
  }, []);

  const nnsReady = nnsLoaded || Boolean(nnsError);
  const nodesReady = nodesLoaded || Boolean(nodesError);
  const mcpsReady = mcpsLoaded || Boolean(mcpError);

  const stateColor = (state: string): 'green' | 'grey' | 'orange' => {
    const s = state.toLowerCase();
    if (s === 'up') return 'green';
    if (s === 'down') return 'grey';
    return 'orange';
  };

  const mcpHelper = (group: McpNicGroup): string => {
    const nodeCount = String(group.nodeNames.length);
    if (group.nodeNames.length === 0) return t('No nodes in this pool');
    if (group.noPhysicalNics) {
      return t('{{nodeCount}} nodes, no physical NICs (cannot use as a group)', { nodeCount });
    }
    if (group.missingNns.length > 0) {
      return t('{{nodeCount}} nodes, missing NIC data for some nodes (cannot use as a group)', {
        nodeCount,
      });
    }
    if (group.mixed) {
      return t('{{nodeCount}} nodes, mixed NIC layouts (cannot use as a group)', { nodeCount });
    }
    if (group.identical) {
      return t('{{nodeCount}} nodes, identical NICs ({{nics}})', {
        nodeCount,
        nics: group.fingerprint,
      });
    }
    return t('{{nodeCount}} nodes, mixed NIC layouts (cannot use as a group)', { nodeCount });
  };

  const enslavedLabel = (nic: LayoutNic): string | null => {
    if (nic.enslavedNodeCount === 0 || nic.enslavedControllers.length === 0) return null;
    const controller = nic.enslavedControllers.join(', ');
    if (nic.enslavedNodeCount === nic.targetNodeCount) {
      return `${t('Currently in')} ${controller}`;
    }
    return t('Currently in {{controller}} on {{enslaved}} of {{total}} nodes', {
      controller,
      enslaved: String(nic.enslavedNodeCount),
      total: String(nic.targetNodeCount),
    });
  };

  if (!nnsReady || !nodesReady || !mcpsReady) {
    return (
      <PageSection>
        <Bullseye>
          <Spinner size="xl" />
        </Bullseye>
      </PageSection>
    );
  }

  const renderDiscoveryError = (): React.ReactNode => {
    if (mcpError && isMissingCrdError(mcpError)) {
      return (
        <EmptyState
          titleText={t('MachineConfigPool resources are not available.')}
          icon={ExclamationCircleIcon}
          headingLevel="h2"
        >
          <EmptyStateBody>{getK8sErrorMessage(mcpError)}</EmptyStateBody>
        </EmptyState>
      );
    }
    if (mcpError && isForbiddenError(mcpError)) {
      return (
        <EmptyState
          titleText={t('You do not have permission to list MachineConfigPool resources.')}
          icon={ExclamationCircleIcon}
          headingLevel="h2"
        >
          <EmptyStateBody>{getK8sErrorMessage(mcpError)}</EmptyStateBody>
        </EmptyState>
      );
    }
    if (mcpError) {
      return (
        <Alert variant="danger" title={t('Failed to load MachineConfigPools')} isInline>
          {getK8sErrorMessage(mcpError)}
        </Alert>
      );
    }

    if (nnsError && isMissingCrdError(nnsError)) {
      return (
        <EmptyState
          titleText={t('NMState operator not found — NodeNetworkState is required to list NICs.')}
          icon={NetworkIcon}
          headingLevel="h2"
        >
          <EmptyStateBody>
            {t('Install the Kubernetes NMState operator to list physical NICs on cluster nodes.')}
          </EmptyStateBody>
        </EmptyState>
      );
    }

    if (nnsError && isForbiddenError(nnsError)) {
      return (
        <EmptyState
          titleText={t('You do not have permission to list NodeNetworkState resources.')}
          icon={ExclamationCircleIcon}
          headingLevel="h2"
        >
          <EmptyStateBody>{getK8sErrorMessage(nnsError)}</EmptyStateBody>
        </EmptyState>
      );
    }

    if (nnsError) {
      return (
        <Alert variant="danger" title={t('Failed to load NodeNetworkState')} isInline>
          {getK8sErrorMessage(nnsError)}
        </Alert>
      );
    }

    if (nns.length === 0) {
      return (
        <EmptyState
          titleText={t('No NodeNetworkState resources found')}
          icon={NetworkIcon}
          headingLevel="h2"
        >
          <EmptyStateBody>
            {t('The NMState operator is installed but has not reported interface state yet.')}
          </EmptyStateBody>
        </EmptyState>
      );
    }

    if (mcps.length === 0) {
      return (
        <EmptyState
          titleText={t('No MachineConfigPools found')}
          icon={NetworkIcon}
          headingLevel="h2"
        >
          <EmptyStateBody>
            {t('MachineConfigPools are required to group nodes that share a NIC layout.')}
          </EmptyStateBody>
        </EmptyState>
      );
    }

    return null;
  };

  const discoveryError = renderDiscoveryError();
  const mixedGroups = mcpGroups.filter((g) => g.mixed || g.missingNns.length > 0 || g.noPhysicalNics);
  const showBondForm = !discoveryError;

  return (
    <>
      <DocumentTitle>{t('Network Bond')}</DocumentTitle>

      <PageSection type="breadcrumb">
        <Breadcrumb>
          <BreadcrumbItem
            component="a"
            onClick={(e) => {
              e.preventDefault();
              goNetworkHub();
            }}
          >
            {t('Network')}
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{t('Network Bond')}</BreadcrumbItem>
        </Breadcrumb>
      </PageSection>

      <ListPageHeader title={t('Network Bond')} />

      <PageSection>
        <Stack hasGutter>
          <StackItem>
            <CommunityDisclaimer />
          </StackItem>
          <StackItem>
            <p className="netbond-lead">
              {t(
                'Select MachineConfigPools that share the same physical NIC names. Compact clusters often list the same nodes in master and worker; choosing both still creates one bond policy.',
              )}
            </p>
            <p className="netbond-lead">
              {t(
                'NMState applies each policy to matching nodes (the same grouping as MachineConfigPools). Deleting a policy does not remove a live bond — Remove sets the bond to absent first. The bond that carries br-ex (cluster default network) cannot be removed.',
              )}
            </p>
          </StackItem>

          {nodesError && (
            <StackItem>
              <Alert variant="warning" title={t('Could not list Kubernetes Nodes')} isInline>
                {t('Node membership for each pool may be incomplete.')}{' '}
                {getK8sErrorMessage(nodesError)}
              </Alert>
            </StackItem>
          )}

          {nncpError && (
            <StackItem>
              <Alert
                variant="warning"
                title={t('Could not list existing network policies')}
                isInline
              >
                {t('Bond name uniqueness against existing policies cannot be checked.')}{' '}
                {getK8sErrorMessage(nncpError)}
              </Alert>
            </StackItem>
          )}

          {discoveryError ? (
            <StackItem>{discoveryError}</StackItem>
          ) : (
            <StackItem>
              <Card>
                <CardTitle>
                  <Title headingLevel="h2">{t('MachineConfigPools')}</Title>
                </CardTitle>
                <CardBody>
                  <Stack hasGutter>
                    {mixedGroups.length > 0 && (
                      <StackItem>
                        <Alert
                          variant="warning"
                          title={t('Some pools have mixed NIC layouts')}
                          isInline
                        >
                          {t(
                            'A MachineConfigPool can be used as a group only when every node in it has the same physical ethernet interface names. Mixed pools are disabled.',
                          )}
                        </Alert>
                      </StackItem>
                    )}
                    <StackItem>
                      <Form>
                        <FormGroup
                          label={t('Apply this bond to')}
                          fieldId="netbond-mcps"
                          isRequired
                        >
                          <div className="netbond-mcp-list">
                            {mcpGroups.map((group) => {
                              const compatible = canSelectMcpWith(selectedGroups, group);
                              const checked = selectedMcpNames.includes(group.mcpName);
                              const disabled = !checked && !compatible;
                              const description = !group.identical
                                ? mcpHelper(group)
                                : !compatible
                                  ? t('Different NIC layout than the selected pool(s)')
                                  : mcpHelper(group);
                              return (
                                <Checkbox
                                  key={group.mcpName}
                                  id={`netbond-mcp-${group.mcpName}`}
                                  className="netbond-mcp-item"
                                  label={group.mcpName}
                                  description={description}
                                  isChecked={checked}
                                  isDisabled={disabled}
                                  onChange={(_event, isChecked) =>
                                    toggleMcp(group.mcpName, Boolean(isChecked))
                                  }
                                />
                              );
                            })}
                          </div>
                          <FormHelperText>
                            <HelperText>
                              <HelperTextItem>
                                {t(
                                  'Multiple pools can be selected only when they share the same physical NIC names. The same node is never bonded twice.',
                                )}
                              </HelperTextItem>
                            </HelperText>
                          </FormHelperText>
                        </FormGroup>
                      </Form>
                    </StackItem>
                  </Stack>
                </CardBody>
              </Card>
            </StackItem>
          )}

          {showBondForm && (
            <StackItem>
              <ExistingBondsCard
                items={bondInventory}
                busyName={removing ? removeTarget?.name || null : null}
                onRemove={requestRemove}
              />
            </StackItem>
          )}

          {removeSuccess && (
            <StackItem>
              <Alert variant="success" title={t('Bond removed')} isInline isLiveRegion>
                {removeSuccess}
              </Alert>
            </StackItem>
          )}

          {showBondForm && selectedFingerprint && (
            <StackItem>
              <Card>
                <CardTitle>
                  <Title headingLevel="h2">{t('Select NICs to Bond')}</Title>
                </CardTitle>
                <CardBody>
                  {layoutNics.length === 0 ? (
                    <EmptyState
                      titleText={t('No physical NICs found')}
                      icon={NetworkIcon}
                      headingLevel="h2"
                    >
                      <EmptyStateBody>
                        {t(
                          'No ethernet interfaces were found on master or worker nodes after filtering virtual and CNI devices.',
                        )}
                      </EmptyStateBody>
                    </EmptyState>
                  ) : (
                    <Stack hasGutter>
                      <StackItem>
                        <p className="netbond-lead">
                          {t(
                            'These interface names exist on every targeted node. Check the NICs to include in the bond.',
                          )}
                        </p>
                      </StackItem>
                      <StackItem>
                        <div className="netbond-table-wrap">
                          <Table aria-label={t('Select NICs to Bond')} variant="compact">
                            <Thead>
                              <Tr>
                                <Th screenReaderText={t('Select')} />
                                <Th>{t('Interface')}</Th>
                                <Th>{t('State')}</Th>
                                <Th>{t('Speed')}</Th>
                              </Tr>
                            </Thead>
                            <Tbody>
                              {layoutNics.map((nic) => {
                                const enslaved = enslavedLabel(nic);
                                return (
                                  <Tr key={nic.name}>
                                    <Td>
                                      <Checkbox
                                        id={`netbond-nic-${nic.name}`}
                                        isChecked={selectedPorts.includes(nic.name)}
                                        onChange={(_event, checked) =>
                                          togglePort(nic.name, Boolean(checked))
                                        }
                                        aria-label={`${t('Select')} ${nic.name}`}
                                      />
                                    </Td>
                                    <Td dataLabel={t('Interface')}>
                                      {nic.name}
                                      {enslaved && (
                                        <div className="netbond-enslaved">{enslaved}</div>
                                      )}
                                    </Td>
                                    <Td dataLabel={t('State')}>
                                      <Label isCompact color={stateColor(nic.state)}>
                                        {nic.stateMixed ? t('mixed') : nic.state}
                                      </Label>
                                    </Td>
                                    <Td dataLabel={t('Speed')}>
                                      {nic.speedMixed
                                        ? t('mixed')
                                        : formatSpeed(nic.speedMbps)}
                                    </Td>
                                  </Tr>
                                );
                              })}
                            </Tbody>
                          </Table>
                        </div>
                        <FormHelperText>
                          <HelperText>
                            <HelperTextItem>
                              {t('Select at least two NICs. The same names are bonded on every targeted node.')}
                            </HelperTextItem>
                          </HelperText>
                        </FormHelperText>
                      </StackItem>
                    </Stack>
                  )}
                </CardBody>
              </Card>
            </StackItem>
          )}

          {showBondForm && !selectedFingerprint && selectedMcpNames.length === 0 && (
            <StackItem>
              <Alert variant="info" title={t('Select a MachineConfigPool')} isInline>
                {t('Choose one or more pools with identical NICs to see the bond picker.')}
              </Alert>
            </StackItem>
          )}

          {showBondForm && (
            <StackItem>
              <Card>
                <CardTitle>
                  <Title headingLevel="h2">{t('Bond settings')}</Title>
                </CardTitle>
                <CardBody>
                  <Form>
                    <FormGroup label={t('Bond Name')} fieldId="netbond-name" isRequired>
                      <TextInput
                        id="netbond-name"
                        value={bondName}
                        onChange={(_event, value) => {
                          setBondName(value);
                          clearCreated();
                        }}
                        maxLength={15}
                      />
                      <FormHelperText>
                        <HelperText>
                          <HelperTextItem>
                            {t('Linux interface name, up to 15 characters.')}
                          </HelperTextItem>
                        </HelperText>
                      </FormHelperText>
                    </FormGroup>

                    <FormGroup label={t('Bond Mode')} fieldId="netbond-mode">
                      <FormSelect
                        id="netbond-mode"
                        value={bondMode}
                        onChange={(_event, value) => setBondMode(value as BondMode)}
                      >
                        {BOND_MODES.map((m) => (
                          <FormSelectOption key={m.value} value={m.value} label={t(m.label)} />
                        ))}
                      </FormSelect>
                    </FormGroup>

                    <FormGroup label={t('miimon')} fieldId="netbond-miimon">
                      <TextInput
                        id="netbond-miimon"
                        value={miimon}
                        onChange={(_event, value) => setMiimon(value)}
                        type="number"
                      />
                      <FormHelperText>
                        <HelperText>
                          <HelperTextItem>
                            {t('Link monitoring interval in milliseconds.')}
                          </HelperTextItem>
                        </HelperText>
                      </FormHelperText>
                    </FormGroup>

                    <FormGroup label={t('IPv4')} fieldId="netbond-ipv4" role="radiogroup">
                      <Radio
                        id="netbond-ipv4-none"
                        name="netbond-ipv4"
                        label={t('L2 only (no IP)')}
                        isChecked={ipv4Mode === 'none'}
                        onChange={() => setIpv4Mode('none')}
                      />
                      <Radio
                        id="netbond-ipv4-dhcp"
                        name="netbond-ipv4"
                        label={t('DHCP')}
                        isChecked={ipv4Mode === 'dhcp'}
                        onChange={() => setIpv4Mode('dhcp')}
                      />
                      <Radio
                        id="netbond-ipv4-static"
                        name="netbond-ipv4"
                        label={t('Static')}
                        isChecked={ipv4Mode === 'static'}
                        onChange={() => setIpv4Mode('static')}
                      />
                      <FormHelperText>
                        <HelperText>
                          <HelperTextItem>
                            {t(
                              'Create a bond without an IP address. Attach IPs later with a NAD or a follow-up policy.',
                            )}
                          </HelperTextItem>
                        </HelperText>
                      </FormHelperText>
                    </FormGroup>

                    {ipv4Mode === 'static' && (
                      <>
                        <FormGroup label={t('IP Address')} fieldId="netbond-ip" isRequired>
                          <TextInput
                            id="netbond-ip"
                            value={ipAddress}
                            onChange={(_event, value) => setIpAddress(value)}
                            placeholder="192.168.1.10"
                          />
                        </FormGroup>
                        <FormGroup label={t('Prefix Length')} fieldId="netbond-prefix" isRequired>
                          <TextInput
                            id="netbond-prefix"
                            value={prefixLength}
                            onChange={(_event, value) => setPrefixLength(value)}
                            type="number"
                          />
                        </FormGroup>
                        <FormGroup label={t('Gateway')} fieldId="netbond-gw">
                          <TextInput
                            id="netbond-gw"
                            value={gateway}
                            onChange={(_event, value) => setGateway(value)}
                            placeholder="192.168.1.1"
                          />
                          <FormHelperText>
                            <HelperText>
                              <HelperTextItem>{t('Optional default gateway')}</HelperTextItem>
                            </HelperText>
                          </FormHelperText>
                        </FormGroup>
                      </>
                    )}
                  </Form>
                </CardBody>
              </Card>
            </StackItem>
          )}

          {showBondForm && (
            <StackItem>
              <Card>
                <CardTitle>
                  <Title headingLevel="h2">{t('Review')}</Title>
                </CardTitle>
                <CardBody>
                  <Stack hasGutter>
                    {plan.warnings.map((w) => (
                      <StackItem key={w.key}>
                        <Alert variant="warning" title={t('Warning')} isInline>
                          {t(w.key, w.values)}
                        </Alert>
                      </StackItem>
                    ))}
                    {createdNames.length === 0 &&
                      plan.issues.map((issue) => (
                        <StackItem key={issue.key + JSON.stringify(issue.values || {})}>
                          <Alert variant="danger" isInline title={t(issue.key, issue.values)}>
                            {issue.values?.suggestion ? (
                              <Button
                                variant="link"
                                isInline
                                onClick={() => setBondName(issue.values!.suggestion)}
                              >
                                {t('Use {{name}}', { name: issue.values.suggestion })}
                              </Button>
                            ) : null}
                          </Alert>
                        </StackItem>
                      ))}

                    <StackItem>
                      <DescriptionList isHorizontal columnModifier={{ default: '2Col' }}>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Pools')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {selectedMcpNames.length > 0 ? selectedMcpNames.join(', ') : '—'}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Target nodes')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {plan.targetNodeNames.length > 0
                              ? `${plan.targetNodeNames.length}: ${plan.targetNodeNames.join(', ')}`
                              : '—'}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Bond Name')}</DescriptionListTerm>
                          <DescriptionListDescription>{bondName || '—'}</DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Bond Mode')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {BOND_MODES.find((m) => m.value === bondMode)?.label || bondMode}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('IPv4')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {ipv4Mode === 'none'
                              ? t('L2 only (no IP)')
                              : ipv4Mode === 'dhcp'
                                ? t('DHCP')
                                : `${ipAddress}/${prefixLength}`}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Selected NICs')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {selectedPorts.length > 0 ? selectedPorts.join(', ') : '—'}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Policies to create')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {plan.strategy === 'mcp'
                              ? plan.policies.length <= 1
                                ? t('One policy for the selected pool(s)')
                                : t('One policy per selected pool')
                              : t('One policy per node')}
                            {plan.policies.length > 0 ? ` (${plan.policies.length})` : ''}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                      </DescriptionList>
                    </StackItem>

                    {previewYaml && (
                      <StackItem>
                        <Title headingLevel="h3">{t('YAML preview')}</Title>
                        <div className="netbond-review-yaml">
                          <CodeBlock>
                            <CodeBlockCode>{previewYaml}</CodeBlockCode>
                          </CodeBlock>
                        </div>
                      </StackItem>
                    )}

                    {createError && (
                      <StackItem>
                        <Alert variant="danger" title={t('Failed to create bond')} isInline>
                          {createError}
                        </Alert>
                      </StackItem>
                    )}

                    {createdNames.length > 0 && (
                      <StackItem>
                        <Alert variant="success" title={t('Bond created')} isInline>
                          <p>
                            {t('Created {{names}}.', { names: createdNames.join(', ') })}
                          </p>
                          {createdNames.map((name) => (
                            <div key={name}>
                              <Button
                                variant="link"
                                isInline
                                component="a"
                                href={nncpConsolePath(name)}
                              >
                                {t('Open {{name}}', { name })}
                              </Button>
                            </div>
                          ))}
                        </Alert>
                      </StackItem>
                    )}

                    <StackItem>
                      <div className="netbond-actions">
                        <ActionGroup>
                          <Button
                            variant="primary"
                            onClick={handleCreate}
                            isDisabled={
                              creating ||
                              createdNames.length > 0 ||
                              plan.policies.length === 0 ||
                              plan.issues.length > 0
                            }
                            isLoading={creating}
                          >
                            {creating ? t('Creating...') : t('Create')}
                          </Button>
                          {createdNames.length > 0 && (
                            <Button variant="secondary" onClick={handleCreateAnother}>
                              {t('Create another bond')}
                            </Button>
                          )}
                          <Button variant="link" onClick={goNetworkHub}>
                            {t('Back to Network')}
                          </Button>
                        </ActionGroup>
                      </div>
                    </StackItem>
                  </Stack>
                </CardBody>
              </Card>
            </StackItem>
          )}
        </Stack>
      </PageSection>

      <Modal
        isOpen={Boolean(removeTarget)}
        onClose={(_event) => closeRemoveModal()}
        variant="small"
        aria-labelledby="netbond-remove-title"
        aria-describedby="netbond-remove-desc"
      >
        <ModalHeader
          title={
            removeTarget?.nncpAlreadyAbsent && !removeTarget.inNns
              ? t('Delete leftover policy')
              : t('Remove bond')
          }
          labelId="netbond-remove-title"
          titleIconVariant="warning"
        />
        <ModalBody id="netbond-remove-desc">
          {removeTarget && (
            <Stack hasGutter>
              {removePlanPreview?.issues.map((issue) => (
                <StackItem key={issue.key}>
                  <Alert variant="danger" isInline title={t(issue.key, issue.values)} />
                </StackItem>
              ))}
              {removePlanPreview?.warnings.map((w) => (
                <StackItem key={w.key}>
                  <Alert variant="warning" isInline title={t(w.key, w.values)} />
                </StackItem>
              ))}
              <StackItem>
                {removeTarget.nncpAlreadyAbsent && !removeTarget.inNns
                  ? t(
                      'Bond {{name}} is already absent on the nodes. Delete the leftover policy {{policies}}?',
                      {
                        name: removeTarget.name,
                        policies: removeTarget.nncpNames.join(', ') || '—',
                      },
                    )
                  : t(
                      'This sets bond {{name}} to absent with NMState, waits for the apply to succeed, then deletes the policy. Member NICs become standalone ethernet. This cannot be undone from this page.',
                      { name: removeTarget.name },
                    )}
              </StackItem>
              {removePhase && removing && (
                <StackItem>
                  <Alert variant="info" isInline title={removePhase} />
                </StackItem>
              )}
              {removeError && (
                <StackItem>
                  <Alert variant="danger" isInline title={t('Failed to remove bond')}>
                    {removeError}
                  </Alert>
                </StackItem>
              )}
            </Stack>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            onClick={() => removeTarget && handleRemove(removeTarget)}
            isDisabled={
              removing ||
              !removeTarget?.canRemove ||
              Boolean(removePlanPreview && removePlanPreview.issues.length > 0)
            }
            isLoading={removing}
          >
            {removing
              ? t('Removing...')
              : removeTarget?.nncpAlreadyAbsent && !removeTarget.inNns
                ? t('Delete policy')
                : t('Remove bond')}
          </Button>
          <Button variant="link" onClick={closeRemoveModal} isDisabled={removing}>
            {t('Cancel')}
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
};

export default NetworkBondPage;
