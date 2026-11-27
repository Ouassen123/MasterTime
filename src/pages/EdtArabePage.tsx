/**
 * EdtArabePage — vue « emploi du temps » au format officiel de la faculté
 * (même gabarit que les feuilles Excel / edt.html du portail) :
 * برنامج توزيع الحصص + en-tête (ماستر / السداسي / السنة الجامعية / المنسق)
 * puis tableau الوحدة | الأستاذ | اليوم | التوقيت | القاعة.
 *
 * Une feuille par master pour la semaine choisie ; filtres Semestre /
 * Professeur / Master. Avec un prof seul, chaque feuille ne montre que
 * ses séances (dans chacun de ses masters).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  DatePicker,
  Empty,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  LeftOutlined,
  PrinterOutlined,
  RightOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { api, errorMessage, hasApi } from '../api/client';
import { minToHHMM } from '../components/SessionDrawer';
import type {
  ContextSemesters,
  MasterRow,
  ProfessorRow,
  SessionRow,
} from '../../shared/types';

const { Text } = Typography;

const AR_DAYS = [
  'الإثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت',
  'الأحد',
];
const AR_ORDINALS = ['الأول', 'الثاني', 'الثالث', 'الرابع'];

/** Jour de la semaine (0=lun) d'une date ISO 'YYYY-MM-DD'. */
function weekdayOf(iso: string): number {
  return (new Date(`${iso}T00:00:00`).getDay() + 6) % 7;
}

/** Nom de salle traduit (même logique que MT.arRoom du portail). */
function arRoom(name: string): string {
  return String(name || '')
    .replace(/Salle/g, 'القاعة')
    .replace(/Amphi/g, 'المدرج')
    .replace(/Annexe/g, 'الملحقة')
    .trim();
}

/** Lundi ISO de la semaine contenant `d`. */
function mondayOf(d: Dayjs): Dayjs {
  return d.subtract((d.day() + 6) % 7, 'day');
}

interface Sheet {
  master: MasterRow;
  rows: SessionRow[];
}

export function EdtArabePage(): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [ctx, setCtx] = useState<ContextSemesters | null>(null);
  const [masters, setMasters] = useState<MasterRow[]>([]);
  const [professors, setProfessors] = useState<ProfessorRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  const [semesterId, setSemesterId] = useState<number | undefined>(undefined);
  const [professorId, setProfessorId] = useState<number | undefined>(undefined);
  const [masterId, setMasterId] = useState<number | undefined>(undefined);
  const [weekStart, setWeekStart] = useState<Dayjs>(() => mondayOf(dayjs()));

  // --- Référentiels ---------------------------------------------------------
  useEffect(() => {
    if (!hasApi()) {
      setLoading(false);
      return;
    }
    const notify = (err: unknown): void => void message.error(errorMessage(err));
    void api()
      .contextSemesters()
      .then((r) => {
        if (r.ok) {
          setCtx(r.data);
          // Semestre par défaut : celui de l'année la plus récente, ordinal min.
          const years = [...r.data.academicYears].sort(
            (a, b) => b.id - a.id,
          );
          const yId = years[0]?.id;
          const sems = r.data.semesters
            .filter((s) => s.academic_year_id === yId)
            .sort((a, b) => a.ordinal - b.ordinal);
          setSemesterId(sems[0]?.id);
        } else notify(r);
      })
      .catch(notify);
    void api()
      .masters.list()
      .then((r) => (r.ok ? setMasters(r.data) : notify(r)))
      .catch(notify);
    void api()
      .professors.list()
      .then((r) => (r.ok ? setProfessors(r.data) : notify(r)))
      .catch(notify);
  }, []);

  // --- Séances de la semaine (filtres IPC : master + prof) ------------------
  useEffect(() => {
    if (!hasApi()) return;
    setLoading(true);
    const notify = (err: unknown): void => void message.error(errorMessage(err));
    void api()
      .timetable.week({
        weekStart: weekStart.format('YYYY-MM-DD'),
        masterId,
        professorId,
      })
      .then((r) => {
        if (r.ok) setSessions(r.data);
        else notify(r);
      })
      .catch(notify)
      .finally(() => setLoading(false));
  }, [weekStart, masterId, professorId]);

  // Masters proposés dans le filtre : ceux du semestre choisi.
  const semesterMasters = useMemo(
    () =>
      semesterId == null
        ? masters
        : masters.filter((m) => m.semester_id === semesterId),
    [masters, semesterId],
  );

  // --- Une feuille par master ayant des séances cette semaine ---------------
  const sheets = useMemo<Sheet[]>(() => {
    const allowed = new Set(semesterMasters.map((m) => m.id));
    const byMaster = new Map<number, SessionRow[]>();
    for (const s of sessions) {
      if (!allowed.has(s.master.id)) continue;
      const list = byMaster.get(s.master.id) ?? [];
      list.push(s);
      byMaster.set(s.master.id, list);
    }
    const out: Sheet[] = [];
    for (const [id, rows] of byMaster) {
      const master = semesterMasters.find((m) => m.id === id);
      if (!master) continue;
      rows.sort(
        (a, b) =>
          weekdayOf(a.date) - weekdayOf(b.date) ||
          a.start_min - b.start_min,
      );
      out.push({ master, rows });
    }
    return out.sort((a, b) => a.master.name.localeCompare(b.master.name, 'ar'));
  }, [sessions, semesterMasters]);

  const semesterOf = (m: MasterRow): string => {
    const sem = ctx?.semesters.find((s) => s.id === m.semester_id);
    return sem ? (AR_ORDINALS[sem.ordinal - 1] ?? sem.label) : '—';
  };

  const th: React.CSSProperties = {
    border: '1px solid #94a3b8',
    padding: '6px 8px',
    background: '#e2e8f0',
    fontWeight: 700,
  };
  const td: React.CSSProperties = {
    border: '1px solid #cbd5e1',
    padding: '6px 8px',
    verticalAlign: 'top',
  };

  return (
    <div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Text strong>Semestre</Text>
          <Select
            style={{ minWidth: 170 }}
            allowClear
            placeholder="Tous"
            value={semesterId}
            onChange={(v) => {
              setSemesterId(v);
              setMasterId(undefined);
            }}
            options={(ctx?.semesters ?? []).map((s) => ({
              value: s.id,
              label: `${s.label} · S${s.ordinal}`,
            }))}
          />
          <Text strong>Professeur</Text>
          <Select
            style={{ minWidth: 240 }}
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Tous"
            value={professorId}
            onChange={setProfessorId}
            options={professors.map((p) => ({
              value: p.id,
              label: p.full_name,
            }))}
          />
          <Text strong>Master</Text>
          <Select
            style={{ minWidth: 280 }}
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Tous"
            value={masterId}
            onChange={setMasterId}
            options={semesterMasters.map((m) => ({
              value: m.id,
              label: `${m.code} — ${m.name}`,
            }))}
          />
          <Button
            icon={<LeftOutlined />}
            onClick={() => setWeekStart((w) => w.subtract(7, 'day'))}
          />
          <DatePicker
            picker="week"
            value={weekStart}
            allowClear={false}
            onChange={(d) => d && setWeekStart(mondayOf(d))}
          />
          <Button
            icon={<RightOutlined />}
            onClick={() => setWeekStart((w) => w.add(7, 'day'))}
          />
          <Button
            icon={<PrinterOutlined />}
            onClick={() => window.print()}
          >
            Imprimer
          </Button>
        </Space>
      </Card>

      {loading ? (
        <Spin />
      ) : sheets.length === 0 ? (
        <Empty description="Aucune séance cette semaine pour ces filtres" />
      ) : (
        sheets.map(({ master, rows }) => (
          <Card
            key={master.id}
            size="small"
            style={{ marginBottom: 16 }}
            styles={{ body: { direction: 'rtl' } }}
          >
            <div dir="rtl" style={{ fontFamily: 'inherit' }}>
              <h2
                style={{
                  textAlign: 'center',
                  margin: '4px 0 10px',
                  fontWeight: 800,
                }}
              >
                برنامج توزيع الحصص
              </h2>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '4px 18px',
                  fontSize: 13,
                  marginBottom: 8,
                }}
              >
                <span>
                  <b>ماستر :</b> {master.name}
                </span>
                <span>
                  <b>السداسي :</b> {semesterOf(master)}
                </span>
                <span>
                  <b>السنة الجامعية :</b> {master.academic_year_label}
                </span>
                <span>
                  <b>المنسق :</b> {master.responsible_name ?? '—'}
                </span>
                <span>
                  <b>الأسبوع :</b>{' '}
                  {weekStart.format('DD/MM/YYYY')}
                </span>
              </div>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr>
                    <th style={th}>الوحدة</th>
                    <th style={th}>الأستاذ</th>
                    <th style={th}>اليوم</th>
                    <th style={th}>التوقيت</th>
                    <th style={th}>القاعة</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id}>
                      <td
                        style={{
                          ...td,
                          textDecoration:
                            s.effective_status === 'ANNULEE'
                              ? 'line-through'
                              : 'none',
                        }}
                      >
                        {s.module.name}
                        {s.effective_status === 'ANNULEE' && (
                          <Tag color="red" style={{ marginInlineStart: 6 }}>
                            ملغاة
                          </Tag>
                        )}
                        {s.effective_status === 'REPORTEE' && (
                          <Tag color="gold" style={{ marginInlineStart: 6 }}>
                            مؤجلة
                          </Tag>
                        )}
                      </td>
                      <td style={td}>{s.professor.full_name}</td>
                      <td style={td}>
                        {AR_DAYS[weekdayOf(s.date)]}{' '}
                        <span style={{ color: '#64748b' }}>
                          {s.date.split('-').reverse().join('/').slice(0, 5)}
                        </span>
                      </td>
                      <td style={td}>
                        {minToHHMM(s.start_min)}–{minToHHMM(s.end_min)}
                      </td>
                      <td style={td}>{arRoom(s.room.name)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
