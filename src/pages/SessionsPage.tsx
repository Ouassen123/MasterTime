/**
 * SessionsPage (P9a — FR-30, FR-35) — registre central des séances :
 * table paginée serveur avec filtres combinés (plage de dates, master,
 * professeur, salle, module, statut effectif, recherche littérale),
 * compteurs d'en-tête (résultats / réalisées / non réalisées / en
 * retard), colonne Retard (tag rouge « J+n ») et même fiche de détail
 * + actions que TimetablePage (SessionDrawer partagé).
 * Quand un master est filtré, le panneau « Reste à effectuer » affiche
 * le reliquat par master-module (FR-35, `registry:remaining`).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  DatePicker,
  Input,
  List,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  CalendarOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import {
  minToHHMM,
  SessionDrawer,
  STATUS_COLORS,
} from '../components/SessionDrawer';
import type {
  EffectiveSessionStatus,
  MasterRow,
  Module,
  ProfessorRow,
  RegistryResult,
  RegistryRow,
  RemainingResult,
  Room,
} from '../../shared/types';
import { EFFECTIVE_SESSION_STATUSES } from '../../shared/types';

const { Text, Title } = Typography;

interface RemainingLine extends RemainingResult {
  label: string;
}

export function SessionsPage(): React.JSX.Element {
  const { t } = useTranslation();

  // --- Référentiels (Selects) -------------------------------------------------
  const [masters, setMasters] = useState<MasterRow[]>([]);
  const [professors, setProfessors] = useState<ProfessorRow[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [modules, setModules] = useState<Module[]>([]);

  // --- Filtres ------------------------------------------------------------------
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [masterId, setMasterId] = useState<number | undefined>(undefined);
  const [professorId, setProfessorId] = useState<number | undefined>(undefined);
  const [roomId, setRoomId] = useState<number | undefined>(undefined);
  const [moduleId, setModuleId] = useState<number | undefined>(undefined);
  const [statusEff, setStatusEff] = useState<EffectiveSessionStatus | undefined>(
    undefined,
  );
  const [search, setSearch] = useState('');

  // --- Données ---------------------------------------------------------------------
  const [result, setResult] = useState<RegistryResult | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // --- Drawer séance (partagé) -------------------------------------------------------
  const [drawerSessionId, setDrawerSessionId] = useState<number | null>(null);

  // --- Reste à effectuer (FR-35) ------------------------------------------------------
  const [remaining, setRemaining] = useState<RemainingLine[] | null>(null);

  useEffect(() => {
    if (!hasApi()) {
      setLoading(false);
      setError(t('db.unavailable'));
      return;
    }
    const notify = (err: unknown): void => void message.error(errorMessage(err));
    void api()
      .masters.list()
      .then((r) => (r.ok ? setMasters(r.data) : notify(r)))
      .catch(notify);
    void api()
      .professors.list()
      .then((r) => (r.ok ? setProfessors(r.data) : notify(r)))
      .catch(notify);
    void api()
      .rooms.list()
      .then((r) => (r.ok ? setRooms(r.data) : notify(r)))
      .catch(notify);
    void api()
      .modules.list()
      .then((r) => (r.ok ? setModules(r.data) : notify(r)))
      .catch(notify);
  }, [t]);

  // Reste à effectuer par master-module (FR-35) — affiché dès qu'un
  // master est filtré (les mm sont chargés via masters:get).
  useEffect(() => {
    if (!hasApi() || masterId == null) {
      setRemaining(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const det = await api().masters.get(masterId);
        if (!det.ok) {
          void message.error(errorMessage(det));
          return;
        }
        const lines: RemainingLine[] = [];
        for (const mm of det.data.modules) {
          const res = await api().registry.remaining(mm.id);
          if (cancelled) return;
          if (res.ok) {
            lines.push({
              ...res.data,
              label: `${mm.module_code} — ${mm.module_name}${
                mm.group_name ? ` · ${mm.group_name}` : ''
              }`,
            });
          }
        }
        if (!cancelled) setRemaining(lines);
      } catch (err) {
        if (!cancelled) void message.error(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [masterId, reloadKey]);

  const load = useCallback(async (): Promise<void> => {
    if (!hasApi()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api().registry.list(
        {
          date_from: range?.[0]?.format('YYYY-MM-DD'),
          date_to: range?.[1]?.format('YYYY-MM-DD'),
          master_id: masterId,
          professor_id: professorId,
          room_id: roomId,
          module_id: moduleId,
          status_effectif: statusEff,
          search: search.trim() || undefined,
        },
        { page, pageSize },
      );
      if (res.ok) setResult(res.data);
      else {
        setResult(null);
        setError(errorMessage(res));
      }
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [
    range, masterId, professorId, roomId, moduleId, statusEff, search,
    page, pageSize,
  ]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const applyFilters = (): void => {
    // Tout changement de filtre ramène à la page 1 (cohérence du total).
    setPage(1);
    setReloadKey((k) => k + 1);
  };

  const resetFilters = (): void => {
    setRange(null);
    setMasterId(undefined);
    setProfessorId(undefined);
    setRoomId(undefined);
    setModuleId(undefined);
    setStatusEff(undefined);
    setSearch('');
    setPage(1);
    setReloadKey((k) => k + 1);
  };

  const columns: ColumnsType<RegistryRow> = [
    {
      key: 'date',
      title: t('registry.cols.date'),
      width: 130,
      render: (_v, r) => dayjs(r.date).format('ddd DD/MM/YYYY'),
    },
    {
      key: 'time',
      title: t('registry.cols.time'),
      width: 100,
      render: (_v, r) => `${minToHHMM(r.start_min)}–${minToHHMM(r.end_min)}`,
    },
    {
      key: 'module',
      title: t('registry.cols.module'),
      render: (_v, r) => (
        <span dir="auto">
          {r.module.code} — {r.module.name}
        </span>
      ),
    },
    {
      key: 'master',
      title: t('registry.cols.master'),
      render: (_v, r) => (
        <span dir="auto">
          {r.master.code} — {r.master.name}
          {r.group_name ? (
            <Text type="secondary"> · {r.group_name}</Text>
          ) : null}
        </span>
      ),
    },
    {
      key: 'professor',
      title: t('registry.cols.professor'),
      render: (_v, r) => <span dir="auto">{r.professor.full_name}</span>,
    },
    {
      key: 'room',
      title: t('registry.cols.room'),
      render: (_v, r) => r.room.name,
    },
    {
      key: 'status',
      title: t('registry.cols.status'),
      width: 130,
      render: (_v, r) => (
        <Tag color={STATUS_COLORS[r.effective_status]}>
          {t(`sessionStatus.${r.effective_status}`)}
        </Tag>
      ),
    },
    {
      key: 'retard',
      title: t('registry.cols.delay'),
      width: 90,
      align: 'center',
      render: (_v, r) =>
        r.retard_jours > 0 ? (
          <Tag color="red">{t('registry.delayTag', { n: r.retard_jours })}</Tag>
        ) : null,
    },
  ];

  const stats = result?.stats;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Title level={3} style={{ margin: 0 }}>
        <CalendarOutlined /> {t('registry.title')}
      </Title>

      {/* Compteurs d'en-tête sur l'ensemble filtré (pas la page). */}
      <Space wrap size="large">
        <Statistic
          title={t('registry.stats.results')}
          value={stats?.total ?? 0}
          loading={loading && result == null}
        />
        <Statistic
          title={t('registry.stats.done')}
          value={stats?.realisee ?? 0}
          loading={loading && result == null}
        />
        <Statistic
          title={t('registry.stats.notDone')}
          value={stats?.non_realisee ?? 0}
          loading={loading && result == null}
        />
        <Statistic
          title={t('registry.stats.delayed')}
          value={stats?.en_retard ?? 0}
          loading={loading && result == null}
        />
      </Space>

      {/* Barre de filtres combinés */}
      <Space wrap>
        <DatePicker.RangePicker
          value={range}
          onChange={(v) => {
            setRange(v);
            setPage(1);
          }}
          format="DD/MM/YYYY"
          placeholder={[t('registry.filters.dateFrom'), t('registry.filters.dateTo')]}
          allowClear
        />
        <Select
          showSearch
          allowClear
          optionFilterProp="label"
          placeholder={t('registry.filters.master')}
          style={{ minWidth: 220 }}
          value={masterId}
          onChange={(v) => {
            setMasterId(v);
            setPage(1);
          }}
          options={masters.map((m) => ({
            value: m.id,
            label: `${m.code} — ${m.name}`,
          }))}
        />
        <Select
          showSearch
          allowClear
          optionFilterProp="label"
          placeholder={t('registry.filters.professor')}
          style={{ minWidth: 200 }}
          value={professorId}
          onChange={(v) => {
            setProfessorId(v);
            setPage(1);
          }}
          options={professors.map((p) => ({ value: p.id, label: p.full_name }))}
        />
        <Select
          showSearch
          allowClear
          optionFilterProp="label"
          placeholder={t('registry.filters.room')}
          style={{ minWidth: 160 }}
          value={roomId}
          onChange={(v) => {
            setRoomId(v);
            setPage(1);
          }}
          options={rooms.map((r) => ({ value: r.id, label: r.name }))}
        />
        <Select
          showSearch
          allowClear
          optionFilterProp="label"
          placeholder={t('registry.filters.module')}
          style={{ minWidth: 200 }}
          value={moduleId}
          onChange={(v) => {
            setModuleId(v);
            setPage(1);
          }}
          options={modules.map((m) => ({
            value: m.id,
            label: `${m.code} — ${m.name}`,
          }))}
        />
        <Select
          allowClear
          placeholder={t('registry.filters.status')}
          style={{ minWidth: 180 }}
          value={statusEff}
          onChange={(v) => {
            setStatusEff(v);
            setPage(1);
          }}
          options={EFFECTIVE_SESSION_STATUSES.map((st) => ({
            value: st,
            label: t(`sessionStatus.${st}`),
          }))}
        />
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={t('registry.filters.search')}
          style={{ width: 240 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onPressEnter={applyFilters}
        />
        <Button type="primary" onClick={applyFilters}>
          {t('registry.filters.apply')}
        </Button>
        <Button onClick={resetFilters}>{t('registry.filters.reset')}</Button>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => setReloadKey((k) => k + 1)}
          title={t('conflicts.refresh')}
        />
      </Space>

      {error && <Alert type="error" showIcon message={error} />}

      {/* Reste à effectuer par master-module (FR-35) — master filtré. */}
      {remaining != null && remaining.length > 0 && (
        <Collapse
          size="small"
          defaultActiveKey={remaining.some((r) => r.remaining > 0) ? ['r'] : []}
          items={[
            {
              key: 'r',
              label: t('registry.remaining.title'),
              children: (
                <List
                  size="small"
                  dataSource={remaining}
                  renderItem={(r) => (
                    <List.Item>
                      <Space size="middle">
                        <span dir="auto">{r.label}</span>
                        <Text type="secondary">
                          {t('registry.remaining.line', {
                            scheduled: r.scheduled_non_cancelled,
                            planned: r.planned,
                          })}
                        </Text>
                        {r.remaining > 0 ? (
                          <Tag color="orange">
                            {t('registry.remaining.tag', { n: r.remaining })}
                          </Tag>
                        ) : (
                          <Tag color="green">{t('registry.remaining.done')}</Tag>
                        )}
                      </Space>
                    </List.Item>
                  )}
                />
              ),
            },
          ]}
        />
      )}

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<RegistryRow>
          size="small"
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={result?.rows ?? []}
          locale={{ emptyText: t('registry.empty') }}
          onRow={(r) => ({
            onClick: () => setDrawerSessionId(r.id),
            style: { cursor: 'pointer' },
          })}
          pagination={{
            current: page,
            pageSize,
            total: result?.total ?? 0,
            showSizeChanger: true,
            showTotal: (total) =>
              t('registry.pagination', { count: total }),
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
        />
      </Card>

      {/* Fiche séance partagée : mêmes détail + actions que TimetablePage. */}
      <SessionDrawer
        sessionId={drawerSessionId}
        rooms={rooms}
        professors={professors}
        onClose={() => setDrawerSessionId(null)}
        onChanged={() => setReloadKey((k) => k + 1)}
      />
    </Space>
  );
}
