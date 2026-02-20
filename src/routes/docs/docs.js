/**
 * Knowledge base document routes.
 *
 * Platform-level documentation endpoints serving the LJUSA TIDER knowledge base.
 * Documents are synced from git to PostgreSQL (i18n.docs) with full-text search.
 *
 * Ref: docs/PLATFORM_VISION.md — "Database as Content" pattern, Principle 8
 * Ref: docs/deployments/DR-2026-002_documentation_platform.md
 *
 * @module routes/docs/docs
 */

import { Model } from '../../models/_model/_model';
import { getRootUrl } from '../../helpers/url/url';

/**
 * Parse a semver string and apply a bump type.
 * @param {string} version - Current version (e.g., "1.0.0")
 * @param {string} bump - One of "patch", "minor", "major"
 * @returns {string} New version string
 */
function bumpVersion(version, bump) {
  const parts = version.split('.').map(Number);
  // Normalize to 3 parts
  while (parts.length < 3) parts.push(0);
  const [major, minor, patch] = parts;
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Invalid bump type: ${bump}`);
  }
}

export default [
  // Document list with category filtering and search
  {
    op: 'get',
    view: '/@docs',
    permission: 'View',
    client: 'getDocs',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const {
        category,
        subcategory,
        search,
        page = 1,
        page_size = 50,
      } = req.query;

      const offset =
        (Math.max(1, parseInt(page, 10)) - 1) *
        Math.min(100, Math.max(1, parseInt(page_size, 10)));
      const limit = Math.min(100, Math.max(1, parseInt(page_size, 10)));

      // Build categories list
      const categories = await knex
        .raw('SELECT * FROM i18n.doc_categories')
        .transacting(trx);

      // Build item query with filters
      const conditions = [];
      const params = [];

      if (category) {
        conditions.push('d.category = ?');
        params.push(category);
      }
      if (subcategory) {
        conditions.push('d.subcategory = ?');
        params.push(subcategory);
      }
      if (search) {
        conditions.push("d.body_tsv @@ plainto_tsquery('english', ?)");
        params.push(search);
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await knex
        .raw(`SELECT COUNT(*) FROM i18n.docs d ${where}`, params)
        .transacting(trx);

      // If searching, order by relevance; otherwise by title
      let orderClause = 'ORDER BY d.title';
      if (search) {
        orderClause =
          "ORDER BY ts_rank(d.body_tsv, plainto_tsquery('english', ?)) DESC, d.title";
        params.push(search);
      }

      const result = await knex
        .raw(
          `SELECT d.id, d.slug, d.title, d.category, d.subcategory,
                  d.status, d.doc_date, d.author, d.version,
                  d.file_size, d.git_hash, d.git_author, d.git_date,
                  d.synced_at, d.updated_at
           FROM i18n.docs d
           ${where}
           ${orderClause}
           LIMIT ? OFFSET ?`,
          [...params, limit, offset],
        )
        .transacting(trx);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@docs`,
          categories: categories.rows,
          items: result.rows,
          items_total: parseInt(countResult.rows[0].count, 10),
          page: parseInt(page, 10),
          page_size: limit,
        },
      };
    },
  },

  // Full-text search with ranked snippets
  {
    op: 'get',
    view: '/@docs/search',
    permission: 'View',
    client: 'getDocsSearch',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { q, page = 1, page_size = 20 } = req.query;

      if (!q || q.length < 2) {
        return {
          json: {
            '@id': `${getRootUrl(req)}/@docs/search`,
            items: [],
            items_total: 0,
            query: q || '',
          },
        };
      }

      const offset =
        (Math.max(1, parseInt(page, 10)) - 1) *
        Math.min(50, Math.max(1, parseInt(page_size, 10)));
      const limit = Math.min(50, Math.max(1, parseInt(page_size, 10)));

      const countResult = await knex
        .raw(
          `SELECT COUNT(*)
           FROM i18n.docs d
           WHERE d.body_tsv @@ plainto_tsquery('english', ?)`,
          [q],
        )
        .transacting(trx);

      const result = await knex
        .raw(
          `SELECT d.id, d.slug, d.title, d.category, d.subcategory,
                  d.status, d.doc_date, d.author,
                  ts_rank(d.body_tsv, plainto_tsquery('english', ?)) AS rank,
                  ts_headline('english', d.body_md, plainto_tsquery('english', ?),
                    'StartSel=<mark>, StopSel=</mark>, MaxWords=60, MinWords=20, MaxFragments=3'
                  ) AS snippet
           FROM i18n.docs d
           WHERE d.body_tsv @@ plainto_tsquery('english', ?)
           ORDER BY rank DESC, d.title
           LIMIT ? OFFSET ?`,
          [q, q, q, limit, offset],
        )
        .transacting(trx);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@docs/search`,
          items: result.rows,
          items_total: parseInt(countResult.rows[0].count, 10),
          query: q,
          page: parseInt(page, 10),
          page_size: limit,
        },
      };
    },
  },

  // Single document by slug
  {
    op: 'get',
    view: '/@docs/view',
    permission: 'View',
    client: 'getDoc',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const slug = req.query.slug;

      if (!slug) {
        return { status: 400, json: { error: 'Document slug required' } };
      }

      const result = await knex
        .raw('SELECT * FROM i18n.docs WHERE slug = ?', [slug])
        .transacting(trx);

      if (result.rows.length === 0) {
        return { status: 404, json: { error: 'Document not found' } };
      }

      const doc = result.rows[0];
      return {
        json: {
          '@id': `${getRootUrl(req)}/@docs/view?slug=${encodeURIComponent(slug)}`,
          ...doc,
          body_tsv: undefined, // Don't send tsvector to client
        },
      };
    },
  },

  // Save document with version bump — ARCH-2026-007 Priority 1
  {
    op: 'post',
    view: '/@docs/save',
    permission: 'Modify portal content',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { doc_id, body_md, version_bump, change_summary } = req.body;

      // Validate required fields
      if (!doc_id || !body_md || !version_bump || !change_summary) {
        return {
          status: 400,
          json: {
            error:
              'Missing required fields: doc_id, body_md, version_bump, change_summary',
          },
        };
      }

      if (!['patch', 'minor', 'major'].includes(version_bump)) {
        return {
          status: 400,
          json: {
            error:
              'Invalid version_bump: must be "patch", "minor", or "major"',
          },
        };
      }

      // Fetch current document
      const docResult = await knex
        .raw('SELECT * FROM i18n.docs WHERE id = ?', [doc_id])
        .transacting(trx);

      if (docResult.rows.length === 0) {
        return { status: 404, json: { error: 'Document not found' } };
      }

      const doc = docResult.rows[0];

      if (!doc.version) {
        return {
          status: 400,
          json: {
            error: 'Document has no current version — cannot bump null',
          },
        };
      }

      // Calculate new version
      const newVersion = bumpVersion(doc.version, version_bump);
      const username = req.user.id;

      // Update frontmatter JSONB with new version
      const updatedFrontmatter = { ...(doc.frontmatter || {}), version: newVersion };

      // Step 5: UPDATE i18n.docs — triggers fire automatically:
      //   trg_audit_docs → creates docs_audit record
      //   trg_auto_version_snapshot → creates doc_versions record (version changed)
      await knex
        .raw(
          `UPDATE i18n.docs
           SET body_md = ?,
               version = ?,
               frontmatter = ?::jsonb,
               is_edited = true,
               edited_by = ?,
               updated_at = now()
           WHERE id = ?`,
          [body_md, newVersion, JSON.stringify(updatedFrontmatter), username, doc_id],
        )
        .transacting(trx);

      // Step 6: Fill in change_summary on the just-created doc_versions record
      await knex
        .raw(
          `UPDATE i18n.doc_versions
           SET changes = ?
           WHERE doc_id = ? AND version = ?
             AND changes IS NULL`,
          [change_summary, doc_id, newVersion],
        )
        .transacting(trx);

      // Step 7-8: Check QMS registration and sync version
      const qmsResult = await knex
        .raw(
          'SELECT document_id FROM qms.controlled_documents WHERE docs_id = ?',
          [doc_id],
        )
        .transacting(trx);

      const qmsDocumentId =
        qmsResult.rows.length > 0 ? qmsResult.rows[0].document_id : null;

      if (qmsDocumentId) {
        await knex
          .raw(
            'UPDATE qms.controlled_documents SET version = ? WHERE docs_id = ?',
            [newVersion, doc_id],
          )
          .transacting(trx);

        // Step 9: Insert document_transitions record
        await knex
          .raw(
            `INSERT INTO qms.document_transitions
               (document_id, action, from_version, to_version, performed_by, comment)
             VALUES (?, 'content_update', ?, ?, ?, ?)`,
            [qmsDocumentId, doc.version, newVersion, username, change_summary],
          )
          .transacting(trx);
      }

      // Return updated document
      const updated = await knex
        .raw('SELECT * FROM i18n.docs WHERE id = ?', [doc_id])
        .transacting(trx);

      const updatedDoc = updated.rows[0];
      return {
        json: {
          '@id': `${getRootUrl(req)}/@docs/save`,
          ...updatedDoc,
          body_tsv: undefined,
          qms_synced: !!qmsDocumentId,
        },
      };
    },
  },
];
