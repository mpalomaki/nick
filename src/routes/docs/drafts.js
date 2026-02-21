/**
 * Document draft management routes.
 *
 * Implements the draft lifecycle from SOP-DC-001 §8.1:
 *   Draft → In Review → Effective (approve) or → Draft (reject)
 *
 * Drafts are ephemeral — at most one per document. On approval the draft
 * content replaces the effective document in i18n.docs, the previous
 * effective version is snapshotted to i18n.doc_versions, and the draft
 * row is deleted.
 *
 * All endpoints require 'Manage Documents' permission.
 * Slug is passed via query parameter (?slug=) for GET/DELETE,
 * or in the request body for PUT/POST (matching nick's path-to-regexp v8).
 *
 * Evidence capture (CR-2026-026): PUT accepts justification on first save,
 * POST submit accepts COI + qualification, POST approve accepts checklist +
 * approval justification + change classification, POST reject accepts
 * structured rejection feedback. Evidence is only recorded for QMS-registered
 * documents.
 *
 * Ref: CR-2026-025, CR-2026-026
 * @module routes/docs/drafts
 */

import { Model } from '../../models/_model/_model';
import { getRootUrl } from '../../helpers/url/url';
import { apiLimiter } from '../../helpers/limiter/limiter';

/**
 * Look up the QMS document_id for a given i18n.docs.id.
 * Returns null if the document is not QMS-registered.
 */
async function getQmsDocumentId(knex, docsId, trx) {
  const result = await knex
    .raw(
      'SELECT document_id FROM qms.controlled_documents WHERE docs_id = ?',
      [docsId],
    )
    .transacting(trx);
  return result.rows.length > 0 ? result.rows[0].document_id : null;
}

/**
 * Insert a document_evidence row. Returns the inserted row.
 */
async function insertEvidence(
  knex,
  trx,
  { documentId, transitionId, evidenceType, evidenceData, evidenceText, recordedBy },
) {
  const result = await knex
    .raw(
      `INSERT INTO qms.document_evidence
         (document_id, transition_id, evidence_type, evidence_data, evidence_text, recorded_by)
       VALUES (?, ?, ?, ?::jsonb, ?, ?)
       RETURNING id`,
      [
        documentId,
        transitionId || null,
        evidenceType,
        JSON.stringify(evidenceData),
        evidenceText || null,
        recordedBy,
      ],
    )
    .transacting(trx);
  return result.rows[0];
}

export default [
  // =========================================================================
  // GET draft for a document
  // =========================================================================
  {
    op: 'get',
    view: '/@docs/draft',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'getDocDraft',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const slug = req.query.slug;

      if (!slug) {
        return { status: 400, json: { error: 'Document slug required' } };
      }

      const result = await knex
        .raw(
          `SELECT dr.*, d.slug, d.title AS effective_title,
                  d.version AS effective_version, d.status AS effective_status
           FROM i18n.doc_drafts dr
           JOIN i18n.docs d ON d.id = dr.doc_id
           WHERE d.slug = ?`,
          [slug],
        )
        .transacting(trx);

      if (result.rows.length === 0) {
        return { status: 404, json: { error: 'No draft found for this document' } };
      }

      return {
        json: {
          '@id': `${getRootUrl(req)}/@docs/draft?slug=${encodeURIComponent(slug)}`,
          ...result.rows[0],
        },
      };
    },
  },

  // =========================================================================
  // PUT (create or update) draft for a document
  // =========================================================================
  {
    op: 'put',
    view: '/@docs/draft',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'putDocDraft',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const slug = req.body.slug;
      const userId = req.user?.id || 'unknown';

      if (!slug) {
        return { status: 400, json: { error: 'Document slug required' } };
      }

      // Resolve doc_id from slug
      const docResult = await knex
        .raw('SELECT id, version, title, body_md, frontmatter FROM i18n.docs WHERE slug = ?', [slug])
        .transacting(trx);

      if (docResult.rows.length === 0) {
        return { status: 404, json: { error: 'Document not found' } };
      }

      const doc = docResult.rows[0];
      const {
        version,
        title,
        body_md,
        frontmatter,
        justification,
      } = req.body;

      // Version is required for a draft
      if (!version) {
        return { status: 400, json: { error: 'Version is required for a draft' } };
      }

      // Upsert: insert or update the single draft for this document
      const result = await knex
        .raw(
          `INSERT INTO i18n.doc_drafts
             (doc_id, version, title, body_md, frontmatter, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?::jsonb, ?, ?)
           ON CONFLICT (doc_id) DO UPDATE SET
             version = EXCLUDED.version,
             title = EXCLUDED.title,
             body_md = EXCLUDED.body_md,
             frontmatter = EXCLUDED.frontmatter,
             updated_by = EXCLUDED.updated_by,
             status = CASE
               WHEN i18n.doc_drafts.status = 'rejected' THEN 'draft'
               ELSE i18n.doc_drafts.status
             END,
             reviewer_notes = CASE
               WHEN i18n.doc_drafts.status = 'rejected' THEN NULL
               ELSE i18n.doc_drafts.reviewer_notes
             END
           RETURNING id, doc_id, version, title, body_md, frontmatter,
                    status, created_by, updated_by, created_at, updated_at,
                    reviewer_notes`,
          [
            doc.id,
            version,
            title !== undefined ? title : doc.title,
            body_md !== undefined ? body_md : doc.body_md,
            frontmatter !== undefined ? JSON.stringify(frontmatter) : JSON.stringify(doc.frontmatter),
            userId,
            userId,
          ],
        )
        .transacting(trx);

      const draft = result.rows[0];
      const isNew = draft.created_at.getTime() === draft.updated_at.getTime();

      // CR-2026-026: Record justification evidence on first save of a QMS document
      if (isNew && justification) {
        const qmsDocId = await getQmsDocumentId(knex, doc.id, trx);
        if (qmsDocId) {
          await insertEvidence(knex, trx, {
            documentId: qmsDocId,
            transitionId: null,
            evidenceType: 'justification',
            evidenceData: {
              what: justification.what || '',
              why: justification.why || '',
              scope: justification.scope || '',
              classification_estimate: justification.classification_estimate || '',
              trigger: justification.trigger || 'manual',
            },
            evidenceText: `Justification: ${justification.why || '(not provided)'}`,
            recordedBy: userId,
          });
        }
      }

      return {
        status: isNew ? 201 : 200,
        json: {
          '@id': `${getRootUrl(req)}/@docs/draft?slug=${encodeURIComponent(slug)}`,
          ...draft,
        },
      };
    },
  },

  // =========================================================================
  // DELETE (abandon) draft
  // =========================================================================
  {
    op: 'delete',
    view: '/@docs/draft',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'deleteDocDraft',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const slug = req.query.slug;

      if (!slug) {
        return { status: 400, json: { error: 'Document slug required' } };
      }

      const result = await knex
        .raw(
          `DELETE FROM i18n.doc_drafts
           WHERE doc_id = (SELECT id FROM i18n.docs WHERE slug = ?)
           RETURNING id`,
          [slug],
        )
        .transacting(trx);

      if (result.rows.length === 0) {
        return { status: 404, json: { error: 'No draft found for this document' } };
      }

      return {
        json: {
          '@id': `${getRootUrl(req)}/@docs/draft?slug=${encodeURIComponent(slug)}`,
          message: 'Draft abandoned successfully',
        },
      };
    },
  },

  // =========================================================================
  // POST submit draft for review (draft → in_review)
  // =========================================================================
  {
    op: 'post',
    view: '/@docs/draft/submit',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'postDocDraftSubmit',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const slug = req.body.slug;
      const userId = req.user?.id || 'unknown';
      const { coi_declaration, qualification } = req.body;

      if (!slug) {
        return { status: 400, json: { error: 'Document slug required' } };
      }

      const result = await knex
        .raw(
          `UPDATE i18n.doc_drafts
           SET status = 'in_review',
               reviewer_notes = NULL,
               updated_by = ?
           WHERE doc_id = (SELECT id FROM i18n.docs WHERE slug = ?)
             AND status IN ('draft', 'rejected')
           RETURNING id, doc_id, version, title, body_md, frontmatter,
                    status, created_by, updated_by, created_at, updated_at,
                    reviewer_notes`,
          [userId, slug],
        )
        .transacting(trx);

      if (result.rows.length === 0) {
        // Check if draft exists but wrong status
        const check = await knex
          .raw(
            `SELECT status FROM i18n.doc_drafts
             WHERE doc_id = (SELECT id FROM i18n.docs WHERE slug = ?)`,
            [slug],
          )
          .transacting(trx);

        if (check.rows.length > 0) {
          return {
            status: 409,
            json: {
              error: `Cannot submit: draft is currently '${check.rows[0].status}'`,
            },
          };
        }
        return { status: 404, json: { error: 'No draft found for this document' } };
      }

      const draftRow = result.rows[0];

      // CR-2026-026: Record COI + qualification evidence for QMS documents
      const qmsDocId = await getQmsDocumentId(knex, draftRow.doc_id, trx);
      if (qmsDocId) {
        if (coi_declaration) {
          await insertEvidence(knex, trx, {
            documentId: qmsDocId,
            transitionId: null,
            evidenceType: 'coi_declaration',
            evidenceData: {
              has_conflict: coi_declaration.has_conflict || false,
              declaration: coi_declaration.declaration || '',
              micro_enterprise_provision: coi_declaration.micro_enterprise_provision || false,
              same_author_reviewer: coi_declaration.same_author_reviewer || false,
              mitigation: coi_declaration.mitigation || '',
            },
            evidenceText: coi_declaration.has_conflict
              ? `COI declared: ${coi_declaration.declaration}`
              : 'No conflicts of interest declared',
            recordedBy: userId,
          });
        }

        if (qualification) {
          await insertEvidence(knex, trx, {
            documentId: qmsDocId,
            transitionId: null,
            evidenceType: 'qualification',
            evidenceData: {
              contributors: qualification.contributors || [
                {
                  user_id: userId,
                  role: 'reviewer',
                  basis: qualification.basis || '',
                },
              ],
            },
            evidenceText: `Qualification: ${qualification.basis || '(see evidence_data)'}`,
            recordedBy: userId,
          });
        }
      }

      return {
        json: {
          '@id': `${getRootUrl(req)}/@docs/draft?slug=${encodeURIComponent(slug)}`,
          ...draftRow,
          message: 'Draft submitted for review',
        },
      };
    },
  },

  // =========================================================================
  // POST approve draft → publish
  // =========================================================================
  // This is the critical transaction:
  //   1. Snapshot current i18n.docs content → doc_versions
  //   2. Set superseded_at/by on the previous version snapshot
  //   3. Copy draft content into i18n.docs (UPDATE)
  //   4. Record document_transitions entry (if QMS-registered)
  //   5. DELETE the draft from doc_drafts
  //   All in a single transaction (trx provided by nick framework)
  // =========================================================================
  {
    op: 'post',
    view: '/@docs/draft/approve',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'postDocDraftApprove',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const slug = req.body.slug;
      const userId = req.user?.id || 'unknown';
      const comment = req.body.comment;
      const {
        checklist,
        approval_justification,
        change_classification,
      } = req.body;

      if (!slug) {
        return { status: 400, json: { error: 'Document slug required' } };
      }

      // 1. Fetch the draft
      const draftResult = await knex
        .raw(
          `SELECT dr.*, d.id AS doc_id, d.slug, d.title AS current_title,
                  d.version AS current_version, d.body_md AS current_body_md,
                  d.frontmatter AS current_frontmatter, d.author AS current_author
           FROM i18n.doc_drafts dr
           JOIN i18n.docs d ON d.id = dr.doc_id
           WHERE d.slug = ?`,
          [slug],
        )
        .transacting(trx);

      if (draftResult.rows.length === 0) {
        return { status: 404, json: { error: 'No draft found for this document' } };
      }

      const draft = draftResult.rows[0];

      // Must be in_review to approve
      if (draft.status !== 'in_review') {
        return {
          status: 409,
          json: {
            error: `Cannot approve: draft status is '${draft.status}', expected 'in_review'`,
          },
        };
      }

      // 2. Snapshot current effective version → doc_versions
      await knex
        .raw(
          `INSERT INTO i18n.doc_versions
             (doc_id, version, title, body_md, frontmatter, author,
              published_by, published_at, content_hash)
           VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, now(),
                   CASE WHEN ?::text IS NOT NULL
                        THEN encode(sha256(convert_to(?, 'UTF8')), 'hex')
                        ELSE NULL
                   END)
           ON CONFLICT (doc_id, version) DO NOTHING`,
          [
            draft.doc_id,
            draft.current_version || '0.0',
            draft.current_title,
            draft.current_body_md,
            JSON.stringify(draft.current_frontmatter),
            draft.current_author,
            userId,
            draft.current_body_md,
            draft.current_body_md,
          ],
        )
        .transacting(trx);

      // 3. Mark previous version(s) as superseded
      await knex
        .raw(
          `UPDATE i18n.doc_versions
           SET superseded_at = now(), superseded_by = ?
           WHERE doc_id = ? AND superseded_at IS NULL AND version != ?`,
          [draft.version, draft.doc_id, draft.version],
        )
        .transacting(trx);

      // 4. Copy draft content into i18n.docs
      await knex
        .raw(
          `UPDATE i18n.docs SET
             title = COALESCE(?, title),
             body_md = COALESCE(?, body_md),
             version = ?,
             frontmatter = COALESCE(?::jsonb, frontmatter),
             is_edited = true,
             edited_by = ?,
             updated_at = now()
           WHERE id = ?`,
          [
            draft.title,
            draft.body_md,
            draft.version,
            draft.frontmatter ? JSON.stringify(draft.frontmatter) : null,
            userId,
            draft.doc_id,
          ],
        )
        .transacting(trx);

      // 5. Record QMS transition if document is QMS-registered
      const qmsDocId = await getQmsDocumentId(knex, draft.doc_id, trx);

      if (qmsDocId) {
        // CR-2026-026: Validation gate — reject approval if required Phase 1-2
        // evidence is missing (justification + COI + qualification)
        const missingCheck = await knex
          .raw(
            `SELECT ret.code, ret.label
             FROM qms.ref_evidence_types ret
             WHERE ret.required = true AND ret.phase <= 2
               AND NOT EXISTS (
                 SELECT 1 FROM qms.document_evidence de
                 WHERE de.document_id = ?
                   AND de.evidence_type = ret.code
                   AND NOT de.is_superseded
               )`,
            [qmsDocId],
          )
          .transacting(trx);

        if (missingCheck.rows.length > 0) {
          const missing = missingCheck.rows.map((r) => r.label).join(', ');
          return {
            status: 422,
            json: {
              error: `Cannot approve: required evidence is missing: ${missing}`,
              missing_evidence: missingCheck.rows,
            },
          };
        }

        // Record the transition with RETURNING id for evidence linking
        const transResult = await knex
          .raw(
            `INSERT INTO qms.document_transitions
               (document_id, action, from_status, to_status, from_version, to_version,
                performed_by, comment)
             VALUES (?, 'approve', 'in_review', 'effective', ?, ?, ?, ?)
             RETURNING id`,
            [
              qmsDocId,
              draft.current_version || '0.0',
              draft.version,
              userId,
              comment || 'Approved via draft management',
            ],
          )
          .transacting(trx);

        const transitionId = transResult.rows[0].id;

        // CR-2026-026: Record approval evidence linked to the transition
        if (checklist) {
          await insertEvidence(knex, trx, {
            documentId: qmsDocId,
            transitionId,
            evidenceType: 'self_review_checklist',
            evidenceData: {
              frm_dc_004_version: checklist.frm_dc_004_version || '1.0',
              sections: checklist.sections || {},
              outcome: checklist.outcome || {
                decision: 'pass',
                reviewer_signature: userId,
              },
            },
            evidenceText: `FRM-DC-004 self-review: ${(checklist.outcome?.decision || 'pass').toUpperCase()}`,
            recordedBy: userId,
          });
        }

        if (approval_justification) {
          await insertEvidence(knex, trx, {
            documentId: qmsDocId,
            transitionId,
            evidenceType: 'approval_justification',
            evidenceData: {
              decision: 'approve',
              justification: approval_justification.justification || '',
              ai_assisted: approval_justification.ai_assisted || false,
              ai_disclosure: approval_justification.ai_disclosure || '',
            },
            evidenceText: `Approved: ${approval_justification.justification || comment || '(no justification)'}`,
            recordedBy: userId,
          });
        }

        if (change_classification) {
          await insertEvidence(knex, trx, {
            documentId: qmsDocId,
            transitionId,
            evidenceType: 'change_classification',
            evidenceData: {
              classification: change_classification.classification || 'PATCH',
              rationale: change_classification.rationale || '',
            },
            evidenceText: `Classification: ${change_classification.classification || 'PATCH'} — ${change_classification.rationale || ''}`,
            recordedBy: userId,
          });
        }

        // Update the QMS document register: version + status → effective
        await knex
          .raw(
            `UPDATE qms.controlled_documents
             SET version = ?, status = 'effective',
                 effective_date = CURRENT_DATE, updated_at = now()
             WHERE docs_id = ?`,
            [draft.version, draft.doc_id],
          )
          .transacting(trx);
      }

      // 6. Create the new version snapshot
      await knex
        .raw(
          `INSERT INTO i18n.doc_versions
             (doc_id, version, title, body_md, frontmatter, author,
              published_by, published_at, content_hash)
           VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, now(),
                   CASE WHEN ?::text IS NOT NULL
                        THEN encode(sha256(convert_to(?, 'UTF8')), 'hex')
                        ELSE NULL
                   END)
           ON CONFLICT (doc_id, version) DO NOTHING`,
          [
            draft.doc_id,
            draft.version,
            draft.title || draft.current_title,
            draft.body_md || draft.current_body_md,
            JSON.stringify(draft.frontmatter || draft.current_frontmatter),
            draft.current_author,
            userId,
            draft.body_md || draft.current_body_md,
            draft.body_md || draft.current_body_md,
          ],
        )
        .transacting(trx);

      // 7. Delete the draft
      await knex
        .raw('DELETE FROM i18n.doc_drafts WHERE id = ?', [draft.id])
        .transacting(trx);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@docs/view?slug=${encodeURIComponent(slug)}`,
          message: `Version ${draft.version} published successfully`,
          version: draft.version,
          previous_version: draft.current_version || '0.0',
        },
      };
    },
  },

  // =========================================================================
  // POST reject draft → back to author
  // =========================================================================
  {
    op: 'post',
    view: '/@docs/draft/reject',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'postDocDraftReject',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const slug = req.body.slug;
      const notes = req.body.notes;
      const userId = req.user?.id || 'unknown';
      const { rejection } = req.body;

      if (!slug) {
        return { status: 400, json: { error: 'Document slug required' } };
      }

      if (!notes) {
        return {
          status: 400,
          json: { error: 'Reviewer notes are required when rejecting a draft' },
        };
      }

      const result = await knex
        .raw(
          `UPDATE i18n.doc_drafts
           SET status = 'rejected',
               reviewer_notes = ?,
               updated_by = ?
           WHERE doc_id = (SELECT id FROM i18n.docs WHERE slug = ?)
             AND status = 'in_review'
           RETURNING id, doc_id, version, title, body_md, frontmatter,
                    status, created_by, updated_by, created_at, updated_at,
                    reviewer_notes`,
          [notes, userId, slug],
        )
        .transacting(trx);

      if (result.rows.length === 0) {
        const check = await knex
          .raw(
            `SELECT status FROM i18n.doc_drafts
             WHERE doc_id = (SELECT id FROM i18n.docs WHERE slug = ?)`,
            [slug],
          )
          .transacting(trx);

        if (check.rows.length > 0) {
          return {
            status: 409,
            json: {
              error: `Cannot reject: draft status is '${check.rows[0].status}', expected 'in_review'`,
            },
          };
        }
        return { status: 404, json: { error: 'No draft found for this document' } };
      }

      const draftRow = result.rows[0];

      // CR-2026-026: Record structured rejection evidence for QMS documents
      const qmsDocId = await getQmsDocumentId(knex, draftRow.doc_id, trx);
      if (qmsDocId) {
        await insertEvidence(knex, trx, {
          documentId: qmsDocId,
          transitionId: null,
          evidenceType: 'rejection_feedback',
          evidenceData: {
            categories: rejection?.categories || [],
            feedback: notes,
            severity: rejection?.severity || 'major',
            action_required: rejection?.action_required || '',
          },
          evidenceText: `Rejected (${rejection?.severity || 'major'}): ${notes}`,
          recordedBy: userId,
        });
      }

      return {
        json: {
          '@id': `${getRootUrl(req)}/@docs/draft?slug=${encodeURIComponent(slug)}`,
          ...draftRow,
          message: 'Draft rejected and returned to author',
        },
      };
    },
  },
];
