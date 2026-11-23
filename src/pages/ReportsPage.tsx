/**
 * ReportsPage (P10 — FR-40→44) — 10 rapports calculés côté main
 * (`reports:run`), présentés en table générique `columns/rows`
 * (`dir="auto"` sur les cellules — noms arabes RTL conservés), cartes
 * récap quand le rapport expose un `summary`, exports CSV
 * (`reports:exportCsv` — BOM UTF-8 + `;` côté main) et PDF
 * (`reports:exportPdf` — le renderer envoie un HTML autonome table
 * print + en-tête, le main imprime via `webContents.printToPDF`).
 * Filtres contextuels (FR-43) : RangePicker période, Select entité
 * selon le rapport, DatePicker semaine pour `edt_hebdo`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Select,
  Space,
  Statistic,
  Table,
  Typography,
  message,
} from 'antd';
import {
  BarChartOutlined,
  FileExcelOutlined,
  FilePdfOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import type {
  MasterRow,
  ProfessorRow,
  Report,
  ReportFilter,
  ReportId,
  ReportRow,
  Room,
} from '../../shared/types';

const { Text, Title } = Typography;

/** Lundi (AD-7 : 0=lun) de la semaine contenant `d`. */
function mondayOf(d: Dayjs): Dayjs {
  return d.subtract((d.day() + 6) % 7, 'day');
}

/** Filtres affichés par rapport (FR-43). */
interface FilterFlags {
  period?: boolean;
  week?: boolean;
  master?: boolean;
  professor?: boolean;
  room?: boolean;
}

const REPORT_DEFS: { group: string; items: ReportId[] }[] = [
  {
    group: 'timetable',
    items: ['edt_hebdo', 'salles_planning', 'prof_programme'],
  },
  {
    group: 'suivi',
    items: [
      'bilan_heures',
      'non_realisees',
      'annulees_reportees',
      'absences',
      'avancement',
      'conflits_restes',
    ],
  },
  { group: 'occupation', items: ['occupation_salles'] },
];

const FILTERS: Record<ReportId, FilterFlags> = {
  edt_hebdo: { week: true, master: true },
  salles_planning: { period: true, room: true },
  prof_programme: { period: true, professor: true },
  bilan_heures: { period: true, master: true, professor: true },
  non_realisees: { period: true, master: true, professor: true, room: true },
  annulees_reportees: {
    period: true,
    master: true,
    professor: true,
    room: true,
  },
  absences: { period: true, professor: true },
  avancement: { period: true, master: true },
  occupation_salles: { period: true, room: true },
  conflits_restes: { period: true, master: true },
};

interface TableRow extends ReportRow {
  _key: number;
}

// --- HTML autonome pour le PDF (FR-41) ------------------------------------------

function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Document HTML autonome du rapport : en-tête (titre app + titre du
 * rapport + date d'édition + période) puis table print-styled. Cellules
 * en `dir="auto"` : le RTL des noms arabes est conservé à l'impression.
 */
export function reportToHtml(
  report: Report,
  meta: { period: string; editedOn: string; appTitle: string; rowsLabel: string },
): string {
  const th = report.columns
    .map((c) => `<th>${escapeHtml(c.label)}</th>`)
    .join('');
  const trs = report.rows
    .map(
      (r) =>
        `<tr>${report.columns
          .map((c) => `<td dir="auto">${escapeHtml(r[c.key] ?? '')}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(report.title)}</title>
<style>
  @page { margin: 12mm; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 10px;
         color: #111; margin: 0; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  h2 { font-size: 12px; font-weight: 600; color: #1D4ED8; margin: 0 0 8px; }
  .meta { color: #555; font-size: 9px; margin-bottom: 10px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #c9cdd4; padding: 3px 5px; text-align: left;
           vertical-align: top; }
  thead th { background: #1D4ED8; color: #fff; }
  tbody tr:nth-child(even) td { background: #f4f6fa; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
</style>
</head>
<body>
  <h1>${escapeHtml(meta.appTitle)}</h1>
  <h2>${escapeHtml(report.title)}</h2>
  <div class="meta">${escapeHtml(meta.editedOn)} · ${escapeHtml(meta.period)} · ${escapeHtml(meta.rowsLabel)}</div>
  <table>
    <thead><tr>${th}</tr></thead>
    <tbody>${trs}</tbody>
  </table>
</body>
</html>`;
}

// --- Page -------------------------------------------------------------------------

export function ReportsPage(): React.JSX.Element {
  const { t } = useTranslation();

  const [reportId, setReportId] = useState<ReportId>('edt_hebdo');
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [weekValue, setWeekValue] = useState<Dayjs>(() => mondayOf(dayjs()));
  const [masterId, setMasterId] = useState<number | undefined>(undefined);
  const [professorId, setProfessorId] = useState<number | undefined>(undefined);
  const [roomId, setRoomId] = useState<number | undefined>(undefined);

  const [masters, setMasters] = useState<MasterRow[]>([]);
  const [professors, setProfessors] = useState<ProfessorRow[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);

  const flags = FILTERS[reportId];

  useEffect(() => {
    if (!hasApi()) {
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
  }, [t]);

  const buildFilter = useCallback((): ReportFilter => {
    return {
      date_from: flags.period ? range?.[0]?.format('YYYY-MM-DD') : undefined,
      date_to: flags.period ? range?.[1]?.format('YYYY-MM-DD') : undefined,
      week: flags.week ? mondayOf(weekValue).format('YYYY-MM-DD') : undefined,
      master_id: flags.master ? masterId : undefined,
      professor_id: flags.professor ? professorId : undefined,
      room_id: flags.room ? roomId : undefined,
    };
  }, [flags, range, weekValue, masterId, professorId, roomId]);

  const run = useCallback(async (): Promise<void> => {
    if (!hasApi()) return;
    setLoading(true);
    setError(null);
    setExportedPath(null);
    try {
      const res = await api().reports.run(reportId, buildFilter());
      if (res.ok) setReport(res.data);
      else {
        setReport(null);
        setError(errorMessage(res));
      }
    } catch (err) {
      setReport(null);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [reportId, buildFilter]);

  // Exécution automatique au montage et au changement de rapport.
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  const periodLabel = useMemo((): string => {
    if (flags.week) {
      const monday = mondayOf(weekValue).format('DD/MM/YYYY');
      const sunday = mondayOf(weekValue).add(6, 'day').format('DD/MM/YYYY');
      return `${monday} → ${sunday}`;
    }
    const from = range?.[0]?.format('DD/MM/YYYY');
    const to = range?.[1]?.format('DD/MM/YYYY');
    if (from && to) return t('reports.periodRange', { from, to });
    if (from) return `≥ ${from}`;
    if (to) return `≤ ${to}`;
    return t('reports.periodAll');
  }, [flags.week, weekValue, range, t]);

  const columns: ColumnsType<TableRow> = useMemo(
    () =>
      (report?.columns ?? []).map((c) => ({
        key: c.key,
        title: c.label,
        dataIndex: c.key,
        render: (v: string | number | null) => (
          <span dir="auto">{v ?? '—'}</span>
        ),
      })),
    [report],
  );

  const tableRows: TableRow[] = useMemo(
    () => (report?.rows ?? []).map((r, i) => ({ ...r, _key: i })),
    [report],
  );

  const exportCsv = async (): Promise<void> => {
    if (!report || !hasApi()) return;
    setExporting('csv');
    try {
      const res = await api().reports.exportCsv(report);
      if (res.ok) {
        if (res.data.cancelled) {
          void message.info(t('reports.export.cancelled'));
        } else {
          setExportedPath(res.data.path);
          void message.success(t('reports.export.done'));
        }
      } else {
        void message.error(errorMessage(res));
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setExporting(null);
    }
  };

  const exportPdf = async (): Promise<void> => {
    if (!report || !hasApi()) return;
    setExporting('pdf');
    try {
      const html = reportToHtml(report, {
        appTitle: t('app.title'),
        period: periodLabel,
        editedOn: t('reports.editedOn', {
          date: dayjs().format('DD/MM/YYYY HH:mm'),
        }),
        rowsLabel: t('reports.rows', { count: report.rows.length }),
      });
      const res = await api().reports.exportPdf({
        report_id: report.id,
        html,
      });
      if (res.ok) {
        if (res.data.cancelled) {
          void message.info(t('reports.export.cancelled'));
        } else {
          setExportedPath(res.data.path);
          void message.success(t('reports.export.done'));
        }
      } else {
        void message.error(errorMessage(res));
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setExporting(null);
    }
  };

  const reportOptions = REPORT_DEFS.map((g) => ({
    label: t(`reports.groups.${g.group}`),
    options: g.items.map((id) => ({
      value: id,
      label: t(`reports.items.${id}`),
    })),
  }));

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Title level={3} style={{ margin: 0 }}>
        <BarChartOutlined /> {t('reports.title')}
      </Title>

      {/* Sélecteur de rapport (groupé) + filtres contextuels. */}
      <Space wrap>
        <Select
          style={{ minWidth: 300 }}
          value={reportId}
          options={reportOptions}
          onChange={(id) => {
            setReportId(id);
            setReport(null);
          }}
        />
        {flags.week && (
          <DatePicker
            picker="week"
            value={weekValue}
            allowClear={false}
            format="DD/MM/YYYY"
            placeholder={t('reports.filters.week')}
            onChange={(d) => {
              if (d) setWeekValue(mondayOf(d));
            }}
          />
        )}
        {flags.period && (
          <DatePicker.RangePicker
            value={range}
            onChange={(v) => setRange(v)}
            format="DD/MM/YYYY"
            placeholder={[
              t('reports.filters.dateFrom'),
              t('reports.filters.dateTo'),
            ]}
            allowClear
          />
        )}
        {flags.master && (
          <Select
            showSearch
            allowClear
            optionFilterProp="label"
            placeholder={t('reports.filters.master')}
            style={{ minWidth: 220 }}
            value={masterId}
            onChange={setMasterId}
            options={masters.map((m) => ({
              value: m.id,
              label: `${m.code} — ${m.name}`,
            }))}
          />
        )}
        {flags.professor && (
          <Select
            showSearch
            allowClear
            optionFilterProp="label"
            placeholder={t('reports.filters.professor')}
            style={{ minWidth: 200 }}
            value={professorId}
            onChange={setProfessorId}
            options={professors.map((p) => ({
              value: p.id,
              label: p.full_name,
            }))}
          />
        )}
        {flags.room && (
          <Select
            showSearch
            allowClear
            optionFilterProp="label"
            placeholder={t('reports.filters.room')}
            style={{ minWidth: 160 }}
            value={roomId}
            onChange={setRoomId}
            options={rooms.map((r) => ({ value: r.id, label: r.name }))}
          />
        )}
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          loading={loading}
          onClick={() => void run()}
        >
          {t('reports.filters.run')}
        </Button>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => void run()}
          title={t('conflicts.refresh')}
        />
      </Space>

      {error && <Alert type="error" showIcon message={error} />}

      {/* Cartes récap quand le rapport expose un summary. */}
      {report?.summary && report.summary.length > 0 && (
        <Space wrap size="large">
          {report.summary.map((s) => (
            <Statistic
              key={s.key}
              title={s.label}
              value={s.value}
              loading={loading && report == null}
            />
          ))}
        </Space>
      )}

      {/* Exports + chemin du fichier produit. */}
      <Space wrap>
        <Button
          icon={<FileExcelOutlined />}
          disabled={report == null}
          loading={exporting === 'csv'}
          onClick={() => void exportCsv()}
        >
          {t('reports.export.csv')}
        </Button>
        <Button
          icon={<FilePdfOutlined />}
          disabled={report == null}
          loading={exporting === 'pdf'}
          onClick={() => void exportPdf()}
        >
          {t('reports.export.pdf')}
        </Button>
        {exportedPath && (
          <Text type="secondary" copyable={{ text: exportedPath }}>
            {t('reports.export.file', { path: exportedPath })}
          </Text>
        )}
      </Space>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<TableRow>
          size="small"
          rowKey="_key"
          loading={loading}
          columns={columns}
          dataSource={tableRows}
          locale={{ emptyText: t('reports.empty') }}
          scroll={{ x: true, y: 480 }}
          pagination={{
            pageSize: 50,
            showSizeChanger: true,
            showTotal: (total) => t('reports.rows', { count: total }),
          }}
        />
      </Card>
    </Space>
  );
}
