import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardTitle,
  Label,
  Title,
  Tooltip,
} from '@patternfly/react-core';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import React, { FC } from 'react';

import { BondInventoryItem } from '../utils/bond-remove';

const nncpConsolePath = (name: string) =>
  `/k8s/cluster/nmstate.io~v1~NodeNetworkConfigurationPolicy/${encodeURIComponent(name)}`;

type ExistingBondsCardProps = {
  items: BondInventoryItem[];
  busyName: string | null;
  onRemove: (item: BondInventoryItem) => void;
};

const ExistingBondsCard: FC<ExistingBondsCardProps> = ({ items, busyName, onRemove }) => {
  const { t } = useTranslation('plugin__oct-network-bond');

  if (items.length === 0) {
    return (
      <Card>
        <CardTitle>
          <Title headingLevel="h2">{t('Existing bonds')}</Title>
        </CardTitle>
        <CardBody>
          <p className="netbond-lead">
            {t('No Linux bonds found on the selected pools. Create one below, or select pools to scope the list.')}
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>
        <Title headingLevel="h2">{t('Existing bonds')}</Title>
      </CardTitle>
      <CardBody>
        <p className="netbond-lead">
          {t(
            'Remove sets the bond to absent with NMState, waits for the policy to apply, then deletes the policy. The bond that carries br-ex cannot be removed.',
          )}
        </p>
        <div className="netbond-table-wrap">
          <Table aria-label={t('Existing bonds')} variant="compact">
            <Thead>
              <Tr>
                <Th>{t('Bond')}</Th>
                <Th>{t('NICs')}</Th>
                <Th>{t('Nodes')}</Th>
                <Th>{t('Policy')}</Th>
                <Th>{t('Remove')}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {items.map((item) => {
                const protectedBrEx = item.brExNodeNames.length > 0;
                const leftover = item.nncpAlreadyAbsent && !item.inNns;
                const busy = busyName === item.name;
                const removeLabel = leftover ? t('Delete policy') : t('Remove');
                const button = (
                  <Button
                    variant="danger"
                    isDisabled={!item.canRemove || Boolean(busyName)}
                    isLoading={busy}
                    onClick={() => onRemove(item)}
                  >
                    {busy ? t('Removing...') : removeLabel}
                  </Button>
                );
                return (
                  <Tr key={item.name}>
                    <Td dataLabel={t('Bond')}>
                      <div>{item.name}</div>
                      {protectedBrEx && (
                        <Label isCompact color="red" className="netbond-bond-flag">
                          {t('Protected: carries br-ex')}
                        </Label>
                      )}
                      {leftover && (
                        <Label isCompact color="grey" className="netbond-bond-flag">
                          {t('Already absent on nodes')}
                        </Label>
                      )}
                      {item.managedByTool && !leftover && (
                        <div className="netbond-enslaved">{t('Created by Network Bond')}</div>
                      )}
                    </Td>
                    <Td dataLabel={t('NICs')}>{item.ports.length > 0 ? item.ports.join(', ') : '—'}</Td>
                    <Td dataLabel={t('Nodes')}>
                      {item.nodeNames.length > 0
                        ? `${item.nodeNames.length}: ${item.nodeNames.join(', ')}`
                        : leftover
                          ? t('Not present')
                          : '—'}
                    </Td>
                    <Td dataLabel={t('Policy')}>
                      {item.nncpNames.length === 0
                        ? '—'
                        : item.nncpNames.map((name) => (
                            <div key={name}>
                              <Button
                                variant="link"
                                isInline
                                component="a"
                                href={nncpConsolePath(name)}
                              >
                                {name}
                              </Button>
                            </div>
                          ))}
                    </Td>
                    <Td dataLabel={t('Remove')}>
                      {item.blockReason ? (
                        <Tooltip
                          content={t(item.blockReason.key, item.blockReason.values)}
                        >
                          <span className="netbond-remove-wrap">{button}</span>
                        </Tooltip>
                      ) : (
                        button
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        </div>
        {items.some((i) => i.brExNodeNames.length > 0) && (
          <Alert
            className="netbond-bond-alert"
            variant="info"
            isInline
            title={t('br-ex is the cluster default network')}
          >
            {t(
              'OpenShift OVN uses br-ex as the node default network. This tool will not absent the bond (or parent interface) that br-ex is built on.',
            )}
          </Alert>
        )}
      </CardBody>
    </Card>
  );
};

export default ExistingBondsCard;
