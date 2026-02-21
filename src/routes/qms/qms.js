/**
 * QMS (Quality Management System) routes.
 *
 * Document register, transitions, external standards, and dashboard.
 * Read endpoints require 'Access Developer Tools'.
 * Write endpoints require 'Manage Documents'.
 *
 * @module routes/qms/qms
 */

import { Model } from '../../models/_model/_model';
import { getRootUrl } from '../../helpers/url/url';
import { apiLimiter } from '../../helpers/limiter/limiter';

// SA-2026-001 M-2: Input validation for route parameters
const DOC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export default [
  // =========================================================================
  // READ ENDPOINTS (permission: 'Access Developer Tools')
  // =========================================================================

  // Dashboard: overview counts, overdue reviews, recent activity
  {
    op: 'get',
    view: '/@qms/dashboard',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getQmsDashboard',
    handler: async (req, trx) => {
      const knex = Model.knex();

      const [byStatus, byDomain, overdue, recentActivity, externalCount, reconciliation] =
        await Promise.all([
          knex
            .raw(
              `SELECT status, COUNT(*)::int AS count
               FROM qms.controlled_documents
               GROUP BY status ORDER BY status`,
            )
            .transacting(trx),
          knex
            .raw('SELECT domain_code, domain, status, doc_count FROM qms.documents_by_domain')
            .transacting(trx),
          knex
            .raw(
              `SELECT document_id, title, version, status, next_review_date,
                      owner, days_overdue
               FROM qms.overdue_reviews LIMIT 20`,
            )
            .transacting(trx),
          knex
            .raw(
              `SELECT dt.id, dt.document_id, dt.action, dt.to_status,
                      dt.to_version, dt.performed_by, dt.comment,
                      dt.performed_at, cd.title
               FROM qms.document_transitions dt
               JOIN qms.controlled_documents cd ON cd.document_id = dt.document_id
               ORDER BY dt.performed_at DESC
               LIMIT 20`,
            )
            .transacting(trx),
          knex
            .raw(
              'SELECT COUNT(*)::int AS count FROM qms.external_documents',
            )
            .transacting(trx),
          knex
            .raw(
              `SELECT unregistered_count, high_confidence_count,
                      excluded_count, registered_count
               FROM qms.reconciliation_summary`,
            )
            .transacting(trx),
        ]);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/dashboard`,
          by_status: byStatus.rows,
          by_domain: byDomain.rows,
          overdue_reviews: overdue.rows,
          recent_activity: recentActivity.rows,
          external_documents_count: externalCount.rows[0].count,
          reconciliation: reconciliation.rows[0],
        },
      };
    },
  },

  // Document register with filters
  {
    op: 'get',
    view: '/@qms/register',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getQmsRegister',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const {
        domain,
        type,
        status,
        classification,
        search,
        page = 1,
        page_size = 50,
      } = req.query;

      const offset =
        (Math.max(1, parseInt(page, 10)) - 1) *
        Math.min(100, Math.max(1, parseInt(page_size, 10)));
      const limit = Math.min(100, Math.max(1, parseInt(page_size, 10)));

      const conditions = [];
      const params = [];

      if (domain) {
        conditions.push('cd.domain_code = ?');
        params.push(domain);
      }
      if (type) {
        conditions.push('cd.document_type = ?');
        params.push(type);
      }
      if (status) {
        conditions.push('cd.status = ?');
        params.push(status);
      }
      if (classification) {
        conditions.push('cd.classification = ?');
        params.push(classification);
      }
      if (search) {
        conditions.push("cd.body_tsv @@ plainto_tsquery('english', ?)");
        params.push(search);
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await knex
        .raw(
          `SELECT COUNT(*) FROM qms.controlled_documents cd ${where}`,
          params,
        )
        .transacting(trx);

      // Facets for sidebar
      const [domains, types, statuses] = await Promise.all([
        knex
          .raw(
            `SELECT dc.code, dc.label, COUNT(cd.id)::int AS doc_count
             FROM qms.ref_domain_codes dc
             LEFT JOIN qms.controlled_documents cd ON cd.domain_code = dc.code
             GROUP BY dc.code, dc.label, dc.sort_order
             ORDER BY dc.sort_order`,
          )
          .transacting(trx),
        knex
          .raw(
            `SELECT dt.code, dt.label, COUNT(cd.id)::int AS doc_count
             FROM qms.ref_document_types dt
             LEFT JOIN qms.controlled_documents cd ON cd.document_type = dt.code
             GROUP BY dt.code, dt.label, dt.sort_order
             ORDER BY dt.sort_order`,
          )
          .transacting(trx),
        knex
          .raw(
            `SELECT ds.code, ds.label, COUNT(cd.id)::int AS doc_count
             FROM qms.ref_document_statuses ds
             LEFT JOIN qms.controlled_documents cd ON cd.status = ds.code
             GROUP BY ds.code, ds.label, ds.sort_order
             ORDER BY ds.sort_order`,
          )
          .transacting(trx),
      ]);

      const result = await knex
        .raw(
          `SELECT cd.id, cd.document_id, cd.title, cd.document_type,
                  cd.domain_code, cd.version, cd.status, cd.classification,
                  cd.effective_date, cd.next_review_date,
                  cd.owner, cd.author, cd.reviewer, cd.approver,
                  cd.location, cd.notes,
                  cd.created_at, cd.updated_at
           FROM qms.controlled_documents cd
           ${where}
           ORDER BY cd.document_id
           LIMIT ? OFFSET ?`,
          [...params, limit, offset],
        )
        .transacting(trx);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/register`,
          domains: domains.rows,
          types: types.rows,
          statuses: statuses.rows,
          items: result.rows,
          items_total: parseInt(countResult.rows[0].count, 10),
          page: parseInt(page, 10),
          page_size: limit,
        },
      };
    },
  },

  // Unregistered documents (reconciliation)
  {
    op: 'get',
    view: '/@qms/register/unregistered',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getQmsUnregistered',
    handler: async (req, trx) => {
      const knex = Model.knex();

      const [items, summary] = await Promise.all([
        knex
          .raw(
            `SELECT docs_id, file_path, kb_title, kb_slug, source_dir,
                    kb_created_at, document_id, prefix, suggested_type,
                    suggested_domain, suggested_status, suggested_version,
                    suggested_classification, confidence
             FROM qms.unregistered_documents ORDER BY document_id`,
          )
          .transacting(trx),
        knex
          .raw(
            `SELECT unregistered_count, high_confidence_count,
                    excluded_count, registered_count
             FROM qms.reconciliation_summary`,
          )
          .transacting(trx),
      ]);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/register/unregistered`,
          items: items.rows,
          ...summary.rows[0],
        },
      };
    },
  },

  // Single document detail with transition history
  {
    op: 'get',
    view: '/@qms/register/:document_id',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getQmsDocument',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { document_id } = req.params;

      if (!DOC_ID_RE.test(document_id)) {
        return { status: 400, json: { error: 'Invalid document ID format' } };
      }

      const docResult = await knex
        .raw(
          `SELECT cd.id, cd.document_id, cd.title, cd.document_type,
                  cd.domain_code, cd.version, cd.status, cd.classification,
                  cd.effective_date, cd.next_review_date, cd.owner, cd.author,
                  cd.reviewer, cd.approver, cd.implements, cd.retention_years,
                  cd.retention_basis, cd.location, cd.docs_id, cd.body_md,
                  cd.notes, cd.created_at, cd.updated_at,
                  d.body_md AS kb_body_md,
                  d.slug AS kb_slug
           FROM qms.controlled_documents cd
           LEFT JOIN i18n.docs d ON d.id = cd.docs_id
           WHERE cd.document_id = ?`,
          [document_id],
        )
        .transacting(trx);

      if (docResult.rows.length === 0) {
        return { status: 404, json: { error: 'Document not found' } };
      }

      const doc = docResult.rows[0];

      const [transitions, evidence] = await Promise.all([
        knex
          .raw(
            `SELECT id, action, from_status, to_status, from_version, to_version,
                    performed_by, comment, evidence_ref, performed_at
             FROM qms.document_transitions
             WHERE document_id = ?
             ORDER BY performed_at DESC`,
            [document_id],
          )
          .transacting(trx),
        knex
          .raw(
            `SELECT de.id, de.transition_id, de.evidence_type,
                    de.evidence_data, de.evidence_text, de.recorded_by,
                    de.recorded_at, de.is_superseded,
                    ret.label AS evidence_type_label, ret.phase
             FROM qms.document_evidence de
             JOIN qms.ref_evidence_types ret ON ret.code = de.evidence_type
             WHERE de.document_id = ?
             ORDER BY de.recorded_at DESC`,
            [document_id],
          )
          .transacting(trx),
      ]);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/register/${encodeURIComponent(document_id)}`,
          ...doc,
          transitions: transitions.rows,
          evidence: evidence.rows,
        },
      };
    },
  },

  // Upcoming and overdue reviews
  {
    op: 'get',
    view: '/@qms/reviews',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getQmsReviews',
    handler: async (req, trx) => {
      const knex = Model.knex();

      const [overdue, upcoming] = await Promise.all([
        knex
          .raw(
            `SELECT document_id, title, version, status, next_review_date,
                    owner, days_overdue
             FROM qms.overdue_reviews`,
          )
          .transacting(trx),
        knex
          .raw(
            `SELECT cd.document_id, cd.title, cd.version, cd.status,
                    cd.next_review_date, cd.owner,
                    (cd.next_review_date - CURRENT_DATE) AS days_until
             FROM qms.controlled_documents cd
             WHERE cd.next_review_date IS NOT NULL
               AND cd.next_review_date > CURRENT_DATE
               AND cd.status IN ('effective', 'draft')
             ORDER BY cd.next_review_date
             LIMIT 50`,
          )
          .transacting(trx),
      ]);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/reviews`,
          overdue: overdue.rows,
          upcoming: upcoming.rows,
        },
      };
    },
  },

  // External standards list
  {
    op: 'get',
    view: '/@qms/external',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getQmsExternal',
    handler: async (req, trx) => {
      const knex = Model.knex();

      const result = await knex
        .raw(
          `SELECT id, document_id, title, edition, publisher, acquired_date,
                  owner, current_status, last_checked, next_check_date, notes
           FROM qms.external_documents
           ORDER BY document_id`,
        )
        .transacting(trx);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/external`,
          items: result.rows,
          items_total: result.rows.length,
        },
      };
    },
  },

  // =========================================================================
  // WRITE ENDPOINTS (permission: 'Manage Documents')
  // =========================================================================

  // Create new controlled document
  {
    op: 'post',
    view: '/@qms/register',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'postQmsDocument',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const {
        document_id,
        title,
        document_type,
        domain_code,
        version = '0.1',
        status = 'draft',
        classification = 'internal',
        effective_date,
        next_review_date,
        owner,
        author,
        reviewer,
        approver,
        implements: implementsDoc,
        retention_years = 10,
        retention_basis = 'EU MDR Art 10.8',
        location,
        docs_id,
        body_md,
        notes,
      } = req.body;

      if (!document_id || !title || !document_type || !domain_code) {
        return {
          status: 400,
          json: {
            error:
              'Required fields: document_id, title, document_type, domain_code',
          },
        };
      }

      const performed_by = req.user?.id || 'unknown';

      const result = await knex
        .raw(
          `INSERT INTO qms.controlled_documents
            (document_id, title, document_type, domain_code, version, status,
             classification, effective_date, next_review_date,
             owner, author, reviewer, approver, implements,
             retention_years, retention_basis, location, docs_id, body_md, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id, document_id, title, document_type, domain_code,
                     version, status, classification, effective_date,
                     next_review_date, owner, author, reviewer, approver,
                     implements, retention_years, retention_basis, location,
                     docs_id, body_md, notes, created_at, updated_at`,
          [
            document_id,
            title,
            document_type,
            domain_code,
            version,
            status,
            classification,
            effective_date || null,
            next_review_date || null,
            owner || null,
            author || null,
            reviewer || null,
            approver || null,
            implementsDoc || null,
            retention_years,
            retention_basis,
            location || null,
            docs_id || null,
            body_md || null,
            notes || null,
          ],
        )
        .transacting(trx);

      // Record the create transition
      await knex
        .raw(
          `INSERT INTO qms.document_transitions
            (document_id, action, to_status, to_version, performed_by, comment)
           VALUES (?, 'create', ?, ?, ?, ?)`,
          [document_id, status, version, performed_by, 'Created via web UI'],
        )
        .transacting(trx);

      const doc = result.rows[0];
      return {
        status: 201,
        json: {
          '@id': `${getRootUrl(req)}/@qms/register/${encodeURIComponent(document_id)}`,
          ...doc,
        },
      };
    },
  },

  // Register a document from Knowledge Base
  {
    op: 'post',
    view: '/@qms/register/from-kb',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'postQmsFromKb',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const {
        docs_id,
        document_id,
        title,
        document_type,
        domain_code,
        version = '1.0',
        status = 'effective',
        classification = 'internal',
        notes,
      } = req.body;

      if (!docs_id || !document_id || !title || !document_type || !domain_code) {
        return {
          status: 400,
          json: {
            error:
              'Required fields: docs_id, document_id, title, document_type, domain_code',
          },
        };
      }

      // Verify the KB doc exists
      const kbDoc = await knex
        .raw('SELECT id, file_path FROM i18n.docs WHERE id = ?', [docs_id])
        .transacting(trx);

      if (kbDoc.rows.length === 0) {
        return {
          status: 404,
          json: { error: 'Knowledge Base document not found' },
        };
      }

      const performed_by = req.user?.id || 'unknown';

      const result = await knex
        .raw(
          `INSERT INTO qms.controlled_documents
            (document_id, title, document_type, domain_code, version, status,
             classification, location, docs_id, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id, document_id, title, document_type, domain_code,
                     version, status, classification, effective_date,
                     next_review_date, owner, author, reviewer, approver,
                     implements, retention_years, retention_basis, location,
                     docs_id, body_md, notes, created_at, updated_at`,
          [
            document_id,
            title,
            document_type,
            domain_code,
            version,
            status,
            classification,
            kbDoc.rows[0].file_path,
            docs_id,
            notes || 'Registered from Knowledge Base',
          ],
        )
        .transacting(trx);

      // Record the register transition
      await knex
        .raw(
          `INSERT INTO qms.document_transitions
            (document_id, action, to_status, to_version, performed_by, comment)
           VALUES (?, 'register', ?, ?, ?, ?)`,
          [
            document_id,
            status,
            version,
            performed_by,
            'Registered from Knowledge Base via reconciliation',
          ],
        )
        .transacting(trx);

      const doc = result.rows[0];
      return {
        status: 201,
        json: {
          '@id': `${getRootUrl(req)}/@qms/register/${encodeURIComponent(document_id)}`,
          ...doc,
        },
      };
    },
  },

  // Batch register documents from Knowledge Base
  {
    op: 'post',
    view: '/@qms/register/from-kb/batch',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'postQmsFromKbBatch',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { items } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        return {
          status: 400,
          json: { error: 'Required: items array with registration data' },
        };
      }

      const performed_by = req.user?.id || 'unknown';
      const registered = [];
      const errors = [];

      for (const item of items) {
        try {
          const {
            docs_id,
            document_id,
            title,
            document_type,
            domain_code,
            version = '1.0',
            status = 'effective',
            classification = 'internal',
            notes,
          } = item;

          if (!docs_id || !document_id || !title || !document_type || !domain_code) {
            errors.push({
              document_id: document_id || '(missing)',
              error: 'Missing required fields',
            });
            continue;
          }

          const kbDoc = await knex
            .raw('SELECT id, file_path FROM i18n.docs WHERE id = ?', [docs_id])
            .transacting(trx);

          if (kbDoc.rows.length === 0) {
            errors.push({ document_id, error: 'KB document not found' });
            continue;
          }

          await knex
            .raw(
              `INSERT INTO qms.controlled_documents
                (document_id, title, document_type, domain_code, version, status,
                 classification, location, docs_id, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                document_id,
                title,
                document_type,
                domain_code,
                version,
                status,
                classification,
                kbDoc.rows[0].file_path,
                docs_id,
                notes || 'Batch registered from Knowledge Base',
              ],
            )
            .transacting(trx);

          await knex
            .raw(
              `INSERT INTO qms.document_transitions
                (document_id, action, to_status, to_version, performed_by, comment)
               VALUES (?, 'register', ?, ?, ?, ?)`,
              [
                document_id,
                status,
                version,
                performed_by,
                'Batch registered from Knowledge Base via reconciliation',
              ],
            )
            .transacting(trx);

          registered.push(document_id);
        } catch (err) {
          errors.push({
            document_id: item.document_id || '(unknown)',
            error: err.message,
          });
        }
      }

      return {
        status: 201,
        json: {
          '@id': `${getRootUrl(req)}/@qms/register/from-kb/batch`,
          registered,
          registered_count: registered.length,
          errors,
          error_count: errors.length,
        },
      };
    },
  },

  // Update document metadata and/or body
  {
    op: 'put',
    view: '/@qms/register/:document_id',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'putQmsDocument',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { document_id } = req.params;

      if (!DOC_ID_RE.test(document_id)) {
        return { status: 400, json: { error: 'Invalid document ID format' } };
      }

      // Check document exists
      const existing = await knex
        .raw(
          'SELECT id, document_id, status, version FROM qms.controlled_documents WHERE document_id = ?',
          [document_id],
        )
        .transacting(trx);

      if (existing.rows.length === 0) {
        return { status: 404, json: { error: 'Document not found' } };
      }

      // Build SET clause from provided fields
      const allowedFields = [
        'title',
        'document_type',
        'domain_code',
        'version',
        'status',
        'classification',
        'effective_date',
        'next_review_date',
        'owner',
        'author',
        'reviewer',
        'approver',
        'implements',
        'retention_years',
        'retention_basis',
        'location',
        'docs_id',
        'body_md',
        'notes',
      ];

      const setClauses = [];
      const setValues = [];

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          setClauses.push(`${field} = ?`);
          setValues.push(req.body[field] === '' ? null : req.body[field]);
        }
      }

      if (setClauses.length === 0) {
        return {
          status: 400,
          json: { error: 'No fields to update' },
        };
      }

      const result = await knex
        .raw(
          `UPDATE qms.controlled_documents
           SET ${setClauses.join(', ')}
           WHERE document_id = ?
           RETURNING id, document_id, title, document_type, domain_code,
                     version, status, classification, effective_date,
                     next_review_date, owner, author, reviewer, approver,
                     implements, retention_years, retention_basis, location,
                     docs_id, body_md, notes, created_at, updated_at`,
          [...setValues, document_id],
        )
        .transacting(trx);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/register/${encodeURIComponent(document_id)}`,
          ...result.rows[0],
        },
      };
    },
  },

  // Record a state transition
  {
    op: 'post',
    view: '/@qms/register/:document_id/transition',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'postQmsTransition',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { document_id } = req.params;

      if (!DOC_ID_RE.test(document_id)) {
        return { status: 400, json: { error: 'Invalid document ID format' } };
      }

      const { action, to_status, to_version, comment, evidence_ref } =
        req.body;

      if (!action) {
        return {
          status: 400,
          json: { error: 'Required field: action' },
        };
      }

      // Get current document state
      const existing = await knex
        .raw(
          'SELECT status, version FROM qms.controlled_documents WHERE document_id = ?',
          [document_id],
        )
        .transacting(trx);

      if (existing.rows.length === 0) {
        return { status: 404, json: { error: 'Document not found' } };
      }

      const current = existing.rows[0];
      const performed_by = req.user?.id || 'unknown';

      // Record the transition
      const transResult = await knex
        .raw(
          `INSERT INTO qms.document_transitions
            (document_id, action, from_status, to_status, from_version, to_version,
             performed_by, comment, evidence_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id, document_id, action, from_status, to_status,
                     from_version, to_version, performed_by, comment,
                     evidence_ref, performed_at`,
          [
            document_id,
            action,
            current.status,
            to_status || current.status,
            current.version,
            to_version || current.version,
            performed_by,
            comment || null,
            evidence_ref || null,
          ],
        )
        .transacting(trx);

      // Update the document if status or version changed
      if (to_status || to_version) {
        const updates = [];
        const vals = [];
        if (to_status) {
          updates.push('status = ?');
          vals.push(to_status);
        }
        if (to_version) {
          updates.push('version = ?');
          vals.push(to_version);
        }
        if (to_status === 'effective') {
          updates.push('effective_date = CURRENT_DATE');
        }
        await knex
          .raw(
            `UPDATE qms.controlled_documents SET ${updates.join(', ')} WHERE document_id = ?`,
            [...vals, document_id],
          )
          .transacting(trx);
      }

      return {
        status: 201,
        json: {
          '@id': `${getRootUrl(req)}/@qms/register/${encodeURIComponent(document_id)}/transition`,
          transition: transResult.rows[0],
        },
      };
    },
  },

  // =========================================================================
  // ISSUE TRACKER (read-only views of qms.problem_reports)
  // =========================================================================

  // Issue list with filters, facets, and pagination
  {
    op: 'get',
    view: '/@qms/issues',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getQmsIssues',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const {
        severity,
        status,
        problem_type,
        search,
        page = 1,
        page_size = 50,
      } = req.query;

      const offset =
        (Math.max(1, parseInt(page, 10)) - 1) *
        Math.min(100, Math.max(1, parseInt(page_size, 10)));
      const limit = Math.min(100, Math.max(1, parseInt(page_size, 10)));

      const conditions = [];
      const params = [];

      if (severity) {
        conditions.push('pr.severity = ?');
        params.push(severity);
      }
      if (status) {
        conditions.push('pr.status = ?');
        params.push(status);
      }
      if (problem_type) {
        conditions.push('pr.problem_type = ?');
        params.push(problem_type);
      }
      if (search) {
        conditions.push('(pr.title ILIKE ? OR pr.report_id ILIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count + items + facets in parallel
      const [countResult, itemsResult, severities, statuses, types, summary] =
        await Promise.all([
          knex
            .raw(
              `SELECT COUNT(*) FROM qms.problem_reports pr ${where}`,
              params,
            )
            .transacting(trx),
          knex
            .raw(
              `SELECT pr.report_id, pr.title, pr.severity, pr.status,
                      pr.problem_type, pr.scope, pr.affected_component,
                      pr.reported_by, pr.reported_at, pr.disposition,
                      pr.related_capa_id, pr.related_dr_id,
                      rps.is_open,
                      now() - pr.reported_at AS age,
                      CASE
                        WHEN pr.severity = 'critical' AND (now() - pr.reported_at) > interval '24 hours' THEN 'OVERDUE'
                        WHEN pr.severity = 'high' AND (now() - pr.reported_at) > interval '5 days' THEN 'OVERDUE'
                        WHEN pr.severity = 'medium' AND (now() - pr.reported_at) > interval '10 days' THEN 'OVERDUE'
                        WHEN pr.severity = 'low' AND (now() - pr.reported_at) > interval '20 days' THEN 'OVERDUE'
                        ELSE 'ON TRACK'
                      END AS sla_status
               FROM qms.problem_reports pr
               JOIN qms.ref_problem_statuses rps ON rps.code = pr.status
               ${where}
               ORDER BY rps.sort_order, pr.reported_at DESC
               LIMIT ? OFFSET ?`,
              [...params, limit, offset],
            )
            .transacting(trx),
          knex
            .raw(
              `SELECT rs.code, rs.label, COUNT(pr.id)::int AS count
               FROM qms.ref_problem_severities rs
               LEFT JOIN qms.problem_reports pr ON pr.severity = rs.code
               GROUP BY rs.code, rs.label, rs.sort_order
               ORDER BY rs.sort_order`,
            )
            .transacting(trx),
          knex
            .raw(
              `SELECT rps.code, rps.label, rps.is_open, COUNT(pr.id)::int AS count
               FROM qms.ref_problem_statuses rps
               LEFT JOIN qms.problem_reports pr ON pr.status = rps.code
               GROUP BY rps.code, rps.label, rps.is_open, rps.sort_order
               ORDER BY rps.sort_order`,
            )
            .transacting(trx),
          knex
            .raw(
              `SELECT rpt.code, rpt.label, COUNT(pr.id)::int AS count
               FROM qms.ref_problem_types rpt
               LEFT JOIN qms.problem_reports pr ON pr.problem_type = rpt.code
               GROUP BY rpt.code, rpt.label
               ORDER BY rpt.label`,
            )
            .transacting(trx),
          knex
            .raw(
              `SELECT
                 COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE rps.is_open)::int AS open,
                 COUNT(*) FILTER (WHERE NOT rps.is_open)::int AS closed,
                 COUNT(*) FILTER (WHERE pr.severity IN ('critical','high') AND rps.is_open)::int AS high_severity_open
               FROM qms.problem_reports pr
               JOIN qms.ref_problem_statuses rps ON rps.code = pr.status`,
            )
            .transacting(trx),
        ]);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/issues`,
          items: itemsResult.rows,
          items_total: parseInt(countResult.rows[0].count, 10),
          page: parseInt(page, 10),
          page_size: limit,
          severities: severities.rows,
          statuses: statuses.rows,
          types: types.rows,
          summary: summary.rows[0],
        },
      };
    },
  },

  // Single issue detail
  {
    op: 'get',
    view: '/@qms/issues/:report_id',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getQmsIssue',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { report_id } = req.params;

      const prResult = await knex
        .raw(
          `SELECT pr.*,
                  rps.label AS status_label, rps.is_open,
                  rs.label AS severity_label,
                  rpt.label AS type_label
           FROM qms.problem_reports pr
           JOIN qms.ref_problem_statuses rps ON rps.code = pr.status
           JOIN qms.ref_problem_severities rs ON rs.code = pr.severity
           JOIN qms.ref_problem_types rpt ON rpt.code = pr.problem_type
           WHERE pr.report_id = ?`,
          [report_id],
        )
        .transacting(trx);

      if (prResult.rows.length === 0) {
        return { status: 404, json: { error: 'Issue not found' } };
      }

      const issue = prResult.rows[0];

      // Fetch related document links (if any link this report_id)
      const linksResult = await knex
        .raw(
          `SELECT b.id, b.relationship_type, b.relationship_label,
                  b.direction, b.related_doc_id, b.notes,
                  b.created_at,
                  cd.title AS related_title, cd.status AS related_status
           FROM qms.document_links_bidirectional b
           LEFT JOIN qms.controlled_documents cd
             ON cd.document_id = b.related_doc_id
           WHERE b.doc_id = ?
           ORDER BY b.direction, b.relationship_label`,
          [report_id],
        )
        .transacting(trx);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/issues/${encodeURIComponent(report_id)}`,
          ...issue,
          links: linksResult.rows,
        },
      };
    },
  },
];
