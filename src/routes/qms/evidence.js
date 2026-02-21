/**
 * QMS Document Evidence routes.
 *
 * Records and retrieves structured evidence for document lifecycle phases
 * per SOP-DC-001 §14.
 *
 * Read endpoints require 'Access Developer Tools'.
 * Write endpoints require 'Manage Documents'.
 *
 * Ref: CR-2026-026
 * @module routes/qms/evidence
 */

import { Model } from '../../models/_model/_model';
import { getRootUrl } from '../../helpers/url/url';
import { apiLimiter } from '../../helpers/limiter/limiter';

const VALID_EVIDENCE_TYPES = [
  'justification',
  'qualification',
  'coi_declaration',
  'review_comment',
  'self_review_checklist',
  'approval_justification',
  'change_classification',
  'rejection_feedback',
];

export default [
  // =========================================================================
  // GET all evidence for a document
  // =========================================================================
  {
    op: 'get',
    view: '/@qms/evidence',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getQmsEvidence',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { document_id } = req.query;

      if (!document_id) {
        return {
          status: 400,
          json: { error: 'document_id query parameter required' },
        };
      }

      const result = await knex
        .raw(
          `SELECT de.id, de.document_id, de.transition_id, de.evidence_type,
                  de.evidence_data, de.evidence_text, de.recorded_by,
                  de.recorded_at, de.is_superseded, de.superseded_by,
                  ret.label AS evidence_type_label, ret.phase, ret.required
           FROM qms.document_evidence de
           JOIN qms.ref_evidence_types ret ON ret.code = de.evidence_type
           WHERE de.document_id = ?
           ORDER BY de.recorded_at DESC`,
          [document_id],
        )
        .transacting(trx);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/evidence?document_id=${encodeURIComponent(document_id)}`,
          items: result.rows,
          items_total: result.rows.length,
        },
      };
    },
  },

  // =========================================================================
  // GET evidence completeness summary for a document
  // =========================================================================
  {
    op: 'get',
    view: '/@qms/evidence/summary',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getQmsEvidenceSummary',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { document_id } = req.query;

      if (!document_id) {
        return {
          status: 400,
          json: { error: 'document_id query parameter required' },
        };
      }

      const result = await knex
        .raw(
          `SELECT evidence_type, phase, required, label, captured,
                  evidence_id, recorded_by, recorded_at, evidence_text
           FROM qms.document_evidence_summary
           WHERE document_id = ?
           ORDER BY phase, evidence_type`,
          [document_id],
        )
        .transacting(trx);

      const required_total = result.rows.filter((r) => r.required).length;
      const required_captured = result.rows.filter(
        (r) => r.required && r.captured,
      ).length;

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/evidence/summary?document_id=${encodeURIComponent(document_id)}`,
          document_id,
          items: result.rows,
          required_total,
          required_captured,
          complete: required_captured === required_total,
        },
      };
    },
  },

  // =========================================================================
  // POST record standalone evidence (not tied to a draft action)
  // =========================================================================
  {
    op: 'post',
    view: '/@qms/evidence',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'postQmsEvidence',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const {
        document_id,
        transition_id,
        evidence_type,
        evidence_data,
        evidence_text,
      } = req.body;

      if (!document_id || !evidence_type || !evidence_data) {
        return {
          status: 400,
          json: {
            error:
              'Required fields: document_id, evidence_type, evidence_data',
          },
        };
      }

      if (!VALID_EVIDENCE_TYPES.includes(evidence_type)) {
        return {
          status: 400,
          json: {
            error: `Invalid evidence_type. Valid types: ${VALID_EVIDENCE_TYPES.join(', ')}`,
          },
        };
      }

      // Verify document exists
      const docCheck = await knex
        .raw(
          'SELECT document_id FROM qms.controlled_documents WHERE document_id = ?',
          [document_id],
        )
        .transacting(trx);

      if (docCheck.rows.length === 0) {
        return { status: 404, json: { error: 'Document not found' } };
      }

      // Verify transition exists if provided
      if (transition_id) {
        const transCheck = await knex
          .raw(
            'SELECT id FROM qms.document_transitions WHERE id = ? AND document_id = ?',
            [transition_id, document_id],
          )
          .transacting(trx);

        if (transCheck.rows.length === 0) {
          return {
            status: 404,
            json: { error: 'Transition not found for this document' },
          };
        }
      }

      const recorded_by = req.user?.id || 'unknown';

      const result = await knex
        .raw(
          `INSERT INTO qms.document_evidence
             (document_id, transition_id, evidence_type, evidence_data,
              evidence_text, recorded_by)
           VALUES (?, ?, ?, ?::jsonb, ?, ?)
           RETURNING id, document_id, transition_id, evidence_type,
                    evidence_data, evidence_text, recorded_by, recorded_at,
                    is_superseded, superseded_by`,
          [
            document_id,
            transition_id || null,
            evidence_type,
            JSON.stringify(evidence_data),
            evidence_text || null,
            recorded_by,
          ],
        )
        .transacting(trx);

      return {
        status: 201,
        json: {
          '@id': `${getRootUrl(req)}/@qms/evidence`,
          ...result.rows[0],
        },
      };
    },
  },
];
