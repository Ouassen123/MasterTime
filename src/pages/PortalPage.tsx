/**
 * PortalPage (P19) — console du portail web public.
 *
 * - Interrupteur serveur ON/OFF + port + URLs (localhost + IP réseau)
 * - Compteur « en ligne » temps réel (visiteurs + profs connectés)
 * - Demandes profs : approuver (applique annulation/report + publie
 *   l'avis bilingue) ou rejeter avec note
 * - Réclamations : inbox lu/traité
 * - Comptes profs : créer / réinitialiser / activer-désactiver
 * - Avis publiés : activer/dépublier
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  GlobalOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import type {
  PortalAccountRow,
  PortalAnnouncementRow,
  PortalComplaintRow,
  PortalRequestRow,
  ProfessorRow,
  Room,
  WebPortalStatus,
} from '../../shared/types';

const { Title, Text } = Typography;

const hm = (m: number | null): string =>
  m == null
    ? ''
    : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function PortalPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WebPortalStatus | null>(null);
  const [port, setPort] = useState(8080);
  const [online, setOnline] = useState({ visitors: 0, professors: 0 });
  const [requests, setRequests] = useState<PortalRequestRow[]>([]);
  const [reqStatus, setReqStatus] = useState('pending');
  const [complaints, setComplaints] = useState<PortalComplaintRow[]>([]);
  const [accounts, setAccounts] = useState<PortalAccountRow[]>([]);
  const [profs, setProfs] = useState<ProfessorRow[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [announcements, setAnnouncements] = useState<PortalAnnouncementRow[]>(
    [],
  );
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!hasApi()) return;
    const [st, on] = await Promise.all([
      api().webportal.status(),
      api().webportal.online(),
    ]);
    if (st.ok) setStatus(st.data);
    if (on.ok) setOnline(on.data);
  }, []);

  const loadRequests = useCallback(async () => {
    const r = await api().webportal.requests(reqStatus);
    if (r.ok) setRequests(r.data);
  }, [reqStatus]);

  const loadComplaints = useCallback(async () => {
    const r = await api().webportal.complaints();
    if (r.ok) setComplaints(r.data);
  }, []);

  const loadAccounts = useCallback(async () => {
    const [r, p, ro] = await Promise.all([
      api().webportal.accounts(),
      api().professors.list(),
      api().rooms.list(),
    ]);
    if (r.ok) setAccounts(r.data);
    if (p.ok) setProfs(p.data);
    if (ro.ok) setRooms(ro.data);
  }, []);

  const loadAnnouncements = useCallback(async () => {
    const r = await api().webportal.announcements();
    if (r.ok) setAnnouncements(r.data);
  }, []);

  useEffect(() => {
    void refresh();
    void loadRequests();
    void loadComplaints();
    void loadAccounts();
    void loadAnnouncements();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh, loadRequests, loadComplaints, loadAccounts, loadAnnouncements]);

  useEffect(() => void loadRequests(), [loadRequests]);

  const toggleServer = async (on: boolean) => {
    setBusy(true);
    const r = on
      ? await api().webportal.start(port)
      : await api().webportal.stop();
    setBusy(false);
    if (!r.ok) message.error(errorMessage(r));
    void refresh();
  };

  const toMin = (s: string): number => {
    const [h, m] = s.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  /** Approbation : si le prof n'a pas proposé de créneau, l'admin le choisit. */
  const approveRequest = (r: PortalRequestRow) => {
    if (r.kind === 'move' && !r.proposed_date) {
      let date = r.session_date;
      let start = hm(r.session_start_min);
      let end = hm(r.session_end_min);
      let roomId = r.session_room_id;
      Modal.confirm({
        title: t('portal.pickSlotTitle'),
        width: 400,
        content: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <Text type="secondary">{t('portal.slotDate')}</Text>
              <Input
                type="date"
                defaultValue={date}
                onChange={(e) => {
                  date = e.target.value;
                }}
              />
            </div>
            <Space>
              <div>
                <Text type="secondary">{t('portal.slotStart')}</Text>
                <Input
                  type="time"
                  defaultValue={start}
                  onChange={(e) => {
                    start = e.target.value;
                  }}
                />
              </div>
              <div>
                <Text type="secondary">{t('portal.slotEnd')}</Text>
                <Input
                  type="time"
                  defaultValue={end}
                  onChange={(e) => {
                    end = e.target.value;
                  }}
                />
              </div>
            </Space>
            <div>
              <Text type="secondary">{t('portal.slotRoom')}</Text>
              <Select
                style={{ width: '100%' }}
                showSearch
                optionFilterProp="label"
                defaultValue={roomId}
                options={rooms
                  .filter((ro) => ro.is_active === 1)
                  .map((ro) => ({
                    value: ro.id,
                    label: `${ro.name}${ro.capacity ? ` (${ro.capacity})` : ''}`,
                  }))}
                onChange={(v) => {
                  roomId = v;
                }}
              />
            </div>
          </Space>
        ),
        onOk: async () => {
          const res = await api().webportal.approve(r.id, '', {
            date,
            start_min: toMin(start),
            end_min: toMin(end),
            room_id: roomId,
          });
          if (res.ok) {
            message.success(t('portal.approvedMsg'));
            void loadRequests();
            void loadAnnouncements();
          } else message.error(errorMessage(res));
        },
      });
      return;
    }
    Modal.confirm({
      title: t('portal.confirmApprove'),
      onOk: () => decide(r.id, 'approve'),
    });
  };

  const decide = async (
    id: number,
    action: 'approve' | 'reject',
  ) => {
    const r =
      action === 'approve'
        ? await api().webportal.approve(id)
        : await api().webportal.reject(id);
    if (r.ok) {
      message.success(
        action === 'approve'
          ? t('portal.approvedMsg')
          : t('portal.rejectedMsg'),
      );
      void loadRequests();
      void loadAnnouncements();
    } else {
      message.error(errorMessage(r));
    }
  };

  const requestCols: ColumnsType<PortalRequestRow> = [
    {
      title: t('portal.colProf'),
      dataIndex: 'professor_name',
      render: (v: string) => <span dir="auto">{v}</span>,
    },
    {
      title: t('portal.colSession'),
      dataIndex: 'session_label',
      render: (v: string) => <span dir="auto">{v}</span>,
    },
    {
      title: t('portal.colKind'),
      width: 110,
      render: (_, r) =>
        r.kind === 'cancel' ? (
          <Tag color="red">{t('portal.kindCancel')}</Tag>
        ) : (
          <Tag color="gold">{t('portal.kindMove')}</Tag>
        ),
    },
    {
      title: t('portal.colProposed'),
      render: (_, r) =>
        r.kind !== 'move' ? (
          '—'
        ) : r.proposed_date ? (
          <span dir="auto">
            {`${r.proposed_date} ${hm(r.proposed_start_min)}–${hm(r.proposed_end_min)} · ${r.proposed_room_name ?? ''}`}
          </span>
        ) : (
          <Tag color="blue">{t('portal.slotToChoose')}</Tag>
        ),
    },
    {
      title: t('portal.colReason'),
      dataIndex: 'reason',
      render: (v: string) => <span dir="auto">{v || '—'}</span>,
    },
    {
      title: t('portal.colStatus'),
      width: 100,
      render: (_, r) => (
        <Tag
          color={
            r.status === 'approved'
              ? 'green'
              : r.status === 'rejected'
                ? 'red'
                : 'gold'
          }
        >
          {t(`portal.status.${r.status}`)}
        </Tag>
      ),
    },
    {
      title: '',
      width: 190,
      render: (_, r) =>
        r.status === 'pending' ? (
          <Space>
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              onClick={() => approveRequest(r)}
            >
              {t('portal.approve')}
            </Button>
            <Button
              size="small"
              danger
              icon={<CloseOutlined />}
              onClick={() => {
                let note = '';
                Modal.confirm({
                  title: t('portal.confirmReject'),
                  content: (
                    <Input.TextArea
                      rows={2}
                      placeholder={t('portal.notePlaceholder')}
                      onChange={(e) => {
                        note = e.target.value;
                      }}
                    />
                  ),
                  onOk: async () => {
                    const res = await api().webportal.reject(r.id, note);
                    if (res.ok) {
                      void loadRequests();
                    } else message.error(errorMessage(res));
                  },
                });
              }}
            >
              {t('portal.reject')}
            </Button>
          </Space>
        ) : null,
    },
  ];

  const complaintCols: ColumnsType<PortalComplaintRow> = [
    {
      title: t('portal.colDate'),
      dataIndex: 'created_at',
      width: 160,
      render: (v: string) => new Date(v + 'Z').toLocaleString('fr-FR'),
    },
    {
      title: t('portal.colAuthor'),
      render: (_, r) => (
        <span dir="auto">
          {r.author_name || '—'} <Tag>{r.author_role}</Tag>
        </span>
      ),
    },
    { title: t('portal.colMessage'), dataIndex: 'message' },
    {
      title: t('portal.colStatus'),
      width: 110,
      render: (_, r) => (
        <Tag
          color={
            r.status === 'handled' ? 'green' : r.status === 'read' ? 'blue' : 'gold'
          }
        >
          {t(`portal.complaint.${r.status}`)}
        </Tag>
      ),
    },
    {
      title: '',
      width: 170,
      render: (_, r) => (
        <Space>
          {r.status === 'new' && (
            <Button
              size="small"
              onClick={async () => {
                await api().webportal.setComplaintStatus(r.id, 'read');
                void loadComplaints();
              }}
            >
              {t('portal.markRead')}
            </Button>
          )}
          {r.status !== 'handled' && (
            <Button
              size="small"
              type="primary"
              onClick={async () => {
                await api().webportal.setComplaintStatus(r.id, 'handled');
                void loadComplaints();
              }}
            >
              {t('portal.markHandled')}
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const accountCols: ColumnsType<PortalAccountRow> = [
    {
      title: t('portal.colProf'),
      dataIndex: 'professor_name',
      render: (v: string) => <span dir="auto">{v}</span>,
    },
    { title: t('portal.colLogin'), dataIndex: 'login' },
    {
      title: t('portal.colActive'),
      width: 110,
      render: (_, r) => (
        <Switch
          checked={r.is_active === 1}
          onChange={async (on) => {
            await api().webportal.toggleAccount(r.id, on);
            void loadAccounts();
          }}
        />
      ),
    },
    {
      title: '',
      width: 200,
      render: (_, r) => (
        <Button
          size="small"
          onClick={() => {
            let pwd = '';
            Modal.confirm({
              title: t('portal.resetPwd'),
              content: (
                <Input.Password
                  placeholder={t('portal.newPwd')}
                  onChange={(e) => {
                    pwd = e.target.value;
                  }}
                />
              ),
              onOk: async () => {
                const res = await api().webportal.resetPassword(r.id, pwd);
                if (res.ok) message.success(t('portal.pwdReset'));
                else message.error(errorMessage(res));
              },
            });
          }}
        >
          {t('portal.resetPwd')}
        </Button>
      ),
    },
  ];

  /** Modal création / modification d'un avis bilingue. */
  const announcementModal = (r?: PortalAnnouncementRow) => {
    let titleFr = r?.title_fr ?? '';
    let bodyFr = r?.body_fr ?? '';
    let titleAr = r?.title_ar ?? '';
    let bodyAr = r?.body_ar ?? '';
    Modal.confirm({
      title: r ? t('portal.editAnn') : t('portal.newAnnouncement'),
      width: 520,
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input
            placeholder={t('portal.annTitleFr')}
            defaultValue={titleFr}
            onChange={(e) => {
              titleFr = e.target.value;
            }}
          />
          <Input.TextArea
            rows={3}
            placeholder={t('portal.annBodyFr')}
            defaultValue={bodyFr}
            onChange={(e) => {
              bodyFr = e.target.value;
            }}
          />
          <Input
            dir="rtl"
            placeholder={t('portal.annTitleAr')}
            defaultValue={titleAr}
            onChange={(e) => {
              titleAr = e.target.value;
            }}
          />
          <Input.TextArea
            rows={3}
            dir="rtl"
            placeholder={t('portal.annBodyAr')}
            defaultValue={bodyAr}
            onChange={(e) => {
              bodyAr = e.target.value;
            }}
          />
        </Space>
      ),
      onOk: async () => {
        const input = {
          title_fr: titleFr,
          title_ar: titleAr,
          body_fr: bodyFr,
          body_ar: bodyAr,
        };
        const res = r
          ? await api().webportal.updateAnnouncement(r.id, input)
          : await api().webportal.createAnnouncement(input);
        if (res.ok) {
          message.success(r ? t('portal.annUpdated') : t('portal.annSaved'));
          void loadAnnouncements();
        } else message.error(errorMessage(res));
      },
    });
  };

  const annCols: ColumnsType<PortalAnnouncementRow> = [
    {
      title: t('portal.colPublished'),
      dataIndex: 'published_at',
      width: 160,
      render: (v: string) => new Date(v + 'Z').toLocaleString('fr-FR'),
    },
    {
      title: t('portal.colTitle'),
      render: (_, r) => (
        <div>
          <div dir="auto">
            <b>{r.title_fr}</b> — {r.body_fr}
          </div>
          {r.body_ar && (
            <div
              dir="rtl"
              lang="ar"
              style={{ color: '#64748b', fontSize: 13 }}
            >
              {r.title_ar} — {r.body_ar}
            </div>
          )}
        </div>
      ),
    },
    {
      title: t('portal.colActive'),
      width: 110,
      render: (_, r) => (
        <Switch
          checked={r.is_active === 1}
          onChange={async (on) => {
            await api().webportal.setAnnouncementActive(r.id, on);
            void loadAnnouncements();
          }}
        />
      ),
    },
    {
      title: '',
      width: 180,
      render: (_, r) => (
        <Space>
          <Button size="small" onClick={() => announcementModal(r)}>
            {t('portal.editAnn')}
          </Button>
          <Button
            size="small"
            danger
            onClick={() =>
              Modal.confirm({
                title: t('portal.confirmDeleteAnn'),
                onOk: async () => {
                  const res = await api().webportal.deleteAnnouncement(r.id);
                  if (res.ok) {
                    message.success(t('portal.annDeleted'));
                    void loadAnnouncements();
                  } else message.error(errorMessage(res));
                },
              })
            }
          >
            {t('portal.deleteAnn')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Title level={3} style={{ marginBottom: 0 }}>
        <GlobalOutlined /> {t('portal.title')}
      </Title>

      <Card>
        <Space size={24} wrap align="center">
          <Space>
            <Text strong>{t('portal.server')}</Text>
            <Switch
              checked={status?.running ?? false}
              loading={busy}
              onChange={(on) => void toggleServer(on)}
            />
            <InputNumber
              min={1024}
              max={65535}
              value={port}
              onChange={(v) => setPort(Number(v) || 8080)}
              disabled={status?.running}
              addonBefore={t('portal.port')}
            />
          </Space>
          <Badge
            status={status?.running ? 'success' : 'default'}
            text={
              status?.running ? t('portal.running') : t('portal.stopped')
            }
          />
          <Tooltip title={t('portal.refresh')}>
            <Button icon={<ReloadOutlined />} onClick={() => void refresh()} />
          </Tooltip>
          <Text>
            🟢 {t('portal.online', {
              visitors: online.visitors,
              profs: online.professors,
            })}
          </Text>
        </Space>
        {status?.running && (
          <div style={{ marginTop: 10 }}>
            {status.urls.map((u) => (
              <div key={u}>
                <a href={u} target="_blank" rel="noreferrer">
                  {u}
                </a>
              </div>
            ))}
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('portal.lanHint')}
            </Text>
          </div>
        )}
      </Card>

      <Tabs
        items={[
          {
            key: 'requests',
            label: (
              <Badge count={requests.filter((r) => r.status === 'pending').length}>
                {t('portal.tabRequests')}
              </Badge>
            ),
            children: (
              <>
                <Space style={{ marginBottom: 10 }}>
                  <Select
                    value={reqStatus}
                    onChange={setReqStatus}
                    options={[
                      { value: 'pending', label: t('portal.status.pending') },
                      { value: 'approved', label: t('portal.status.approved') },
                      { value: 'rejected', label: t('portal.status.rejected') },
                      { value: 'all', label: t('portal.status.all') },
                    ]}
                    style={{ width: 160 }}
                  />
                </Space>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={requests}
                  columns={requestCols}
                  pagination={{ pageSize: 15 }}
                />
              </>
            ),
          },
          {
            key: 'complaints',
            label: (
              <Badge
                count={complaints.filter((c) => c.status === 'new').length}
              >
                {t('portal.tabComplaints')}
              </Badge>
            ),
            children: (
              <Table
                rowKey="id"
                size="small"
                dataSource={complaints}
                columns={complaintCols}
                pagination={{ pageSize: 15 }}
              />
            ),
          },
          {
            key: 'accounts',
            label: t('portal.tabAccounts'),
            children: (
              <>
                <Button
                  type="primary"
                  style={{ marginBottom: 10 }}
                  onClick={() => {
                    let pid = 0;
                    let login = '';
                    let pwd = '';
                    Modal.confirm({
                      title: t('portal.newAccount'),
                      width: 420,
                      content: (
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Select
                            showSearch
                            optionFilterProp="label"
                            style={{ width: '100%' }}
                            placeholder={t('portal.pickProf')}
                            options={profs
                              .filter(
                                (p) =>
                                  !accounts.some(
                                    (a) => a.professor_id === p.id,
                                  ),
                              )
                              .map((p) => ({
                                value: p.id,
                                label: p.full_name,
                              }))}
                            onChange={(v) => {
                              pid = v;
                            }}
                          />
                          <Input
                            placeholder={t('portal.loginPh')}
                            onChange={(e) => {
                              login = e.target.value;
                            }}
                          />
                          <Input.Password
                            placeholder={t('portal.pwdPh')}
                            onChange={(e) => {
                              pwd = e.target.value;
                            }}
                          />
                        </Space>
                      ),
                      onOk: async () => {
                        const res = await api().webportal.createAccount(
                          pid,
                          login,
                          pwd,
                        );
                        if (res.ok) {
                          message.success(t('portal.accountCreated'));
                          void loadAccounts();
                        } else message.error(errorMessage(res));
                      },
                    });
                  }}
                >
                  {t('portal.newAccount')}
                </Button>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={accounts}
                  columns={accountCols}
                  pagination={{ pageSize: 15 }}
                />
              </>
            ),
          },
          {
            key: 'announcements',
            label: t('portal.tabAnnouncements'),
            children: (
              <>
                <Button
                  type="primary"
                  style={{ marginBottom: 10 }}
                  onClick={() => announcementModal()}
                >
                  {t('portal.newAnnouncement')}
                </Button>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={announcements}
                  columns={annCols}
                  pagination={{ pageSize: 15 }}
                />
              </>
            ),
          },
        ]}
      />
    </Space>
  );
}
