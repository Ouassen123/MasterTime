/**
 * Service Import / Export (P11 — Module I : FR-45→49, BR-21).
 *
 * **Import CSV** (5 types : salles, professeurs, modules, masters,
 * étudiants) :
 * - parsing robuste : BOM, délimiteur `;` ou `,` auto-détecté sur
 *   l'en-tête, quoting `"` standard (sauts de ligne inclus), lignes
 *   vides ignorées, en-tête FR obligatoire et validée (ordre libre,
 *   colonnes inconnues → warning non bloquant), cap 10 000 lignes ;
 * - `previewImport` : aperçu ligne par ligne — OK / DOUBLON (unicité
 *   NOCASE par type, `match_id` de l'existant, doublons intra-fichier
 *   inclus) / ERREUR (champ requis ou type invalide, référence
 *   inexistante) ;
 * - `applyImport` : stratégie de conflit par lot IGNORER / FUSIONNER
 *   (champs fournis non vides) / REMPLACER (champs fournis, vides →
 *   NULL là où permis) — une SEULE transaction (BEGIN IMMEDIATE …
 *   COMMIT/ROLLBACK : un plantage milieu annule tout), une ligne
 *   `audit_log` CREATE/UPDATE par entité modifiée (même format que
 *   `withAudit`) + une ligne récap `IMPORT` par lot ; `is_demo = 0`.
 *
 * **Export CSV** (FR-48) : dump lisible par entité — les 5 types
 * importables réutilisent les en-têtes d'import (ré-import direct
 * possible), master_modules et séances ajoutent les colonnes jointes.
 * Le CSV est produit via `csvText` (`./csv` — même format que reportCsv :
 * BOM UTF-8, `;`, quoting).
 *
 * **Gabarits** (FR-49) : `templateCsv` génère en-têtes + ligne d'exemple
 * depuis les mêmes specs de colonnes (source unique).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiResult,
  EntityExport,
  FieldError,
  ImportApplyResult,
  ImportEntityType,
  ImportPreview,
  ImportRow,
  ImportStrategy,
  ReportColumn,
  ReportRow,
  SessionStatus,
} from '../../../shared/types';
import {
  apiErr,
  apiOk,
  EXPORT_TYPES,
  IMPORT_STRATEGIES,
  IMPORT_TYPES,
} from '../../../shared/types';
import { all, get, run } from './connection';
import { csvRows, csvText } from './csv';
import { todayIso } from './date';

const MAX_IMPORT_ROWS = 10_000;
/** Borne anti-payload aberrant (~16 Mio — 10 000 lignes × ~1 600 car.). */
const MAX_CSV_LENGTH = 16_000_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Table SQL visée par chaque type d'import (audit + écritures). */
const ENTITY_TABLE: Record<ImportEntityType, string> = {
  salles: 'room',
  professeurs: 'professor',
  modules: 'module',
  masters: 'master',
  etudiants: 'student',
};

// ---------------------------------------------------------------------------
// Specs de colonnes — source unique : validation, gabarits et exports.
// ---------------------------------------------------------------------------

interface ImportColumn {
  /** Clé interne (`parsed`, écritures). */
  key: string;
  /** En-tête FR exacte attendue dans le fichier. */
  header: string;
  required: boolean;
  /** Valeur d'exemple du gabarit. */
  example: string;
}

const IMPORT_SPECS: Record<ImportEntityType, ImportColumn[]> = {
  salles: [
    { key: 'name', header: 'nom', required: true, example: 'Amphi 8' },
    { key: 'capacity', header: 'capacite', required: false, example: '120' },
    { key: 'is_active', header: 'actif(0/1)', required: false, example: '1' },
  ],
  professeurs: [
    {
      key: 'full_name',
      header: 'nom_complet',
      required: true,
      example: 'Salma El Fassi',
    },
    {
      key: 'email',
      header: 'email',
      required: false,
      example: 'salma@example.ma',
    },
    { key: 'is_active', header: 'actif(0/1)', required: false, example: '1' },
  ],
  modules: [
    { key: 'code', header: 'code', required: true, example: 'GL101' },
    { key: 'name', header: 'nom', required: true, example: 'Génie logiciel' },
  ],
  masters: [
    { key: 'code', header: 'code', required: true, example: 'MID' },
    {
      key: 'name',
      header: 'nom',
      required: true,
      example: 'Master Informatique Décisionnelle',
    },
    {
      key: 'filiere',
      header: 'filiere',
      required: false,
      example: 'Informatique',
    },
    {
      key: 'department',
      header: 'departement',
      required: false,
      example: 'Département Informatique',
    },
    {
      key: 'responsible_name',
      header: 'responsable',
      required: false,
      example: 'Dr A. Bennani',
    },
    { key: 'semester', header: 'semestre', required: false, example: '3' },
  ],
  etudiants: [
    { key: 'group', header: 'groupe', required: true, example: 'G1' },
    { key: 'master_code', header: 'master_code', required: true, example: 'MID' },
    {
      key: 'full_name',
      header: 'nom_complet',
      required: true,
      example: 'Yassine Amrani',
    },
    {
      key: 'external_id',
      header: 'external_id',
      required: false,
      example: 'ETU-0001',
    },
  ],
};

// ---------------------------------------------------------------------------
// Parsing CSV — BOM, délimiteur auto sur l'en-tête, quoting `"` standard.
// ---------------------------------------------------------------------------

interface ParsedCsv {
  /** En-têtes trimmées de la première ligne non vide. */
  headers: string[];
  /** Lignes de données non vides (cellules brutes, désquotées). */
  records: string[][];
}

/**
 * Détecte `;` ou `,` sur la première ligne logique (hors quoting).
 * `;` gagne à égalité — CSV Excel FR.
 */
function detectDelimiter(text: string): ';' | ',' {
  let inQuotes = false;
  let semis = 0;
  let commas = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') i++; // "" échappé
        else inQuotes = false;
      }
    } else if (c === '\n' || c === '\r') {
      break;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ';') {
      semis++;
    } else if (c === ',') {
      commas++;
    }
  }
  return commas > semis ? ',' : ';';
}

/**
 * Découpe le texte en enregistrements (state machine RFC-4180-light :
 * quoting `"` en début de champ, `""` littéral, sauts de ligne quotés,
 * CR/LF/CRLF acceptés). Les enregistrements entièrement vides sont
 * ignorés (lignes vides, `;;;`).
 */
function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;
  const pushRecord = (): void => {
    fields.push(field);
    const isEmpty = fields.every((f) => f.trim() === '');
    if (!isEmpty) records.push(fields);
    fields = [];
    field = '';
    quotedField = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c; // sauts de ligne quotés conservés
      }
    } else if (c === '"' && field === '' && !quotedField) {
      inQuotes = true;
      quotedField = true;
    } else if (c === delimiter) {
      fields.push(field);
      field = '';
      quotedField = false;
    } else if (c === '\r' || c === '\n') {
      pushRecord();
      if (c === '\r' && text[i + 1] === '\n') i++; // CRLF = un seul saut
    } else {
      field += c;
    }
  }
  // Dernier enregistrement si le fichier ne finit pas par un saut de ligne
  // (ou s'il reste un champ en cours — quoting non fermé = ligne tronquée,
  // acceptée telle quelle : la validation d'en-tête décidera).
  if (field !== '' || fields.length > 0 || inQuotes) pushRecord();
  return records;
}

function parseCsv(csvText: string): ApiResult<ParsedCsv> {
  const text =
    csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;
  const delimiter = detectDelimiter(text);
  const records = splitRecords(text, delimiter);
  if (records.length === 0) {
    return apiErr('Le fichier est vide ou illisible.');
  }
  const headers = records[0].map((h) =>
    h.trim().replace(/^\uFEFF/, ''),
  );
  const data = records.slice(1);
  if (data.length > MAX_IMPORT_ROWS) {
    return apiErr(
      `Fichier trop volumineux : ${data.length} lignes ` +
        `(maximum ${MAX_IMPORT_ROWS}).`,
    );
  }
  return apiOk({ headers, records: data });
}

// ---------------------------------------------------------------------------
// Normalisation par ligne — valeurs typées + erreurs de champ (FR-46).
// ---------------------------------------------------------------------------

/** Valeurs normalisées prêtes à écrire (après validation sans erreur). */
type NormValues =
  | {
      kind: 'salles';
      name: string;
      capacity: number | null;
      isActive: number | null;
    }
  | {
      kind: 'professeurs';
      fullName: string;
      email: string | null;
      isActive: number | null;
    }
  | { kind: 'modules'; code: string; name: string }
  | {
      kind: 'masters';
      code: string;
      name: string;
      filiere: string | null;
      department: string | null;
      responsibleName: string | null;
      semesterId: number | null;
      academicYearId: number;
    }
  | {
      kind: 'etudiants';
      groupId: number;
      fullName: string;
      externalId: string | null;
    };

interface NormRow {
  n: number;
  raw: string[];
  /** Valeur trimmée par clé de colonne reconnue ('' si absente). */
  parsed: Record<string, string>;
  /** Clés dont la colonne est présente dans le fichier. */
  provided: Set<string>;
  errors: FieldError[];
  values: NormValues | null;
}

function parseFlag(
  v: string,
  field: string,
  errors: FieldError[],
): number | null {
  if (v === '') return null;
  if (v === '0' || v === '1') return Number(v);
  errors.push({ field, message: 'La valeur « actif » doit être 0 ou 1.' });
  return null;
}

function parseCapacity(v: string, errors: FieldError[]): number | null {
  if (v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push({
      field: 'capacity',
      message: 'La capacité doit être un entier strictement positif.',
    });
    return null;
  }
  return n;
}

/** Année universitaire « courante » de l'import : is_current, sinon la plus récente. */
function currentAcademicYearId(db: DatabaseSync): number | null {
  return (
    get<{ id: number }>(
      db,
      'SELECT id FROM academic_year ORDER BY is_current DESC, id DESC LIMIT 1',
    )?.id ?? null
  );
}

function normalizeRow(
  db: DatabaseSync,
  type: ImportEntityType,
  n: number,
  cells: string[],
  colIndex: Map<string, number>,
  ctx: { academicYearId: number | null },
): NormRow {
  const spec = IMPORT_SPECS[type];
  const parsed: Record<string, string> = {};
  const provided = new Set<string>();
  for (const col of spec) {
    const idx = colIndex.get(col.header);
    if (idx !== undefined) {
      provided.add(col.key);
      parsed[col.key] = (cells[idx] ?? '').trim();
    } else {
      parsed[col.key] = '';
    }
  }
  const errors: FieldError[] = [];
  const req = (key: string, message: string): string => {
    const v = parsed[key] ?? '';
    if (v === '') errors.push({ field: key, message });
    return v;
  };

  let values: NormValues | null = null;
  switch (type) {
    case 'salles': {
      const name = req('name', 'Le nom de la salle est obligatoire.');
      const capacity = parseCapacity(parsed.capacity ?? '', errors);
      const isActive = parseFlag(parsed.is_active ?? '', 'is_active', errors);
      if (errors.length === 0) {
        values = {
          kind: 'salles',
          name,
          capacity,
          isActive: isActive ?? 1,
        };
      }
      break;
    }
    case 'professeurs': {
      const fullName = req(
        'full_name',
        'Le nom du professeur est obligatoire.',
      );
      const email = parsed.email ?? '';
      if (email !== '' && !EMAIL_RE.test(email)) {
        errors.push({ field: 'email', message: "Format d'email invalide." });
      }
      const isActive = parseFlag(parsed.is_active ?? '', 'is_active', errors);
      if (errors.length === 0) {
        values = {
          kind: 'professeurs',
          fullName,
          email: email || null,
          isActive: isActive ?? 1,
        };
      }
      break;
    }
    case 'modules': {
      const code = req('code', 'Le code du module est obligatoire.');
      const name = req('name', 'Le nom du module est obligatoire.');
      if (errors.length === 0) values = { kind: 'modules', code, name };
      break;
    }
    case 'masters': {
      const code = req('code', 'Le code du master est obligatoire.');
      const name = req('name', 'Le nom du master est obligatoire.');
      let semesterId: number | null = null;
      const semRaw = parsed.semester ?? '';
      if (semRaw !== '') {
        const m = /^s?(\d+)$/i.exec(semRaw);
        const ordinal = m ? Number(m[1]) : NaN;
        const sem =
          ctx.academicYearId != null && Number.isInteger(ordinal)
            ? get<{ id: number }>(
                db,
                `SELECT id FROM semester
                  WHERE academic_year_id = ? AND ordinal = ?`,
                ctx.academicYearId,
                ordinal,
              )
            : undefined;
        if (!Number.isInteger(ordinal)) {
          errors.push({
            field: 'semester',
            message: 'Semestre invalide (ordinal attendu, ex. 3).',
          });
        } else if (!sem) {
          errors.push({
            field: 'semester',
            message: "Semestre inexistant dans l'année universitaire courante.",
          });
        } else {
          semesterId = sem.id;
        }
      }
      if (errors.length === 0) {
        values = {
          kind: 'masters',
          code,
          name,
          filiere: (parsed.filiere ?? '') || null,
          department: (parsed.department ?? '') || null,
          responsibleName: (parsed.responsible_name ?? '') || null,
          semesterId,
          academicYearId: ctx.academicYearId ?? -1,
        };
      }
      break;
    }
    case 'etudiants': {
      const masterCode = req('master_code', 'Le code master est obligatoire.');
      const groupName = req('group', 'Le nom du groupe est obligatoire.');
      const fullName = req(
        'full_name',
        'Le nom de l’étudiant est obligatoire.',
      );
      let groupId: number | null = null;
      if (masterCode !== '') {
        const master = get<{ id: number; status: string }>(
          db,
          'SELECT id, status FROM master WHERE code = ? COLLATE NOCASE',
          masterCode,
        );
        if (!master) {
          errors.push({
            field: 'master_code',
            message: 'Aucun master ne porte ce code.',
          });
        } else if (master.status === 'ARCHIVE') {
          errors.push({
            field: 'master_code',
            message:
              'Ce master est archivé : réactivez-le avant toute modification.',
          });
        } else if (groupName !== '') {
          const group = get<{ id: number }>(
            db,
            `SELECT id FROM student_group
              WHERE master_id = ? AND name = ? COLLATE NOCASE`,
            master.id,
            groupName,
          );
          if (!group) {
            errors.push({
              field: 'group',
              message: 'Aucun groupe de ce nom dans ce master.',
            });
          } else {
            groupId = group.id;
          }
        }
      }
      if (errors.length === 0) {
        values = {
          kind: 'etudiants',
          groupId: groupId ?? -1,
          fullName,
          externalId: (parsed.external_id ?? '') || null,
        };
      }
      break;
    }
  }
  return { n, raw: cells, parsed, provided, errors, values };
}

// ---------------------------------------------------------------------------
// Doublons — unicité NOCASE par type (cohérent avec les services P6a/P9b).
// ---------------------------------------------------------------------------

/** Clé de dédup intra-fichier + recherche DB. null = ligne en erreur. */
function dupKey(v: NormValues): string {
  switch (v.kind) {
    case 'salles':
      return `room:${v.name.toLowerCase()}`;
    case 'professeurs':
      return `prof:${v.fullName.toLowerCase()}`;
    case 'modules':
      return `module:${v.code.toLowerCase()}`;
    case 'masters':
      return `master:${v.code.toLowerCase()}`;
    case 'etudiants':
      return v.externalId != null
        ? `student:${v.groupId}:ext:${v.externalId.toLowerCase()}`
        : `student:${v.groupId}:name:${v.fullName.toLowerCase()}`;
  }
}

/** Id de l'existant (doublon NOCASE) ou undefined. */
function findMatch(db: DatabaseSync, v: NormValues): number | undefined {
  switch (v.kind) {
    case 'salles':
      return get<{ id: number }>(
        db,
        'SELECT id FROM room WHERE name = ? COLLATE NOCASE',
        v.name,
      )?.id;
    case 'professeurs':
      return get<{ id: number }>(
        db,
        'SELECT id FROM professor WHERE full_name = ? COLLATE NOCASE',
        v.fullName,
      )?.id;
    case 'modules':
      return get<{ id: number }>(
        db,
        'SELECT id FROM module WHERE code = ? COLLATE NOCASE',
        v.code,
      )?.id;
    case 'masters':
      return get<{ id: number }>(
        db,
        'SELECT id FROM master WHERE code = ? COLLATE NOCASE',
        v.code,
      )?.id;
    case 'etudiants':
      return v.externalId != null
        ? get<{ id: number }>(
            db,
            `SELECT id FROM student
              WHERE student_group_id = ? AND external_id = ? COLLATE NOCASE`,
            v.groupId,
            v.externalId,
          )?.id
        : get<{ id: number }>(
            db,
            `SELECT id FROM student
              WHERE student_group_id = ? AND full_name = ? COLLATE NOCASE`,
            v.groupId,
            v.fullName,
          )?.id;
  }
}

/**
 * Contraintes d'unicité métier hors clé de doublon (le schéma ne les
 * impose pas toutes : `module.name` n'est UNIQUE qu'au niveau service ;
 * l'index `ux_student_group_ext` couvre external_id par groupe).
 * Appelée avant INSERT et avant UPDATE de fusion — l'id de l'entité
 * fusionnée est exclu.
 */
function uniquenessViolation(
  db: DatabaseSync,
  v: NormValues,
  excludeId: number | null,
): string | null {
  switch (v.kind) {
    case 'modules': {
      const dup = get<{ id: number }>(
        db,
        'SELECT id FROM module WHERE name = ? COLLATE NOCASE AND id != ?',
        v.name,
        excludeId ?? -1,
      );
      return dup ? 'Un module porte déjà ce nom.' : null;
    }
    case 'etudiants': {
      if (v.externalId == null) return null;
      const dup = get<{ id: number }>(
        db,
        `SELECT id FROM student
          WHERE student_group_id = ? AND external_id = ? COLLATE NOCASE
            AND id != ?`,
        v.groupId,
        v.externalId,
        excludeId ?? -1,
      );
      return dup
        ? 'Un étudiant porte déjà cet identifiant dans ce groupe.'
        : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Aperçu — construit les lignes normalisées + statuts (partagé preview/apply).
// ---------------------------------------------------------------------------

interface PreparedImport {
  columns: string[];
  unknownColumns: string[];
  rows: NormRow[];
  /** Statut dérivé par ligne — recalculé à l'apply (état courant). */
  matchIds: (number | undefined)[];
}

function isImportType(v: unknown): v is ImportEntityType {
  return (
    typeof v === 'string' &&
    (IMPORT_TYPES as readonly string[]).includes(v)
  );
}

function prepare(
  db: DatabaseSync,
  type: ImportEntityType,
  csvText: string,
): ApiResult<PreparedImport> {
  const parsed = parseCsv(csvText);
  if (!parsed.ok) return parsed;

  const spec = IMPORT_SPECS[type];
  const headers = parsed.data.headers;
  // Colonnes reconnues : correspondance exacte des en-têtes FR.
  const colIndex = new Map<string, number>();
  const specHeaders = new Map(spec.map((c) => [c.header, c]));
  headers.forEach((h, i) => {
    if (specHeaders.has(h) && !colIndex.has(h)) colIndex.set(h, i);
  });
  const unknownColumns = headers.filter(
    (h) => h !== '' && !specHeaders.has(h),
  );
  const missing = spec.filter((c) => c.required && !colIndex.has(c.header));
  if (missing.length > 0) {
    return apiErr(
      `En-tête invalide : colonne(s) obligatoire(s) absente(s) — ` +
        missing.map((c) => `« ${c.header} »`).join(', ') +
        '.',
    );
  }
  if (colIndex.size === 0) {
    return apiErr('En-tête invalide : aucune colonne reconnue.');
  }

  const ctx = {
    academicYearId:
      type === 'masters' ? currentAcademicYearId(db) : null,
  };
  if (type === 'masters' && ctx.academicYearId == null) {
    return apiErr(
      "Aucune année universitaire en base : l'import de masters " +
        "nécessite une année courante.",
    );
  }

  const rows: NormRow[] = [];
  const matchIds: (number | undefined)[] = [];
  const seenInFile = new Set<string>();
  parsed.data.records.forEach((cells, i) => {
    const row = normalizeRow(db, type, i + 1, cells, colIndex, ctx);
    rows.push(row);
    if (row.values == null) {
      matchIds.push(undefined);
      return;
    }
    const dbMatch = findMatch(db, row.values);
    const key = dupKey(row.values);
    const fileMatch = seenInFile.has(key);
    seenInFile.add(key);
    // DOUBLON : existant en base OU déjà vu dans le fichier (la
    // stratégie s'appliquera à l'entité insérée par la 1re occurrence).
    matchIds.push(dbMatch ?? (fileMatch ? -1 : undefined));
  });
  const columns = headers.filter((h) => colIndex.has(h));
  return apiOk({ columns, unknownColumns, rows, matchIds });
}

export function previewImport(
  db: DatabaseSync,
  type: unknown,
  csvText: unknown,
): ApiResult<ImportPreview> {
  if (!isImportType(type)) return apiErr("Type d'import inconnu.");
  if (typeof csvText !== 'string') {
    return apiErr('Contenu CSV invalide.');
  }
  if (csvText.length > MAX_CSV_LENGTH) {
    return apiErr('Fichier trop volumineux.');
  }
  const prepared = prepare(db, type, csvText);
  if (!prepared.ok) return prepared;
  const spec = IMPORT_SPECS[type];
  const shown = new Set(prepared.data.columns);
  const rows: ImportRow[] = prepared.data.rows.map((r, i) => {
    const matchId = prepared.data.matchIds[i];
    // `parsed` exposé par EN-TÊTE FR (affichage direct des colonnes du
    // fichier) — la normalisation interne reste par clé de colonne.
    const parsed: Record<string, string> = {};
    for (const col of spec) {
      if (shown.has(col.header)) parsed[col.header] = r.parsed[col.key] ?? '';
    }
    return {
      n: r.n,
      raw: r.raw,
      parsed,
      status:
        r.errors.length > 0 ? 'ERREUR' : matchId != null ? 'DOUBLON' : 'OK',
      errors: r.errors,
      ...(matchId != null && matchId > 0 ? { match_id: matchId } : {}),
    };
  });
  return apiOk({
    columns: prepared.data.columns,
    unknownColumns: prepared.data.unknownColumns,
    rows,
  });
}

// ---------------------------------------------------------------------------
// Écritures — audit manuel identique à withAudit, dans la transaction du lot.
// ---------------------------------------------------------------------------

function readEntityRow(
  db: DatabaseSync,
  entity: string,
  id: number,
): Record<string, unknown> | undefined {
  return get<Record<string, unknown>>(
    db,
    `SELECT * FROM "${entity}" WHERE id = ?`,
    id,
  );
}

/**
 * Écriture auditée dans la transaction du lot : relit la ligne
 * avant/après et insère `audit_log` (CREATE/UPDATE) si elle a changé —
 * même format que `withAudit` (qui pilote sa propre transaction et ne
 * peut donc pas être utilisé ici).
 */
function auditedWrite(
  db: DatabaseSync,
  userId: number | null,
  action: 'CREATE' | 'UPDATE',
  entity: string,
  entityId: number | null,
  fn: () => number | void,
): number {
  let id = entityId;
  const before = id != null ? readEntityRow(db, entity, id) : undefined;
  const produced = fn();
  if (id == null && typeof produced === 'number') id = produced;
  if (id == null) {
    throw new Error(`Import : fn() sans identifiant (${entity}).`);
  }
  const after = readEntityRow(db, entity, id);
  const oldJson = before === undefined ? null : JSON.stringify(before);
  const newJson = after === undefined ? null : JSON.stringify(after);
  if (oldJson !== newJson) {
    run(
      db,
      `INSERT INTO audit_log (user_id, action, entity, entity_id, old_values, new_values)
       VALUES (?, ?, ?, ?, ?, ?)`,
      userId,
      action,
      entity,
      id,
      oldJson,
      newJson,
    );
  }
  return id;
}

const KEEP = Symbol('keep');

/**
 * Résout la valeur d'un champ optionnel selon la stratégie :
 * FUSIONNER → seulement si fourni et non vide ; REMPLACER → toute
 * colonne fournie (vide → `emptyTo`). Colonne absente → KEEP.
 */
function pick<T extends string | number | null>(
  strategy: ImportStrategy,
  provided: boolean,
  cellValue: string,
  value: T,
  emptyTo: T,
): T | typeof KEEP {
  if (!provided) return KEEP;
  if (strategy === 'REMPLACER') return cellValue === '' ? emptyTo : value;
  return cellValue === '' ? KEEP : value;
}

/** INSERT d'une ligne validée. Retourne l'id inséré. */
function insertRow(
  db: DatabaseSync,
  userId: number | null,
  v: NormValues,
): number {
  switch (v.kind) {
    case 'salles':
      return auditedWrite(db, userId, 'CREATE', 'room', null, () =>
        Number(
          run(
            db,
            'INSERT INTO room (name, capacity, is_active) VALUES (?, ?, ?)',
            v.name,
            v.capacity,
            v.isActive ?? 1,
          ).lastInsertRowid,
        ),
      );
    case 'professeurs':
      return auditedWrite(db, userId, 'CREATE', 'professor', null, () =>
        Number(
          run(
            db,
            `INSERT INTO professor (full_name, email, is_active, is_demo)
             VALUES (?, ?, ?, 0)`,
            v.fullName,
            v.email,
            v.isActive ?? 1,
          ).lastInsertRowid,
        ),
      );
    case 'modules':
      return auditedWrite(db, userId, 'CREATE', 'module', null, () =>
        Number(
          run(
            db,
            'INSERT INTO module (code, name, is_demo) VALUES (?, ?, 0)',
            v.code,
            v.name,
          ).lastInsertRowid,
        ),
      );
    case 'masters':
      return auditedWrite(db, userId, 'CREATE', 'master', null, () =>
        Number(
          run(
            db,
            `INSERT INTO master (code, name, filiere, department,
               responsible_name, academic_year_id, semester_id, status, is_demo)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIF', 0)`,
            v.code,
            v.name,
            v.filiere,
            v.department,
            v.responsibleName,
            v.academicYearId,
            v.semesterId,
          ).lastInsertRowid,
        ),
      );
    case 'etudiants':
      return auditedWrite(db, userId, 'CREATE', 'student', null, () => {
        const id = Number(
          run(
            db,
            `INSERT INTO student (student_group_id, external_id, full_name, is_demo)
             VALUES (?, ?, ?, 0)`,
            v.groupId,
            v.externalId,
            v.fullName,
          ).lastInsertRowid,
        );
        if (v.externalId == null) {
          // Règle P9b : l'index ux_student_group_ext coalesce NULL→'' —
          // identifiant synthétique MAN-<id> pour garantir l'unicité.
          run(
            db,
            'UPDATE student SET external_id = ? WHERE id = ?',
            `MAN-${id}`,
            id,
          );
        }
        return id;
      });
  }
}

/**
 * UPDATE d'un doublon selon la stratégie. Les colonnes absentes du
 * fichier sont conservées (KEEP) ; FUSIONNER ne touche que les champs
 * fournis non vides ; REMPLACER applique tous les champs fournis
 * (vides → NULL là où permis, défaut pour les colonnes NOT NULL).
 */
function updateRow(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  v: NormValues,
  provided: Set<string>,
  parsed: Record<string, string>,
  strategy: ImportStrategy,
): void {
  const merge = <T extends string | number | null>(
    key: string,
    value: T,
    emptyTo: T,
  ): T | typeof KEEP =>
    pick(strategy, provided.has(key), parsed[key] ?? '', value, emptyTo);

  switch (v.kind) {
    case 'salles': {
      const capacity = merge('capacity', v.capacity, null);
      const isActive = merge('is_active', v.isActive ?? 1, 1);
      auditedWrite(db, userId, 'UPDATE', 'room', id, () => {
        run(
          db,
          `UPDATE room SET name = ?,
             capacity = CASE WHEN ? THEN capacity ELSE ? END,
             is_active = CASE WHEN ? THEN is_active ELSE ? END
           WHERE id = ?`,
          v.name,
          capacity === KEEP ? 1 : 0,
          capacity === KEEP ? null : capacity,
          isActive === KEEP ? 1 : 0,
          isActive === KEEP ? null : isActive,
          id,
        );
      });
      return;
    }
    case 'professeurs': {
      const email = merge('email', v.email, null);
      const isActive = merge('is_active', v.isActive ?? 1, 1);
      auditedWrite(db, userId, 'UPDATE', 'professor', id, () => {
        run(
          db,
          `UPDATE professor SET full_name = ?,
             email = CASE WHEN ? THEN email ELSE ? END,
             is_active = CASE WHEN ? THEN is_active ELSE ? END
           WHERE id = ?`,
          v.fullName,
          email === KEEP ? 1 : 0,
          email === KEEP ? null : email,
          isActive === KEEP ? 1 : 0,
          isActive === KEEP ? null : isActive,
          id,
        );
      });
      return;
    }
    case 'modules': {
      // code + nom obligatoires : toujours fournis.
      auditedWrite(db, userId, 'UPDATE', 'module', id, () => {
        run(
          db,
          'UPDATE module SET code = ?, name = ? WHERE id = ?',
          v.code,
          v.name,
          id,
        );
      });
      return;
    }
    case 'masters': {
      const filiere = merge('filiere', v.filiere, null);
      const department = merge('department', v.department, null);
      const responsible = merge(
        'responsible_name',
        v.responsibleName,
        null,
      );
      const semester = merge('semester', v.semesterId, null);
      auditedWrite(db, userId, 'UPDATE', 'master', id, () => {
        run(
          db,
          `UPDATE master SET code = ?, name = ?,
             filiere = CASE WHEN ? THEN filiere ELSE ? END,
             department = CASE WHEN ? THEN department ELSE ? END,
             responsible_name = CASE WHEN ? THEN responsible_name ELSE ? END,
             semester_id = CASE WHEN ? THEN semester_id ELSE ? END
           WHERE id = ?`,
          v.code,
          v.name,
          filiere === KEEP ? 1 : 0,
          filiere === KEEP ? null : filiere,
          department === KEEP ? 1 : 0,
          department === KEEP ? null : department,
          responsible === KEEP ? 1 : 0,
          responsible === KEEP ? null : responsible,
          semester === KEEP ? 1 : 0,
          semester === KEEP ? null : semester,
          id,
        );
      });
      return;
    }
    case 'etudiants': {
      const externalId = merge('external_id', v.externalId, null);
      auditedWrite(db, userId, 'UPDATE', 'student', id, () => {
        run(
          db,
          `UPDATE student SET full_name = ?,
             external_id = CASE WHEN ? THEN external_id ELSE ? END
           WHERE id = ?`,
          v.fullName,
          externalId === KEEP ? 1 : 0,
          externalId === KEEP ? null : externalId,
          id,
        );
      });
      return;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /unique/i.test(err.message);
}

// ---------------------------------------------------------------------------
// Application du lot — une seule transaction, audit par entité + récap.
// ---------------------------------------------------------------------------

export function applyImport(
  db: DatabaseSync,
  userId: number | null,
  type: unknown,
  csvText: unknown,
  strategy: unknown,
): ApiResult<ImportApplyResult> {
  // Payload forgé : validations AVANT tout travail.
  if (!isImportType(type)) return apiErr("Type d'import inconnu.");
  if (
    typeof strategy !== 'string' ||
    !(IMPORT_STRATEGIES as readonly string[]).includes(strategy)
  ) {
    return apiErr('Stratégie de conflit inconnue.');
  }
  if (typeof csvText !== 'string') {
    return apiErr('Contenu CSV invalide.');
  }
  if (csvText.length > MAX_CSV_LENGTH) {
    return apiErr('Fichier trop volumineux.');
  }
  const strat = strategy as ImportStrategy;
  const prepared = prepare(db, type, csvText);
  if (!prepared.ok) return prepared;

  const result: ImportApplyResult = {
    inserted: 0,
    merged: 0,
    ignored: 0,
    errors: [],
  };
  const entity = ENTITY_TABLE[type];

  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const row of prepared.data.rows) {
      if (row.errors.length > 0 || row.values == null) {
        result.errors.push({
          n: row.n,
          message: row.errors.map((e) => e.message).join(' '),
        });
        continue;
      }
      // Doublon recalculé à l'état courant — couvre les doublons
      // intra-fichier (la 1re occurrence vient d'être insérée) et les
      // changements survenus entre preview et apply.
      const matchId = findMatch(db, row.values);
      try {
        if (matchId == null) {
          const violation = uniquenessViolation(db, row.values, null);
          if (violation) {
            result.errors.push({ n: row.n, message: violation });
            continue;
          }
          insertRow(db, userId, row.values);
          result.inserted++;
        } else if (strat === 'IGNORER') {
          result.ignored++;
        } else {
          const violation = uniquenessViolation(db, row.values, matchId);
          if (violation) {
            result.errors.push({ n: row.n, message: violation });
            continue;
          }
          updateRow(
            db,
            userId,
            matchId,
            row.values,
            row.provided,
            row.parsed,
            strat,
          );
          result.merged++;
        }
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Erreur isolée : la ligne n'est pas importée, le lot continue
          // (contrainte de schéma — ex. ux_student_group_ext).
          result.errors.push({
            n: row.n,
            message:
              'Violation d’unicité : une donnée identique existe déjà.',
          });
        } else {
          throw err; // erreur inattendue → rollback complet (BR-21)
        }
      }
    }
    // Récap BR-20 : une ligne audit_log IMPORT par lot.
    run(
      db,
      `INSERT INTO audit_log (user_id, action, entity, entity_id, old_values, new_values)
       VALUES (?, 'IMPORT', ?, NULL, NULL, ?)`,
      userId,
      entity,
      JSON.stringify({
        type,
        strategy: strat,
        inserted: result.inserted,
        merged: result.merged,
        ignored: result.ignored,
        errors: result.errors.length,
      }),
    );
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // connexion possiblement hors transaction — l'erreur d'origine prime
    }
    console.error('[import] Échec du lot — rollback complet :', err);
    return apiErr(
      "Échec de l'import : aucune donnée n'a été écrite (annulation complète).",
    );
  }
  return apiOk(result);
}

// ---------------------------------------------------------------------------
// Gabarits (FR-49) — en-têtes + 1 ligne d'exemple, depuis IMPORT_SPECS.
// ---------------------------------------------------------------------------

export function templateCsv(type: ImportEntityType): string {
  const spec = IMPORT_SPECS[type];
  return csvRows([
    spec.map((c) => c.header),
    spec.map((c) => c.example),
  ]);
}

// ---------------------------------------------------------------------------
// Export par entité (FR-48) — dump lisible ; en-têtes d'import pour les
// 5 types importables (ré-import direct), colonnes jointes sinon.
// ---------------------------------------------------------------------------

const STATUS_FR_EXPORT: Record<SessionStatus, string> = {
  PREVUE: 'Prévue',
  REALISEE: 'Réalisée',
  ANNULEE: 'Annulée',
  REPORTEE: 'Reportée',
};

/** 'HH:MM' depuis des minutes depuis minuit (dump lisible, cappé 24:00). */
function minToHHMM(min: number | null): string | null {
  if (min == null) return null;
  const capped = Math.max(0, Math.min(min, 1440));
  const h = Math.floor(capped / 60);
  const m = capped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

interface ExportDef {
  title: string;
  columns: ReportColumn[];
  rows(db: DatabaseSync, today: string): ReportRow[];
}

const EXPORT_DEFS: Record<
  (typeof EXPORT_TYPES)[number],
  ExportDef
> = {
  // En-têtes identiques à l'import : le dump est ré-importable tel quel.
  salles: {
    title: 'Export — Salles',
    columns: [
      { key: 'nom', label: 'nom' },
      { key: 'capacite', label: 'capacite' },
      { key: 'actif', label: 'actif(0/1)' },
    ],
    rows: (db) =>
      all<ReportRow>(
        db,
        `SELECT name AS nom, capacity AS capacite, is_active AS actif
           FROM room ORDER BY name COLLATE NOCASE`,
      ),
  },
  professeurs: {
    title: 'Export — Professeurs',
    columns: [
      { key: 'nom_complet', label: 'nom_complet' },
      { key: 'email', label: 'email' },
      { key: 'actif', label: 'actif(0/1)' },
    ],
    rows: (db) =>
      all<ReportRow>(
        db,
        `SELECT full_name AS nom_complet, email, is_active AS actif
           FROM professor ORDER BY full_name COLLATE NOCASE`,
      ),
  },
  modules: {
    title: 'Export — Modules',
    columns: [
      { key: 'code', label: 'code' },
      { key: 'nom', label: 'nom' },
    ],
    rows: (db) =>
      all<ReportRow>(
        db,
        'SELECT code, name AS nom FROM module ORDER BY code COLLATE NOCASE',
      ),
  },
  masters: {
    title: 'Export — Masters',
    columns: [
      { key: 'code', label: 'code' },
      { key: 'nom', label: 'nom' },
      { key: 'filiere', label: 'filiere' },
      { key: 'departement', label: 'departement' },
      { key: 'responsable', label: 'responsable' },
      { key: 'semestre', label: 'semestre' },
      { key: 'annee', label: 'annee' },
      { key: 'statut', label: 'statut' },
    ],
    rows: (db) =>
      all<ReportRow>(
        db,
        `SELECT m.code, m.name AS nom, m.filiere, m.department AS departement,
                m.responsible_name AS responsable, sem.ordinal AS semestre,
                y.label AS annee, m.status AS statut
           FROM master m
           JOIN academic_year y ON y.id = m.academic_year_id
           LEFT JOIN semester sem ON sem.id = m.semester_id
          ORDER BY m.code COLLATE NOCASE`,
      ),
  },
  etudiants: {
    title: 'Export — Étudiants',
    columns: [
      { key: 'groupe', label: 'groupe' },
      { key: 'master_code', label: 'master_code' },
      { key: 'nom_complet', label: 'nom_complet' },
      { key: 'external_id', label: 'external_id' },
    ],
    rows: (db) =>
      all<ReportRow>(
        db,
        `SELECT g.name AS groupe, m.code AS master_code,
                st.full_name AS nom_complet, st.external_id
           FROM student st
           JOIN student_group g ON g.id = st.student_group_id
           JOIN master m ON m.id = g.master_id
          ORDER BY m.code COLLATE NOCASE, g.name COLLATE NOCASE,
                   st.full_name COLLATE NOCASE`,
      ),
  },
  master_modules: {
    title: 'Export — Master-modules',
    columns: [
      { key: 'master_code', label: 'master_code' },
      { key: 'master', label: 'master' },
      { key: 'module_code', label: 'module_code' },
      { key: 'module', label: 'module' },
      { key: 'semestre', label: 'semestre' },
      { key: 'professeur', label: 'professeur' },
      { key: 'groupe', label: 'groupe' },
      { key: 'volume_min', label: 'volume_min' },
      { key: 'duree_seance_min', label: 'duree_seance_min' },
      { key: 'seances_prevues', label: 'seances_prevues' },
      { key: 'debut', label: 'debut' },
      { key: 'fin', label: 'fin' },
      { key: 'fixe', label: 'fixe(0/1)' },
    ],
    rows: (db) =>
      all<ReportRow>(
        db,
        `SELECT m.code AS master_code, m.name AS master,
                mo.code AS module_code, mo.name AS module,
                sem.label AS semestre, p.full_name AS professeur,
                g.name AS groupe, mm.volume_min,
                mm.session_duration_min AS duree_seance_min,
                mm.planned_sessions AS seances_prevues,
                mm.sched_start AS debut, mm.sched_end AS fin,
                mm.is_fixed AS fixe
           FROM master_module mm
           JOIN master m ON m.id = mm.master_id
           JOIN module mo ON mo.id = mm.module_id
           JOIN semester sem ON sem.id = mm.semester_id
           JOIN professor p ON p.id = mm.professor_id
           LEFT JOIN student_group g ON g.id = mm.student_group_id
          ORDER BY m.code COLLATE NOCASE, mo.code COLLATE NOCASE`,
      ),
  },
  seances: {
    title: 'Export — Séances',
    columns: [
      { key: 'date', label: 'date' },
      { key: 'debut', label: 'debut' },
      { key: 'fin', label: 'fin' },
      { key: 'statut', label: 'statut' },
      { key: 'master_code', label: 'master_code' },
      { key: 'master', label: 'master' },
      { key: 'module_code', label: 'module_code' },
      { key: 'module', label: 'module' },
      { key: 'groupe', label: 'groupe' },
      { key: 'professeur', label: 'professeur' },
      { key: 'salle', label: 'salle' },
      { key: 'date_reelle', label: 'date_reelle' },
      { key: 'debut_reel', label: 'debut_reel' },
      { key: 'fin_reel', label: 'fin_reel' },
      { key: 'commentaire', label: 'commentaire' },
    ],
    rows: (db, today) => {
      interface Row {
        date: string;
        start_min: number;
        end_min: number;
        status: SessionStatus;
        master_code: string;
        master: string;
        module_code: string;
        module: string;
        groupe: string | null;
        professeur: string;
        salle: string;
        actual_date: string | null;
        actual_start_min: number | null;
        actual_end_min: number | null;
        commentaire: string | null;
      }
      return all<Row>(
        db,
        `SELECT s.date, s.start_min, s.end_min, s.status,
                m.code AS master_code, m.name AS master,
                mo.code AS module_code, mo.name AS module,
                g.name AS groupe, p.full_name AS professeur,
                r.name AS salle, s.actual_date, s.actual_start_min,
                s.actual_end_min, s.comment AS commentaire
           FROM session s
           JOIN master_module mm ON mm.id = s.master_module_id
           JOIN master m ON m.id = mm.master_id
           JOIN module mo ON mo.id = mm.module_id
           JOIN professor p ON p.id = s.professor_id
           JOIN room r ON r.id = s.room_id
           LEFT JOIN student_group g ON g.id = mm.student_group_id
          ORDER BY s.date, s.start_min, s.id`,
      ).map((r) => ({
        date: r.date,
        debut: minToHHMM(r.start_min),
        fin: minToHHMM(r.end_min),
        // Statut effectif (AD-7) : PREVUE passée → « Non réalisée ».
        statut:
          r.status === 'PREVUE' && r.date < today
            ? 'Non réalisée'
            : STATUS_FR_EXPORT[r.status],
        master_code: r.master_code,
        master: r.master,
        module_code: r.module_code,
        module: r.module,
        groupe: r.groupe,
        professeur: r.professeur,
        salle: r.salle,
        date_reelle: r.actual_date,
        debut_reel: minToHHMM(r.actual_start_min),
        fin_reel: minToHHMM(r.actual_end_min),
        commentaire: r.commentaire,
      }));
    },
  },
};

function isExportType(v: unknown): v is (typeof EXPORT_TYPES)[number] {
  return (
    typeof v === 'string' && (EXPORT_TYPES as readonly string[]).includes(v)
  );
}

export function exportEntity(
  db: DatabaseSync,
  type: unknown,
  today: string = todayIso(),
): ApiResult<EntityExport> {
  if (!isExportType(type)) return apiErr("Type d'export inconnu.");
  const def = EXPORT_DEFS[type];
  return apiOk({
    title: def.title,
    columns: def.columns,
    rows: def.rows(db, today),
  });
}

/** CSV d'un export (BOM UTF-8 + `;` — même format que reportCsv). */
export function entityCsv(data: EntityExport): string {
  return csvText(data.columns, data.rows);
}
