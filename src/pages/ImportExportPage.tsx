/**
 * ImportExportPage (P11 — FR-45→49, BR-21) — deux onglets :
 *
 * **Importer** : Select type → gabarit téléchargeable (en-têtes FR +
 * exemple) → `Upload.Dragger` (lecture texte UTF-8, borne 5 Mo côté
 * UI / 10 000 lignes côté main) → aperçu ligne par ligne (statuts
 * taggés OK / Doublon / Erreur, erreurs par ligne, compteurs,
 * colonnes inconnues en avertissement) → Radio stratégie de conflit
 * (IGNORER / FUSIONNER / REMPLACER — par lot, BR-21) → bouton
 * Importer (réservé ADMIN côté main, BR-24) → résultat chiffré +
 * erreurs restantes. Une seule requête IPC porte le texte du fichier.
 *
 * **Exporter** : bouton CSV par entité (salles, professeurs, modules,
 * masters, étudiants, master-modules, séances) — même save-dialog que
 * les rapports ; BOM UTF-8 + `;` produits côté main.
 *
 * `dir="auto"` sur les cellules — les noms arabes (étudiants,
 * professeurs, masters) restent lisibles en RTL.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Radio,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  DownloadOutlined,
  FileExcelOutlined,
  InboxOutlined,
  SwapOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import type {
  ExportEntityType,
  ImportApplyResult,
  ImportEntityType,
  ImportPreview,
  ImportRow,
  ImportStrategy,
} from '../../shared/types';
import { EXPORT_TYPES, IMPORT_TYPES, IMPORT_STRATEGIES } from '../../shared/types';

const { Text, Title } = Typography;
const { Dragger } = Upload;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // borne UI : 5 Mo (spec §4)

const STATUS_COLOR: Record<ImportRow['status'], string> = {
  OK: 'green',
  DOUBLON: 'orange',
  ERREUR: 'red',
};

interface TableRow extends ImportRow {
  _key: number;
}

export function ImportExportPage(): React.JSX.Element {
  const { t } = useTranslation();

  const [type, setType] = useState<ImportEntityType>('salles');
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [strategy, setStrategy] = useState<ImportStrategy>('IGNORER');
  const [result, setResult] = useState<ImportApplyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [exporting, setExporting] = useState<ExportEntityType | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetFile = useCallback((): void => {
    setFileName(null);
    setCsvText(null);
    setPreview(null);
    setResult(null);
    setError(null); // résultat + erreur vidés au changement de type
  }, []);

  const entityOptions = IMPORT_TYPES.map((v) => ({
    value: v,
    label: t(`importExport.entity.${v}`),
  }));

  const runPreview = useCallback(
    async (text: string, tpe: ImportEntityType): Promise<void> => {
      if (!hasApi()) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api().importExport.preview(tpe, text);
        if (res.ok) {
          setPreview(res.data);
        } else {
          setPreview(null);
          setError(errorMessage(res));
        }
      } catch (err) {
        setPreview(null);
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const readFile = useCallback(
    async (file: File): Promise<void> => {
      if (file.size > MAX_FILE_BYTES) {
        void message.error(t('importExport.fileTooBig'));
        return;
      }
      try {
        const text = await file.text();
        setFileName(file.name);
        setCsvText(text);
        setResult(null);
        await runPreview(text, type);
      } catch {
        void message.error(t('importExport.fileReadError'));
      }
    },
    [runPreview, t, type],
  );

  const downloadTemplate = async (): Promise<void> => {
    if (!hasApi()) return;
    try {
      const res = await api().importExport.template(type);
      if (res.ok) {
        if (res.data.cancelled) {
          void message.info(t('importExport.cancelled'));
        } else {
          void message.success(t('importExport.templateDone'));
        }
      } else {
        void message.error(errorMessage(res));
      }
    } catch (err) {
      void message.error(errorMessage(err));
    }
  };

  const apply = async (): Promise<void> => {
    if (!hasApi() || csvText == null) return;
    setApplying(true);
    setError(null);
    try {
      const res = await api().importExport.apply(type, csvText, strategy);
      if (res.ok) {
        setResult(res.data);
        void message.success(
          t('importExport.result.done', {
            inserted: res.data.inserted,
            merged: res.data.merged,
            ignored: res.data.ignored,
          }),
        );
        // L'état a changé : rafraîchir l'aperçu pour refléter la base.
        await runPreview(csvText, type);
      } else {
        setResult(null);
        setError(errorMessage(res));
      }
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setApplying(false);
    }
  };

  const exportEntity = async (tpe: ExportEntityType): Promise<void> => {
    if (!hasApi()) return;
    setExporting(tpe);
    try {
      const res = await api().importExport.exportEntity(tpe);
      if (res.ok) {
        if (res.data.cancelled) {
          void message.info(t('importExport.cancelled'));
        } else {
          setExportedPath(res.data.path);
          void message.success(t('importExport.export.done'));
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

  // --- Aperçu ----------------------------------------------------------------

  const counts = useMemo(() => {
    const c = { OK: 0, DOUBLON: 0, ERREUR: 0 };
    for (const r of preview?.rows ?? []) c[r.status]++;
    return c;
  }, [preview]);

  const importable = counts.OK + counts.DOUBLON;

  const columns: ColumnsType<TableRow> = useMemo(() => {
    const base: ColumnsType<TableRow> = [
      {
        key: 'n',
        title: t('importExport.preview.line'),
        dataIndex: 'n',
        width: 70,
      },
      {
        key: 'status',
        title: t('importExport.preview.status'),
        width: 110,
        render: (_v, r) => (
          <Tag color={STATUS_COLOR[r.status]}>
            {t(`importExport.preview.statuses.${r.status}`)}
          </Tag>
        ),
      },
      {
        key: 'errors',
        title: t('importExport.preview.errors'),
        render: (_v, r) =>
          r.errors.length > 0 ? (
            <Text type="danger" dir="auto">
              {r.errors.map((e) => e.message).join(' ')}
            </Text>
          ) : null,
      },
    ];
    for (const header of preview?.columns ?? []) {
      base.push({
        key: header,
        title: header,
        render: (_v, r) => <span dir="auto">{r.parsed[header] ?? '—'}</span>,
      });
    }
    return base;
  }, [preview, t]);

  const tableRows: TableRow[] = useMemo(
    () => (preview?.rows ?? []).map((r) => ({ ...r, _key: r.n })),
    [preview],
  );

  // --- Onglet Importer ---------------------------------------------------------

  const importTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <Select
          style={{ minWidth: 200 }}
          value={type}
          options={entityOptions}
          onChange={(v) => {
            setType(v);
            resetFile();
          }}
        />
        <Button icon={<DownloadOutlined />} onClick={() => void downloadTemplate()}>
          {t('importExport.template')}
        </Button>
        <Text type="secondary">{t('importExport.adminOnly')}</Text>
      </Space>

      <Dragger
        accept=".csv,.txt"
        showUploadList={false}
        beforeUpload={(file) => {
          void readFile(file);
          return false; // lecture locale uniquement, aucun upload
        }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">{t('importExport.drop.title')}</p>
        <p className="ant-upload-hint">{t('importExport.drop.hint')}</p>
      </Dragger>

      {fileName && (
        <Text type="secondary">
          <FileExcelOutlined /> {fileName}
        </Text>
      )}

      {error && <Alert type="error" showIcon message={error} />}

      {preview != null && preview.unknownColumns.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={t('importExport.preview.unknownColumns', {
            cols: preview.unknownColumns.join(', '),
          })}
        />
      )}

      {preview != null && (
        <>
          <Space wrap size="large">
            <Statistic
              title={t('importExport.preview.ok')}
              value={counts.OK}
              valueStyle={{ color: '#16A34A' }}
            />
            <Statistic
              title={t('importExport.preview.doublon')}
              value={counts.DOUBLON}
              valueStyle={{ color: '#D97706' }}
            />
            <Statistic
              title={t('importExport.preview.erreur')}
              value={counts.ERREUR}
              valueStyle={{ color: '#DC2626' }}
            />
          </Space>

          <Card size="small" styles={{ body: { padding: 0 } }}>
            <Table<TableRow>
              size="small"
              rowKey="_key"
              loading={loading}
              columns={columns}
              dataSource={tableRows}
              locale={{ emptyText: t('common.empty') }}
              scroll={{ x: true, y: 420 }}
              pagination={{ pageSize: 50, showSizeChanger: true }}
            />
          </Card>

          <Space direction="vertical" size="small">
            <Text strong>{t('importExport.strategy.title')}</Text>
            <Radio.Group
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as ImportStrategy)}
            >
              {IMPORT_STRATEGIES.map((s) => (
                <Radio key={s} value={s}>
                  {t(`importExport.strategy.${s}`)}
                </Radio>
              ))}
            </Radio.Group>
          </Space>

          <Space wrap>
            <Button
              type="primary"
              icon={<UploadOutlined />}
              disabled={importable === 0}
              loading={applying}
              onClick={() => void apply()}
            >
              {t('importExport.apply')}
            </Button>
          </Space>
        </>
      )}

      {result != null && (
        <Card size="small" title={t('importExport.result.title')}>
          <Space wrap size="large">
            <Statistic
              title={t('importExport.result.inserted')}
              value={result.inserted}
            />
            <Statistic
              title={t('importExport.result.merged')}
              value={result.merged}
            />
            <Statistic
              title={t('importExport.result.ignored')}
              value={result.ignored}
            />
            <Statistic
              title={t('importExport.result.errors')}
              value={result.errors.length}
              valueStyle={
                result.errors.length > 0 ? { color: '#DC2626' } : undefined
              }
            />
          </Space>
          {result.errors.length > 0 && (
            <Table
              size="small"
              style={{ marginTop: 12 }}
              rowKey={(r) => r.n}
              dataSource={result.errors}
              pagination={false}
              columns={[
                {
                  key: 'n',
                  title: t('importExport.result.line'),
                  dataIndex: 'n',
                  width: 80,
                },
                {
                  key: 'message',
                  title: t('importExport.result.message'),
                  dataIndex: 'message',
                  render: (v: string) => (
                    <Text type="danger" dir="auto">
                      {v}
                    </Text>
                  ),
                },
              ]}
            />
          )}
        </Card>
      )}
    </Space>
  );

  // --- Onglet Exporter ---------------------------------------------------------

  const exportTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Text type="secondary">{t('importExport.export.hint')}</Text>
      <Space wrap>
        {EXPORT_TYPES.map((tpe) => (
          <Button
            key={tpe}
            icon={<FileExcelOutlined />}
            loading={exporting === tpe}
            onClick={() => void exportEntity(tpe)}
          >
            {t(`importExport.entity.${tpe}`)}
          </Button>
        ))}
      </Space>
      {exportedPath && (
        <Text type="secondary" copyable={{ text: exportedPath }}>
          {t('importExport.export.file', { path: exportedPath })}
        </Text>
      )}
    </Space>
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Title level={3} style={{ margin: 0 }}>
        <SwapOutlined /> {t('importExport.title')}
      </Title>
      {!hasApi() && (
        <Alert type="error" showIcon message={t('db.unavailable')} />
      )}
      <Tabs
        items={[
          { key: 'import', label: t('importExport.tabs.import'), children: importTab },
          { key: 'export', label: t('importExport.tabs.export'), children: exportTab },
        ]}
      />
    </Space>
  );
}
