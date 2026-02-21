/**
 * QMS Training Module routes.
 *
 * Performance-based training: users prove competence by executing the real
 * document lifecycle (SOP-DC-001) on a sandboxed training document.
 * Server-side validators check actual database state — no quizzes.
 *
 * Read endpoints require 'Access Developer Tools'.
 * Write endpoints require 'Manage Documents'.
 *
 * Ref: CR-2026-027
 * @module routes/qms/training
 */

import { Model } from '../../models/_model/_model';
import { getRootUrl } from '../../helpers/url/url';
import { apiLimiter } from '../../helpers/limiter/limiter';

// =========================================================================
// Validators: check real database state for each training step
// =========================================================================
const validators = {
  /**
   * Step 1: A draft exists for the training document.
   */
  async draft_exists(knex, trx, { docsId }) {
    const result = await knex
      .raw(
        `SELECT id, version, title, body_md, status
         FROM i18n.doc_drafts WHERE doc_id = ?`,
        [docsId],
      )
      .transacting(trx);

    if (result.rows.length === 0) {
      return { ok: false, message: 'No draft found. Open the document editor, write content, and save.' };
    }

    const draft = result.rows[0];
    if (!draft.body_md || draft.body_md.trim().length < 20) {
      return { ok: false, message: 'Draft content is too short. Write at least a paragraph of meaningful content.' };
    }

    return { ok: true, data: { draft_id: draft.id, version: draft.version, status: draft.status } };
  },

  /**
   * Step 2: Justification evidence recorded for the training document.
   */
  async evidence_justification(knex, trx, { qmsDocId }) {
    const result = await knex
      .raw(
        `SELECT id, evidence_data, recorded_at
         FROM qms.document_evidence
         WHERE document_id = ? AND evidence_type = 'justification'
           AND NOT is_superseded
         ORDER BY recorded_at DESC LIMIT 1`,
        [qmsDocId],
      )
      .transacting(trx);

    if (result.rows.length === 0) {
      return { ok: false, message: 'No justification evidence found. Save the draft again with a justification (what, why, and scope).' };
    }

    return { ok: true, data: { evidence_id: result.rows[0].id, recorded_at: result.rows[0].recorded_at } };
  },

  /**
   * Step 3: Draft has been submitted for review (status = in_review).
   */
  async draft_in_review(knex, trx, { docsId }) {
    const result = await knex
      .raw(
        `SELECT id, status FROM i18n.doc_drafts WHERE doc_id = ?`,
        [docsId],
      )
      .transacting(trx);

    if (result.rows.length === 0) {
      return { ok: false, message: 'No draft found. The draft may have already been approved.' };
    }

    if (result.rows[0].status !== 'in_review') {
      return { ok: false, message: `Draft status is '${result.rows[0].status}', expected 'in_review'. Submit the draft for review.` };
    }

    return { ok: true, data: { draft_id: result.rows[0].id, status: 'in_review' } };
  },

  /**
   * Step 4: Both COI declaration and qualification evidence exist.
   */
  async evidence_coi_qualification(knex, trx, { qmsDocId }) {
    const result = await knex
      .raw(
        `SELECT evidence_type, id, recorded_at
         FROM qms.document_evidence
         WHERE document_id = ?
           AND evidence_type IN ('coi_declaration', 'qualification')
           AND NOT is_superseded`,
        [qmsDocId],
      )
      .transacting(trx);

    const types = result.rows.map((r) => r.evidence_type);
    const missing = [];
    if (!types.includes('coi_declaration')) missing.push('COI declaration');
    if (!types.includes('qualification')) missing.push('qualification');

    if (missing.length > 0) {
      return { ok: false, message: `Missing evidence: ${missing.join(', ')}. Submit the draft with all required fields.` };
    }

    return { ok: true, data: { evidence_count: result.rows.length } };
  },

  /**
   * Step 5: Self-review checklist evidence exists.
   */
  async evidence_checklist(knex, trx, { qmsDocId }) {
    const result = await knex
      .raw(
        `SELECT id, evidence_data, recorded_at
         FROM qms.document_evidence
         WHERE document_id = ? AND evidence_type = 'self_review_checklist'
           AND NOT is_superseded
         ORDER BY recorded_at DESC LIMIT 1`,
        [qmsDocId],
      )
      .transacting(trx);

    if (result.rows.length === 0) {
      return { ok: false, message: 'No self-review checklist evidence found. Complete the FRM-DC-004 checklist and approve the document.' };
    }

    return { ok: true, data: { evidence_id: result.rows[0].id, recorded_at: result.rows[0].recorded_at } };
  },

  /**
   * Step 6: Document has reached effective status in the QMS register.
   */
  async document_effective(knex, trx, { qmsDocId }) {
    const result = await knex
      .raw(
        `SELECT status, version, effective_date
         FROM qms.controlled_documents WHERE document_id = ?`,
        [qmsDocId],
      )
      .transacting(trx);

    if (result.rows.length === 0) {
      return { ok: false, message: 'Training document not found in QMS register.' };
    }

    if (result.rows[0].status !== 'effective') {
      return { ok: false, message: `Document status is '${result.rows[0].status}', expected 'effective'. Complete the approval step.` };
    }

    return {
      ok: true,
      data: {
        status: 'effective',
        version: result.rows[0].version,
        effective_date: result.rows[0].effective_date,
      },
    };
  },
};

export default [
  // =========================================================================
  // GET active training modules
  // =========================================================================
  {
    op: 'get',
    view: '/@qms/training/modules',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getTrainingModules',
    handler: async (req, trx) => {
      const knex = Model.knex();

      const result = await knex
        .raw(
          `SELECT id, module_code, title, description, sop_reference,
                  grants_roles, steps, active
           FROM qms.training_modules
           WHERE active = true
           ORDER BY module_code`,
        )
        .transacting(trx);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/training/modules`,
          items: result.rows,
          items_total: result.rows.length,
        },
      };
    },
  },

  // =========================================================================
  // GET user's session for a module
  // =========================================================================
  {
    op: 'get',
    view: '/@qms/training/session',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getTrainingSession',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const userId = req.user?.id;
      const { module_code } = req.query;

      if (!module_code) {
        // Return all sessions for this user
        const result = await knex
          .raw(
            `SELECT session_id, user_id, training_doc_id, current_step,
                    session_status, started_at, completed_at, certificate_id,
                    module_id, module_code, module_title, module_description,
                    sop_reference, module_steps, grants_roles, cert_id,
                    cert_fullname, cert_issued_at, cert_qualified_for,
                    completed_steps
             FROM qms.training_session_detail
             WHERE user_id = ?
             ORDER BY started_at DESC`,
            [userId],
          )
          .transacting(trx);

        return {
          json: {
            '@id': `${getRootUrl(req)}/@qms/training/session`,
            items: result.rows,
            items_total: result.rows.length,
          },
        };
      }

      // Return active session for this module, or most recent completed
      const result = await knex
        .raw(
          `SELECT session_id, user_id, training_doc_id, current_step,
                  session_status, started_at, completed_at, certificate_id,
                  module_id, module_code, module_title, module_description,
                  sop_reference, module_steps, grants_roles, cert_id,
                  cert_fullname, cert_issued_at, cert_qualified_for,
                  completed_steps
           FROM qms.training_session_detail
           WHERE user_id = ? AND module_code = ?
           ORDER BY
             CASE WHEN session_status = 'in_progress' THEN 0 ELSE 1 END,
             started_at DESC
           LIMIT 1`,
          [userId, module_code],
        )
        .transacting(trx);

      if (result.rows.length === 0) {
        return {
          json: {
            '@id': `${getRootUrl(req)}/@qms/training/session?module_code=${encodeURIComponent(module_code)}`,
            session: null,
          },
        };
      }

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/training/session?module_code=${encodeURIComponent(module_code)}`,
          ...result.rows[0],
        },
      };
    },
  },

  // =========================================================================
  // POST start a new training session
  // =========================================================================
  {
    op: 'post',
    view: '/@qms/training/session/start',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'postTrainingStart',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const userId = req.user?.id || 'unknown';
      const { module_code } = req.body;

      if (!module_code) {
        return { status: 400, json: { error: 'module_code is required' } };
      }

      // Fetch the module
      const moduleResult = await knex
        .raw(
          `SELECT id, module_code, title, description, sop_reference, steps,
                  grants_roles, active
           FROM qms.training_modules WHERE module_code = ? AND active = true`,
          [module_code],
        )
        .transacting(trx);

      if (moduleResult.rows.length === 0) {
        return { status: 404, json: { error: 'Training module not found or inactive' } };
      }

      const mod = moduleResult.rows[0];

      // Check for existing in-progress session
      const existingSession = await knex
        .raw(
          `SELECT id FROM qms.training_sessions
           WHERE user_id = ? AND module_id = ? AND status = 'in_progress'`,
          [userId, mod.id],
        )
        .transacting(trx);

      if (existingSession.rows.length > 0) {
        return {
          status: 409,
          json: {
            error: 'You already have an in-progress session for this module',
            session_id: existingSession.rows[0].id,
          },
        };
      }

      // Generate training document ID: TST-TRN-{user}-{YYYYMMDD}
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      let docId = `TST-TRN-${userId}-${dateStr}`;

      // Check for collision, add suffix if needed
      const collision = await knex
        .raw(
          `SELECT COUNT(*)::int AS count FROM i18n.docs
           WHERE slug LIKE ?`,
          [`training/${docId}%`],
        )
        .transacting(trx);

      if (collision.rows[0].count > 0) {
        docId = `${docId}-${collision.rows[0].count + 1}`;
      }

      const slug = `training/${docId}`;
      const filePath = `training/${docId}.md`;
      const title = `Training Document: ${docId}`;
      const bodyMd = [
        `# ${title}`,
        '',
        `**Module:** ${mod.title}`,
        `**SOP Reference:** ${mod.sop_reference}`,
        `**Trainee:** ${userId}`,
        `**Created:** ${new Date().toISOString().slice(0, 10)}`,
        '',
        '---',
        '',
        '## Purpose',
        '',
        'This is a training document created as part of the QMS competence certification process. ',
        'Edit this document to demonstrate your ability to use the document control system.',
        '',
        '## Content',
        '',
        '*Replace this section with your own content during training.*',
        '',
      ].join('\n');

      // 1. Insert into i18n.docs
      const docsResult = await knex
        .raw(
          `INSERT INTO i18n.docs
             (slug, file_path, title, category, subcategory, status,
              author, version, body_md, content_type, source_dir, project)
           VALUES (?, ?, ?, 'training', 'competence', 'draft',
                   ?, '0.1', ?, 'document', 'training', 'polyglot')
           RETURNING id`,
          [slug, filePath, title, userId, bodyMd],
        )
        .transacting(trx);

      const docsId = docsResult.rows[0].id;

      // 2. Insert into qms.controlled_documents
      await knex
        .raw(
          `INSERT INTO qms.controlled_documents
             (document_id, title, document_type, domain_code, version, status,
              classification, owner, author, docs_id, body_md, notes)
           VALUES (?, ?, 'REC', 'HR', '0.1', 'draft', 'internal',
                   ?, ?, ?, ?, ?)`,
          [
            docId,
            title,
            userId,
            userId,
            docsId,
            bodyMd,
            `Training document for module ${mod.module_code}`,
          ],
        )
        .transacting(trx);

      // 3. Record create transition
      await knex
        .raw(
          `INSERT INTO qms.document_transitions
             (document_id, action, to_status, to_version, performed_by, comment)
           VALUES (?, 'create', 'draft', '0.1', ?, ?)`,
          [docId, userId, `Training session started for ${mod.module_code}`],
        )
        .transacting(trx);

      // 4. Create training session
      const sessionResult = await knex
        .raw(
          `INSERT INTO qms.training_sessions
             (user_id, module_id, training_doc_id, current_step, status)
           VALUES (?, ?, ?, 1, 'in_progress')
           RETURNING id`,
          [userId, mod.id, docId],
        )
        .transacting(trx);

      const sessionId = sessionResult.rows[0].id;

      // 5. Return full session detail
      const detail = await knex
        .raw(
          `SELECT session_id, user_id, training_doc_id, current_step,
                  session_status, started_at, completed_at, certificate_id,
                  module_id, module_code, module_title, module_description,
                  sop_reference, module_steps, grants_roles, cert_id,
                  cert_fullname, cert_issued_at, cert_qualified_for,
                  completed_steps
           FROM qms.training_session_detail WHERE session_id = ?`,
          [sessionId],
        )
        .transacting(trx);

      return {
        status: 201,
        json: {
          '@id': `${getRootUrl(req)}/@qms/training/session?module_code=${encodeURIComponent(module_code)}`,
          ...detail.rows[0],
          training_doc_slug: slug,
        },
      };
    },
  },

  // =========================================================================
  // POST validate and record a step completion
  // =========================================================================
  {
    op: 'post',
    view: '/@qms/training/session/validate-step',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'postTrainingValidateStep',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const userId = req.user?.id || 'unknown';
      const { session_id, step_number } = req.body;

      if (!session_id || step_number === undefined) {
        return {
          status: 400,
          json: { error: 'session_id and step_number are required' },
        };
      }

      // Fetch session with module info
      const sessionResult = await knex
        .raw(
          `SELECT ts.id, ts.user_id, ts.module_id, ts.training_doc_id,
                  ts.current_step, ts.status, ts.started_at, ts.completed_at,
                  ts.certificate_id,
                  tm.steps AS module_steps, tm.grants_roles,
                  tm.module_code, tm.title AS module_title
           FROM qms.training_sessions ts
           JOIN qms.training_modules tm ON tm.id = ts.module_id
           WHERE ts.id = ?`,
          [session_id],
        )
        .transacting(trx);

      if (sessionResult.rows.length === 0) {
        return { status: 404, json: { error: 'Training session not found' } };
      }

      const session = sessionResult.rows[0];

      // Verify session belongs to user
      if (session.user_id !== userId) {
        return { status: 403, json: { error: 'This session belongs to another user' } };
      }

      // Verify session is still in progress
      if (session.status !== 'in_progress') {
        return {
          status: 409,
          json: { error: `Session is '${session.status}', cannot validate steps` },
        };
      }

      // Verify step_number matches current_step
      if (step_number !== session.current_step) {
        return {
          status: 409,
          json: {
            error: `Expected step ${session.current_step}, got step ${step_number}. Complete steps in order.`,
          },
        };
      }

      // Find the step definition
      const steps = session.module_steps;
      const stepDef = steps.find((s) => s.step === step_number);
      if (!stepDef) {
        return { status: 400, json: { error: `Step ${step_number} not defined in module` } };
      }

      // Resolve the training document's i18n.docs.id and QMS document_id
      const docLookup = await knex
        .raw(
          `SELECT d.id AS docs_id, cd.document_id AS qms_doc_id
           FROM qms.controlled_documents cd
           JOIN i18n.docs d ON d.id = cd.docs_id
           WHERE cd.document_id = ?`,
          [session.training_doc_id],
        )
        .transacting(trx);

      if (docLookup.rows.length === 0) {
        return { status: 500, json: { error: 'Training document not found in database' } };
      }

      const { docs_id: docsId, qms_doc_id: qmsDocId } = docLookup.rows[0];

      // Run the validator
      const validatorFn = validators[stepDef.validation];
      if (!validatorFn) {
        return { status: 500, json: { error: `Unknown validator: ${stepDef.validation}` } };
      }

      const validationResult = await validatorFn(knex, trx, { docsId, qmsDocId });

      if (!validationResult.ok) {
        return {
          json: {
            '@id': `${getRootUrl(req)}/@qms/training/session/validate-step`,
            ok: false,
            step_number,
            step_key: stepDef.key,
            message: validationResult.message,
          },
        };
      }

      // Step passed — record completion
      await knex
        .raw(
          `INSERT INTO qms.training_step_completions
             (session_id, step_number, step_key, validated_by, validation_data)
           VALUES (?, ?, ?, ?, ?::jsonb)
           ON CONFLICT (session_id, step_number) DO NOTHING`,
          [
            session_id,
            step_number,
            stepDef.key,
            userId,
            JSON.stringify(validationResult.data || {}),
          ],
        )
        .transacting(trx);

      const totalSteps = steps.length;
      const isLastStep = step_number === totalSteps;

      if (isLastStep) {
        // --- Completion flow ---

        // 1. Look up user fullname
        const userResult = await knex
          .raw('SELECT fullname FROM "user" WHERE id = ?', [userId])
          .transacting(trx);
        const fullname = userResult.rows.length > 0
          ? userResult.rows[0].fullname
          : userId;

        // 2. Issue certificate
        const certResult = await knex
          .raw(
            `INSERT INTO qms.training_certificates
               (session_id, user_id, user_fullname, module_code, module_title, qualified_for)
             VALUES (?, ?, ?, ?, ?, ?)
             RETURNING certificate_id`,
            [
              session_id,
              userId,
              fullname,
              session.module_code,
              session.module_title,
              session.grants_roles,
            ],
          )
          .transacting(trx);

        const certificateId = certResult.rows[0].certificate_id;

        // 3. Update session to completed
        await knex
          .raw(
            `UPDATE qms.training_sessions
             SET status = 'completed',
                 current_step = ? + 1,
                 completed_at = now(),
                 certificate_id = ?
             WHERE id = ?`,
            [step_number, certificateId, session_id],
          )
          .transacting(trx);

        // 4. Grant roles via upsert
        for (const roleCode of session.grants_roles || []) {
          await knex
            .raw(
              `INSERT INTO qms.user_roles (user_id, role_code, granted_by)
               VALUES (?, ?, ?)
               ON CONFLICT (user_id, role_code) DO UPDATE SET
                 active = true, granted_by = EXCLUDED.granted_by, granted_at = now()`,
              [userId, roleCode, 'training-system'],
            )
            .transacting(trx);
        }

        return {
          json: {
            '@id': `${getRootUrl(req)}/@qms/training/session/validate-step`,
            ok: true,
            step_number,
            step_key: stepDef.key,
            completed: true,
            certificate_id: certificateId,
            message: 'Congratulations! All steps completed. Certificate issued.',
          },
        };
      }

      // Not the last step — advance
      await knex
        .raw(
          'UPDATE qms.training_sessions SET current_step = ? WHERE id = ?',
          [step_number + 1, session_id],
        )
        .transacting(trx);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/training/session/validate-step`,
          ok: true,
          step_number,
          step_key: stepDef.key,
          completed: false,
          current_step: step_number + 1,
          message: `Step ${step_number} validated. Proceed to step ${step_number + 1}.`,
        },
      };
    },
  },

  // =========================================================================
  // POST abandon a training session
  // =========================================================================
  {
    op: 'post',
    view: '/@qms/training/session/abandon',
    permission: 'Manage Documents',
    middleware: apiLimiter,
    client: 'postTrainingAbandon',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const userId = req.user?.id || 'unknown';
      const { session_id } = req.body;

      if (!session_id) {
        return { status: 400, json: { error: 'session_id is required' } };
      }

      // Fetch session
      const sessionResult = await knex
        .raw(
          `SELECT id, user_id, module_id, training_doc_id, current_step,
                  status, started_at, completed_at, certificate_id
           FROM qms.training_sessions WHERE id = ?`,
          [session_id],
        )
        .transacting(trx);

      if (sessionResult.rows.length === 0) {
        return { status: 404, json: { error: 'Training session not found' } };
      }

      const session = sessionResult.rows[0];

      if (session.user_id !== userId) {
        return { status: 403, json: { error: 'This session belongs to another user' } };
      }

      if (session.status !== 'in_progress') {
        return {
          status: 409,
          json: { error: `Session is already '${session.status}'` },
        };
      }

      // Mark session abandoned
      await knex
        .raw(
          `UPDATE qms.training_sessions
           SET status = 'abandoned', completed_at = now()
           WHERE id = ?`,
          [session_id],
        )
        .transacting(trx);

      // Obsolete the training document in QMS register
      if (session.training_doc_id) {
        await knex
          .raw(
            `UPDATE qms.controlled_documents
             SET status = 'obsolete', updated_at = now()
             WHERE document_id = ?`,
            [session.training_doc_id],
          )
          .transacting(trx);

        await knex
          .raw(
            `INSERT INTO qms.document_transitions
               (document_id, action, to_status, performed_by, comment)
             VALUES (?, 'obsolete', 'obsolete', ?, 'Training session abandoned')`,
            [session.training_doc_id, userId],
          )
          .transacting(trx);
      }

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/training/session/abandon`,
          message: 'Training session abandoned',
          session_id,
        },
      };
    },
  },

  // =========================================================================
  // GET certificate data
  // =========================================================================
  {
    op: 'get',
    view: '/@qms/training/certificate',
    permission: 'Access Developer Tools',
    middleware: apiLimiter,
    client: 'getTrainingCertificate',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { certificate_id } = req.query;

      if (!certificate_id) {
        return { status: 400, json: { error: 'certificate_id query parameter required' } };
      }

      const result = await knex
        .raw(
          `SELECT tc.id, tc.certificate_id, tc.session_id, tc.user_id,
                  tc.user_fullname, tc.module_code, tc.module_title,
                  tc.issued_at, tc.qualified_for,
                  tm.sop_reference, tm.description AS module_description
           FROM qms.training_certificates tc
           JOIN qms.training_sessions ts ON ts.id = tc.session_id
           JOIN qms.training_modules tm ON tm.id = ts.module_id
           WHERE tc.certificate_id = ?`,
          [certificate_id],
        )
        .transacting(trx);

      if (result.rows.length === 0) {
        return { status: 404, json: { error: 'Certificate not found' } };
      }

      return {
        json: {
          '@id': `${getRootUrl(req)}/@qms/training/certificate?certificate_id=${encodeURIComponent(certificate_id)}`,
          ...result.rows[0],
        },
      };
    },
  },
];
