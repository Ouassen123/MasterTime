/**
 * GenerationPage (P8) — génération automatique de l'emploi du temps en
 * 3 zones (spec §6) :
 *
 * 1. Paramètres : semestre (défaut = semestre du contexte), multi-select
 *    des master-modules groupés par Master (vide = tout le semestre),
 *    mode COMPLETE/REGENERATE, plage de dates (défaut = fenêtre sched
 *    globale du catalogue), pause, max/jour.
 * 2. Historique : table des générations (date, auteur, mode, placées,
 *    non placées, statut) — un clic ouvre le détail.
 * 3. Détail/Preview : résumé chiffré + warnings, diff des séances
 *    proposées (NOUVELLE / REMPLACE + séance remplacée en regard),
 *    panneau BR-15 (raisons + suggestions), boutons Appliquer
 *    (Popconfirm chiffré) et Abandonner. Refus BR-10 à l'apply → modal
 *    de conflits détaillée (même rendu que P7b, jamais de toast seul).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Empty,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  CalendarOutlined,
  CheckOutlined,
  CloseOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage, hasApi } from '../api/client';
import type {
  AcademicYearRef,
  ApplyResult,
  ConflictKind,
  GenerationCatalog,
  GenerationDetail,
  GenerationMode,
  GenerationRow,
  PlacementConflict,
  ProposedSession,
  SemesterRef,
  UnplacedItem,
} from '../../shared/types';

const { RangePicker } = DatePicker;
const { Text, Title } = Typography;

/** Palette kinds — identique à TimetablePage (DESIGN.md). */
const KIND_COLORS: Record<ConflictKind, string> = {
  ROOM: '#DC2626',
  PROFESSOR: '#D97706',
  MASTER: '#7C3AED',
  GROUP: '#0284C7',
  EXTERNAL: '#4B5563',
};

const STATUS_COLORS: Record<string, string> = {
  PREVIEW: '#2563EB',
  APPLIED: '#16A34A',
  ABANDONED: '#9CA3AF',
};

function minToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}h${String(
    min % 60,
  ).padStart(2, '0')}`;
}

export function GenerationPage(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // --- Référentiels & paramètres ---------------------------------------------
  const [semesters, setSemesters] = useState<SemesterRef[]>([]);
  const [semesterId, setSemesterId] = useState<number | undefined>(undefined);
  const [catalog, setCatalog] = useState<GenerationCatalog | null>(null);
  const [mmIds, setMmIds] = useState<number[]>([]);
  const [mode, setMode] = useState<GenerationMode>('COMPLETE');
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [pauseMin, setPauseMin] = useState<number>(0);
  const [maxPerDay, setMaxPerDay] = useState<number>(2);
  const [running, setRunning] = useState(false);

  // --- Historique & détail -----------------------------------------------------
  const [rows, setRows] = useState<GenerationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<GenerationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const [refusal, setRefusal] = useState<PlacementConflict[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async (): Promise<void> => {
    if (!hasApi()) return;
    try {
      const res = await api().generation.list();
      if (res.ok) setRows(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (!hasApi()) {
      setLoading(false);
      setError(t('db.unavailable'));
      return;
    }
    const notify = (err: unknown): void => void message.error(errorMessage(err));
    void api()
      .contextSemesters()
      .then((r) => {
        if (!r.ok) {
          notify(r);
          return;
        }
        setSemesters(r.data.semesters);
        // Défaut : premier semestre (ordinal min) de l'année courante —
        // même règle que collectAppContext (topbar).
        const cur = r.data.academicYears.find(
          (y: AcademicYearRef) => y.is_current === 1,
        );
        const sem = r.data.semesters
          .filter((s) => s.academic_year_id === cur?.id)
          .sort((a, b) => a.ordinal - b.ordinal)[0];
        if (sem) setSemesterId(sem.id);
      })
      .catch(notify);
    void loadHistory().finally(() => setLoading(false));
  }, [loadHistory, t]);

  // Catalogue des master-modules quand le semestre change.
  useEffect(() => {
    if (!hasApi() || semesterId == null) return;
    let cancelled = false;
    setMmIds([]);
    void api()
      .generation.catalog(semesterId)
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setCatalog(r.data);
          // Plage par défaut = fenêtre sched globale du semestre.
          if (r.data.sched_start && r.data.sched_end) {
            setRange([dayjs(r.data.sched_start), dayjs(r.data.sched_end)]);
          } else {
            setRange(null);
          }
        } else {
          void message.error(errorMessage(r));
        }
      })
      .catch((err) => {
        if (!cancelled) void message.error(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [semesterId]);

  const openDetail = async (id: number): Promise<void> => {
    setDetailLoading(true);
    setApplied(null);
    try {
      const res = await api().generation.get(id);
      if (res.ok) setDetail(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const run = async (): Promise<void> => {
    if (semesterId == null || range == null) return;
    setRunning(true);
    setApplied(null);
    try {
      const res = await api().generation.run({
        semester_id: semesterId,
        master_module_ids: mmIds.length > 0 ? mmIds : undefined,
        mode,
        date_start: range[0].format('YYYY-MM-DD'),
        date_end: range[1].format('YYYY-MM-DD'),
        pause_min: pauseMin,
        max_sessions_per_day_per_master: maxPerDay,
      });
      if (res.ok) {
        void loadHistory();
        await openDetail(res.data.generation_id);
        if (res.data.unplaced.length > 0) {
          void message.warning(
            t('generation.unplacedPanel.missing', {
              count: res.data.summary.unplaced,
            }),
          );
        }
      } else {
        void message.error(errorMessage(res));
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const doApply = async (): Promise<void> => {
    if (!detail) return;
    setApplying(true);
    try {
      const res = await api().generation.apply(detail.row.id);
      if (res.ok) {
        setApplied(res.data);
        void message.success(
          t('generation.applied', {
            inserted: res.data.inserted,
            cancelled: res.data.cancelled,
          }),
        );
        void loadHistory();
        await openDetail(detail.row.id);
      } else if (res.conflicts && res.conflicts.length > 0) {
        setRefusal(res.conflicts);
      } else {
        void message.error(res.error);
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setApplying(false);
    }
  };

  const doAbandon = async (): Promise<void> => {
    if (!detail) return;
    try {
      const res = await api().generation.abandon(detail.row.id);
      if (res.ok) {
        void message.success(t('generation.abandoned'));
        void loadHistory();
        await openDetail(detail.row.id);
      } else {
        void message.error(errorMessage(res));
      }
    } catch (err) {
      void message.error(errorMessage(err));
    }
  };

  // --- Options du multi-select master-modules (groupées par Master) -----------
  const mmOptions = useMemo(() => {
    const byMaster = new Map<string, { value: number; label: string }[]>();
    for (const m of catalog?.modules ?? []) {
      const key = `${m.master_code} — ${m.master_name}`;
      const list = byMaster.get(key) ?? [];
      list.push({
        value: m.id,
        label: `${m.module_label} · ${m.professor_name}${
          m.group_name ? ` · ${m.group_name}` : ''
        }`,
      });
      byMaster.set(key, list);
    }
    return [...byMaster.entries()].map(([label, options]) => ({
      label: <span dir="auto">{label}</span>,
      options,
    }));
  }, [catalog]);

  // --- Colonnes historique ------------------------------------------------------
  const historyColumns: ColumnsType<GenerationRow> = [
    {
      title: t('generation.cols.date'),
      dataIndex: 'created_at',
      width: 160,
      render: (v: string) => dayjs(v).format('DD/MM/YYYY HH:mm'),
    },
    {
      title: t('generation.cols.author'),
      dataIndex: 'user_name',
      width: 150,
      render: (v: string | null) => <span dir="auto">{v ?? '—'}</span>,
    },
    {
      title: t('generation.cols.semester'),
      dataIndex: 'semester_label',
      width: 90,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: t('generation.cols.mode'),
      dataIndex: 'mode',
      width: 120,
      render: (v: string | null) =>
        v ? t(`generation.modes.${v}`) : '—',
    },
    {
      title: t('generation.cols.placed'),
      dataIndex: 'placed_count',
      width: 90,
      align: 'right',
      render: (v: number | null) => v ?? 0,
    },
    {
      title: t('generation.cols.unplaced'),
      dataIndex: 'unplaced_count',
      width: 110,
      align: 'right',
      render: (v: number) =>
        v > 0 ? <Text type="danger">{v}</Text> : v,
    },
    {
      title: t('generation.cols.status'),
      dataIndex: 'status',
      width: 110,
      render: (v: string) => (
        <Tag color={STATUS_COLORS[v]}>{t(`generation.statuses.${v}`)}</Tag>
      ),
    },
  ];

  // --- Colonnes diff -------------------------------------------------------------
  const diffColumns: ColumnsType<ProposedSession> = [
    {
      title: t('generation.diff.kind'),
      width: 110,
      render: (_: unknown, p) =>
        p.replaces_session_id != null ? (
          <Tag color="#D97706">{t('generation.diff.replaces')}</Tag>
        ) : (
          <Tag color="#16A34A">{t('generation.diff.new')}</Tag>
        ),
    },
    {
      title: t('generation.diff.date'),
      dataIndex: 'date',
      width: 130,
      render: (v: string) => dayjs(v).format('dddd DD/MM'),
    },
    {
      title: t('generation.diff.time'),
      width: 110,
      render: (_: unknown, p) =>
        `${minToHHMM(p.start_min)}–${minToHHMM(p.end_min)}`,
    },
    {
      title: t('generation.diff.module'),
      dataIndex: 'module_label',
      ellipsis: true,
      render: (v: string, p) => (
        <span dir="auto">
          {v}
          <Text type="secondary"> · {p.master_label.split(' — ')[0]}</Text>
        </span>
      ),
    },
    {
      title: t('generation.diff.professor'),
      dataIndex: 'professor_name',
      ellipsis: true,
      render: (v: string) => <span dir="auto">{v}</span>,
    },
    {
      title: t('generation.diff.room'),
      dataIndex: 'room_name',
      width: 120,
    },
    {
      title: t('generation.diff.group'),
      dataIndex: 'group_name',
      width: 110,
      render: (v: string | null) => (
        <span dir="auto">{v ?? t('generation.diff.wholeMaster')}</span>
      ),
    },
    {
      title: t('generation.diff.replacesWhat'),
      dataIndex: 'replaces_label',
      width: 220,
      render: (v: string | null) =>
        v ? <Text type="secondary">{v}</Text> : '—',
    },
  ];

  const result = detail?.result ?? null;
  const isPreview = detail?.row.status === 'PREVIEW';

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Title level={3} style={{ margin: 0 }}>
        <ThunderboltOutlined /> {t('generation.title')}
      </Title>

      {/* Zone 1 — Paramètres */}
      <Card size="small" title={t('generation.params')}>
        <Row gutter={[16, 12]} align="bottom">
          <Col xs={24} sm={12} md={6}>
            <Text type="secondary">{t('generation.semester')}</Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              value={semesterId}
              onChange={setSemesterId}
              options={semesters.map((s) => ({
                value: s.id,
                label: s.label,
              }))}
            />
          </Col>
          <Col xs={24} sm={12} md={8}>
            <Text type="secondary">{t('generation.modules')}</Text>
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              maxTagCount={2}
              placeholder={t('generation.modulesAll')}
              style={{ width: '100%', marginTop: 4 }}
              value={mmIds}
              onChange={setMmIds}
              options={mmOptions}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Text type="secondary">{t('generation.range')}</Text>
            <RangePicker
              style={{ width: '100%', marginTop: 4 }}
              format="DD/MM/YYYY"
              value={range}
              onChange={(v) =>
                setRange(v != null && v[0] != null && v[1] != null ? [v[0], v[1]] : null)
              }
            />
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Text type="secondary">{t('generation.pause')}</Text>
            <InputNumber
              style={{ width: '100%', marginTop: 4 }}
              min={0}
              max={240}
              value={pauseMin}
              onChange={(v) => setPauseMin(v ?? 0)}
            />
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Text type="secondary">{t('generation.maxPerDay')}</Text>
            <InputNumber
              style={{ width: '100%', marginTop: 4 }}
              min={1}
              max={12}
              value={maxPerDay}
              onChange={(v) => setMaxPerDay(v ?? 2)}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Text type="secondary">{t('generation.mode')}</Text>
            <Radio.Group
              style={{ width: '100%', marginTop: 4 }}
              optionType="button"
              buttonStyle="solid"
              value={mode}
              onChange={(e) => setMode(e.target.value as GenerationMode)}
              options={(['COMPLETE', 'REGENERATE'] as const).map((m) => ({
                value: m,
                label: t(`generation.modes.${m}`),
              }))}
            />
          </Col>
          <Col flex="auto">
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={running}
              disabled={semesterId == null || range == null}
              onClick={() => void run()}
            >
              {running ? t('generation.running') : t('generation.run')}
            </Button>
          </Col>
        </Row>
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          message={t(`generation.modeHelp.${mode}`)}
        />
      </Card>

      {error && <Alert type="error" showIcon message={error} />}

      {/* Zone 2 — Historique */}
      <Card size="small" title={t('generation.history')}>
        {loading ? (
          <Skeleton active />
        ) : (
          <Table<GenerationRow>
            size="small"
            rowKey="id"
            columns={historyColumns}
            dataSource={rows}
            pagination={rows.length > 15 ? { pageSize: 15 } : false}
            locale={{ emptyText: t('generation.historyEmpty') }}
            onRow={(r) => ({
              onClick: () => void openDetail(r.id),
              style: { cursor: 'pointer' },
            })}
          />
        )}
      </Card>

      {/* Zone 3 — Détail / Preview */}
      {detailLoading ? (
        <Card size="small">
          <Skeleton active />
        </Card>
      ) : detail && result ? (
        <Card
          size="small"
          title={
            <Space>
              {t('generation.detailTitle', { id: detail.row.id })}
              <Tag color={STATUS_COLORS[detail.row.status]}>
                {t(`generation.statuses.${detail.row.status}`)}
              </Tag>
            </Space>
          }
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('generation.generatedAt', {
                date: dayjs(detail.row.created_at).format('DD/MM/YYYY HH:mm'),
                author: detail.row.user_name ?? '—',
              })}
            </Text>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Row gutter={16}>
              <Col span={5}>
                <Statistic
                  title={t('generation.summary.placed')}
                  value={result.summary.placed}
                />
              </Col>
              <Col span={5}>
                <Statistic
                  title={t('generation.summary.unplaced')}
                  value={result.summary.unplaced}
                  valueStyle={{
                    color:
                      result.summary.unplaced > 0 ? '#DC2626' : undefined,
                  }}
                />
              </Col>
              <Col span={5}>
                <Statistic
                  title={t('generation.summary.replaced')}
                  value={result.summary.replaced}
                />
              </Col>
              <Col span={5}>
                <Statistic
                  title={t('generation.summary.days')}
                  value={result.summary.days}
                />
              </Col>
            </Row>

            {isPreview && (
              <Alert
                type="info"
                showIcon
                message={t('generation.previewOnly')}
              />
            )}

            {result.warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={t('generation.warnings')}
                description={
                  <List
                    size="small"
                    dataSource={result.warnings}
                    renderItem={(w) => (
                      <List.Item style={{ padding: '2px 0' }}>
                        <span dir="auto">{w}</span>
                      </List.Item>
                    )}
                  />
                }
              />
            )}

            {/* Diff des séances proposées */}
            <Table<ProposedSession>
              size="small"
              title={() => (
                <Text strong>{t('generation.diff.title')}</Text>
              )}
              rowKey={(p) =>
                `${p.master_module_id}-${p.date}-${p.start_min}-${p.room_id}`
              }
              columns={diffColumns}
              dataSource={result.placed}
              pagination={
                result.placed.length > 20 ? { pageSize: 20 } : false
              }
              scroll={{ x: true }}
            />

            {/* Panneau BR-15 — non placées */}
            {result.unplaced.length > 0 && (
              <Collapse
                defaultActiveKey={['unplaced']}
                items={[
                  {
                    key: 'unplaced',
                    label: (
                      <Space>
                        <WarningOutlined style={{ color: '#DC2626' }} />
                        {t('generation.unplacedPanel.title')}
                        <Badge
                          count={result.summary.unplaced}
                          color="#DC2626"
                        />
                      </Space>
                    ),
                    children: result.unplaced.map((u: UnplacedItem) => (
                      <Card
                        key={u.master_module_id}
                        size="small"
                        style={{ marginBottom: 8 }}
                        title={
                          <Space>
                            <span dir="auto">{u.module_label}</span>
                            <Text type="secondary" dir="auto">
                              {u.master_label} · {u.professor_name}
                            </Text>
                            <Tag color="#DC2626">
                              {t('generation.unplacedPanel.missing', {
                                count: u.missing,
                              })}
                            </Tag>
                          </Space>
                        }
                      >
                        <Row gutter={24}>
                          <Col xs={24} md={12}>
                            <Text strong>
                              {t('generation.unplacedPanel.reasons')}
                            </Text>
                            <List
                              size="small"
                              dataSource={u.reasons}
                              renderItem={(x) => (
                                <List.Item style={{ padding: '2px 0' }}>
                                  <span dir="auto">• {x}</span>
                                </List.Item>
                              )}
                            />
                          </Col>
                          <Col xs={24} md={12}>
                            <Text strong type="success">
                              {t('generation.unplacedPanel.suggestions')}
                            </Text>
                            <List
                              size="small"
                              dataSource={u.suggestions}
                              renderItem={(x) => (
                                <List.Item style={{ padding: '2px 0' }}>
                                  <span dir="auto">→ {x}</span>
                                </List.Item>
                              )}
                            />
                          </Col>
                        </Row>
                      </Card>
                    )),
                  },
                ]}
              />
            )}

            {/* Actions */}
            <Space wrap>
              {isPreview && (
                <>
                  <Popconfirm
                    title={t('generation.apply')}
                    description={t('generation.applyConfirm', {
                      inserted: result.summary.placed,
                      cancelled: result.summary.replaced,
                    })}
                    okText={t('common.ok')}
                    cancelText={t('common.cancel')}
                    onConfirm={() => void doApply()}
                  >
                    <Button
                      type="primary"
                      icon={<CheckOutlined />}
                      loading={applying}
                      disabled={result.placed.length === 0}
                    >
                      {t('generation.apply')}
                    </Button>
                  </Popconfirm>
                  <Popconfirm
                    title={t('generation.abandon')}
                    description={t('generation.abandonConfirm')}
                    okText={t('common.ok')}
                    cancelText={t('common.cancel')}
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void doAbandon()}
                  >
                    <Button danger icon={<CloseOutlined />}>
                      {t('generation.abandon')}
                    </Button>
                  </Popconfirm>
                </>
              )}
              {(detail.row.status === 'APPLIED' || applied) && (
                <Button
                  icon={<CalendarOutlined />}
                  onClick={() => navigate('/emplois-du-temps')}
                >
                  {t('generation.viewTimetable')}
                </Button>
              )}
            </Space>
          </Space>
        </Card>
      ) : detail ? (
        <Card size="small">
          <Empty description={t('common.empty')} />
        </Card>
      ) : null}

      {/* Modal refus BR-10 à l'apply — même rendu que TimetablePage. */}
      <Modal
        title={
          <Space>
            <WarningOutlined style={{ color: '#DC2626' }} />
            {t('generation.refusalTitle')}
          </Space>
        }
        open={refusal != null}
        footer={
          <Button type="primary" onClick={() => setRefusal(null)}>
            {t('common.ok')}
          </Button>
        }
        onCancel={() => setRefusal(null)}
      >
        <Alert
          type="error"
          showIcon
          message={t('generation.refusalBody')}
          style={{ marginBottom: 12 }}
        />
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {(refusal ?? []).map((c, i) => (
            <div
              key={`${c.kind}-${i}`}
              style={{
                padding: '6px 8px',
                border: '1px solid #E5E7EB',
                borderLeft: `3px solid ${KIND_COLORS[c.kind]}`,
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <Space size={6}>
                <Tag color={KIND_COLORS[c.kind]}>
                  {t(`conflicts.kinds.${c.kind}`)}
                </Tag>
                <Text strong dir="auto">
                  {c.entityLabel}
                </Text>
              </Space>
              <div style={{ marginTop: 2 }}>
                {dayjs(c.date).format('dddd DD/MM/YYYY')} ·{' '}
                {t('sessions.refusal.overlap')}{' '}
                {minToHHMM(c.startMin)}–{minToHHMM(c.endMin)}
              </div>
              <div dir="auto" style={{ color: '#6B7280' }}>
                {c.sessions.length > 0
                  ? c.sessions.map((s) => s.label).join(' ↔ ')
                  : c.detail}
              </div>
            </div>
          ))}
        </Space>
      </Modal>
    </Space>
  );
}
