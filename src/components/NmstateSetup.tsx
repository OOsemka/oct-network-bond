import { K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
} from '@patternfly/react-core';
import { NetworkIcon } from '@patternfly/react-icons';
import React, { FC, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CustomResourceDefinitionModel,
  NNS_CRD,
  installNmstate,
  isNotFound,
  nmstateErrorMessage,
} from '../utils/nmstate-install';

/**
 * True when the NMState operator is not installed. The console SDK reports no
 * error for a watch on a kind whose CRD does not exist (it never loads), so
 * look for the CRD itself.
 */
export function useNmstateMissing(): boolean {
  const [crd, loaded, error] = useK8sWatchResource<K8sResourceCommon>({
    groupVersionKind: {
      group: CustomResourceDefinitionModel.apiGroup,
      version: CustomResourceDefinitionModel.apiVersion,
      kind: CustomResourceDefinitionModel.kind,
    },
    name: NNS_CRD,
  });
  return (loaded && !crd?.metadata?.name) || (!!error && isNotFound(error));
}

/** Empty state with a one-click NMState install (or finishing a partial setup). */
const NmstateSetup: FC<{ missing: boolean }> = ({ missing }) => {
  const { t } = useTranslation('plugin__oct-network-bond');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const onInstall = async () => {
    setBusy(true);
    setError('');
    try {
      await installNmstate(setMessage);
      setMessage(t('NMState is installed.'));
    } catch (e) {
      setError(nmstateErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <EmptyState
      titleText={missing ? t('The NMState operator is not installed') : t('NMState has not reported node interfaces yet')}
      icon={NetworkIcon}
      headingLevel="h2"
    >
      <EmptyStateBody>
        {missing
          ? t('This page reads and configures node interfaces with the Kubernetes NMState operator. Install it from redhat-operators with one click.')
          : t('The operator is installed, but nodes are not reporting their interfaces. Finishing the setup creates the NMState instance if it is missing.')}
      </EmptyStateBody>
      <EmptyStateFooter>
        <EmptyStateActions>
          <Button variant="primary" onClick={onInstall} isLoading={busy} isDisabled={busy}>
            {missing ? t('Install NMState operator') : t('Finish NMState setup')}
          </Button>
        </EmptyStateActions>
        {message && <EmptyStateBody>{message}</EmptyStateBody>}
        {error && <Alert isInline variant="danger" title={error} />}
      </EmptyStateFooter>
    </EmptyState>
  );
};

export default NmstateSetup;
