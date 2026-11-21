/**
 * CrudTable — table générique des référentiels (pattern Table+Drawer, EXPERIENCE).
 * Recherche client-side, tri par colonne, pagination 15, colonne d'actions
 * (éditer / désactiver-activer / supprimer) optionnellement paramétrée.
 */
import { useMemo, useState } from 'react';
import { Button, Input, Space, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

export interface CrudTableProps<T extends { id: number }> {
  rows: T[];
  loading: boolean;
  columns: ColumnsType<T>;
  /** Champs textuels utilisés par la recherche libre. */
  searchKeys: (keyof T & string)[];
  onEdit?: (row: T) => void;
  onDelete?: (row: T) => void;
  /** Si fourni : bouton activer/désactiver (lit `is_active` sur la ligne). */
  onToggleActive?: (row: T) => void;
  /** Si fourni : clic sur une ligne (ex. ouverture d'une fiche de suivi). */
  onRowClick?: (row: T) => void;
  /** Désactive visuellement les lignes inactives (`is_active === 0`). */
  dimInactive?: boolean;
  toolbar?: React.ReactNode;
}

export function CrudTable<T extends { id: number }>(
  props: CrudTableProps<T>,
): React.JSX.Element {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return props.rows;
    return props.rows.filter((row) =>
      props.searchKeys.some((key) =>
        String(row[key] ?? '')
          .toLowerCase()
          .includes(q),
      ),
    );
  }, [props.rows, props.searchKeys, search]);

  const actionColumn: ColumnsType<T>[number] = {
    key: '_actions',
    title: t('common.actions'),
    width: 200,
    render: (_value, row) => (
      <Space size="small">
        {props.onEdit && (
          <Tooltip title={t('common.edit')}>
            <Button
              size="small"
              icon={<EditOutlined />}
              aria-label={t('common.edit')}
              onClick={(e) => {
                e.stopPropagation();
                props.onEdit?.(row);
              }}
            />
          </Tooltip>
        )}
        {props.onToggleActive && (
          <Tooltip
            title={
              (row as { is_active?: number }).is_active === 0
                ? t('common.activate')
                : t('common.deactivate')
            }
          >
            <Button
              size="small"
              icon={
                (row as { is_active?: number }).is_active === 0 ? (
                  <PlayCircleOutlined />
                ) : (
                  <PauseCircleOutlined />
                )
              }
              aria-label={
                (row as { is_active?: number }).is_active === 0
                  ? t('common.activate')
                  : t('common.deactivate')
              }
              onClick={(e) => {
                e.stopPropagation();
                props.onToggleActive?.(row);
              }}
            />
          </Tooltip>
        )}
        {props.onDelete && (
          <Tooltip title={t('common.delete')}>
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              aria-label={t('common.delete')}
              onClick={(e) => {
                e.stopPropagation();
                props.onDelete?.(row);
              }}
            />
          </Tooltip>
        )}
      </Space>
    ),
  };

  const columns: ColumnsType<T> = [
    ...props.columns,
    ...(props.onEdit || props.onDelete || props.onToggleActive
      ? [actionColumn]
      : []),
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Input.Search
          allowClear
          placeholder={t('common.search')}
          style={{ maxWidth: 320 }}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1); // sinon la recherche sur une page >1 affiche une page vide
          }}
        />
        {props.toolbar}
      </Space>
      <Table<T>
        size="small"
        rowKey="id"
        loading={props.loading}
        columns={columns}
        dataSource={filtered}
        rowClassName={(row) =>
          props.dimInactive && (row as { is_active?: number }).is_active === 0
            ? 'row-inactive'
            : ''
        }
        onRow={(row) => ({
          onClick: () => props.onRowClick?.(row),
          style: props.onRowClick ? { cursor: 'pointer' } : undefined,
        })}
        pagination={{
          pageSize: 15,
          showSizeChanger: false,
          current: page,
          onChange: setPage,
        }}
        locale={{ emptyText: t('common.empty') }}
      />
    </Space>
  );
}
