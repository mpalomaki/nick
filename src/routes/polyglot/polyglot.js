/**
 * Polyglot translation routes.
 * @module routes/polyglot/polyglot
 */

import { Model } from '../../models/_model/_model';
import { getRootUrl } from '../../helpers/url/url';

export default [
  // Coverage dashboard
  {
    op: 'get',
    view: '/@polyglot/coverage',
    permission: 'View',
    client: 'getPolyglotCoverage',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const result = await knex
        .raw(
          'SELECT * FROM i18n.translation_coverage ORDER BY language, platform',
        )
        .transacting(trx);
      return {
        json: {
          '@id': `${getRootUrl(req)}/@polyglot/coverage`,
          items: result.rows,
        },
      };
    },
  },

  // Language detail
  {
    op: 'get',
    view: '/@polyglot/languages/:code',
    permission: 'View',
    client: 'getPolyglotLanguage',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { code } = req.params;

      const [coverage, conventions, risk] = await Promise.all([
        knex
          .raw(
            'SELECT * FROM i18n.translation_coverage WHERE language = ? ORDER BY platform',
            [code],
          )
          .transacting(trx),
        knex
          .raw(
            'SELECT * FROM i18n.language_conventions WHERE language_code = ?',
            [code],
          )
          .transacting(trx),
        knex
          .raw('SELECT * FROM i18n.risk_summary WHERE language = ?', [code])
          .transacting(trx),
      ]);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@polyglot/languages/${code}`,
          language: code,
          coverage: coverage.rows,
          conventions: conventions.rows[0] || null,
          risk: risk.rows,
        },
      };
    },
  },

  // Translation browser
  {
    op: 'get',
    view: '/@polyglot/translations',
    permission: 'View',
    client: 'getPolyglotTranslations',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const {
        language,
        platform,
        search,
        page = 1,
        page_size = 50,
        filter,
      } = req.query;

      const offset =
        (Math.max(1, parseInt(page, 10)) - 1) *
        Math.min(200, Math.max(1, parseInt(page_size, 10)));
      const limit = Math.min(200, Math.max(1, parseInt(page_size, 10)));

      const conditions = [];
      const params = [];

      if (platform) {
        conditions.push('cm.platform = ?');
        params.push(platform);
      }
      if (language) {
        conditions.push('t.language = ?');
        params.push(language);
      }
      if (search) {
        conditions.push('(cm.english_source ILIKE ? OR t.msgstr ILIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      if (filter === 'missing') {
        conditions.push("(t.msgstr = '' OR t.msgstr = cm.english_source)");
      } else if (filter === 'translated') {
        conditions.push("t.msgstr != '' AND t.msgstr != cm.english_source");
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await knex
        .raw(
          `SELECT COUNT(*)
           FROM i18n.canonical_messages cm
           LEFT JOIN i18n.translations t ON t.message_id = cm.message_id
           ${where}`,
          params,
        )
        .transacting(trx);

      const result = await knex
        .raw(
          `SELECT cm.message_id, cm.english_source, cm.platform, cm.domain,
                  cm.msgctxt, t.msgstr, t.language, t.translation_source,
                  t.review_state
           FROM i18n.canonical_messages cm
           LEFT JOIN i18n.translations t ON t.message_id = cm.message_id
           ${where}
           ORDER BY cm.message_id
           LIMIT ? OFFSET ?`,
          [...params, limit, offset],
        )
        .transacting(trx);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@polyglot/translations`,
          items: result.rows,
          items_total: parseInt(countResult.rows[0].count, 10),
          page: parseInt(page, 10),
          page_size: limit,
        },
      };
    },
  },

  // Message detail
  {
    op: 'get',
    view: '/@polyglot/messages/:id',
    permission: 'View',
    client: 'getPolyglotMessage',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { id } = req.params;

      const [message, translations, preserved, terminology] =
        await Promise.all([
          knex
            .raw(
              'SELECT * FROM i18n.canonical_messages WHERE message_id = ?',
              [id],
            )
            .transacting(trx),
          knex
            .raw(
              `SELECT t.language, t.msgstr, t.translation_source, t.review_state,
                      lc.language_name_native
               FROM i18n.translations t
               LEFT JOIN i18n.language_conventions lc
                 ON lc.language_code = t.language
               WHERE t.message_id = ?
               ORDER BY t.language`,
              [id],
            )
            .transacting(trx),
          knex
            .raw(
              `SELECT pt.language_code, pt.term, pt.term_type, pt.context, pt.notes
               FROM i18n.preserved_terms pt
               WHERE pt.term IN (
                 SELECT cm.english_source
                 FROM i18n.canonical_messages cm
                 WHERE cm.message_id = ?
               )
               ORDER BY pt.language_code`,
              [id],
            )
            .transacting(trx),
          knex
            .raw(
              `SELECT t.english_term, t.language_code, t.translation, t.source,
                      t.reliability
               FROM i18n.terminology t
               WHERE t.english_term IN (
                 SELECT cm.english_source
                 FROM i18n.canonical_messages cm
                 WHERE cm.message_id = ?
               )
               ORDER BY t.language_code`,
              [id],
            )
            .transacting(trx),
        ]);

      return {
        json: {
          '@id': `${getRootUrl(req)}/@polyglot/messages/${id}`,
          message: message.rows[0] || null,
          translations: translations.rows,
          preserved_terms: preserved.rows,
          terminology: terminology.rows,
        },
      };
    },
  },

  // Glossary search
  {
    op: 'get',
    view: '/@polyglot/glossary',
    permission: 'View',
    client: 'getPolyglotGlossary',
    handler: async (req, trx) => {
      const knex = Model.knex();
      const { q, language, page = 1, page_size = 50 } = req.query;

      if (!q || q.length < 2) {
        return {
          json: {
            '@id': `${getRootUrl(req)}/@polyglot/glossary`,
            iate: [],
            microsoft: [],
            query: q || '',
            language: language || null,
          },
        };
      }

      const limit = Math.min(100, Math.max(1, parseInt(page_size, 10)));

      // Search IATE terminology
      const iateParams = [`%${q}%`];
      let iateLangClause = '';
      if (language) {
        iateLangClause = 'AND language_code = ?';
        iateParams.push(language);
      }
      iateParams.push(limit);

      const iate = await knex
        .raw(
          `SELECT english_term, language_code, translation, source, reliability
           FROM i18n.terminology
           WHERE english_term ILIKE ? ${iateLangClause}
           ORDER BY reliability DESC, english_term
           LIMIT ?`,
          iateParams,
        )
        .transacting(trx);

      // Search Microsoft glossary
      let microsoft = { rows: [] };
      try {
        const msParams = [];
        let msLangJoin = 'LEFT JOIN glossaries.translations gt ON gt.term_entry_id = te.id';
        if (language) {
          msLangJoin += ' AND gt.language_code = ?';
          msParams.push(language);
        }
        msParams.push(`%${q}%`, limit);

        microsoft = await knex
          .raw(
            `SELECT te.en_term, te.definition, te.part_of_speech,
                    gt.language_code, gt.term AS translation
             FROM glossaries.term_entries te
             ${msLangJoin}
             WHERE te.en_term ILIKE ?
             ORDER BY te.en_term
             LIMIT ?`,
            msParams,
          )
          .transacting(trx);
      } catch (e) {
        // glossaries schema may not be available
      }

      return {
        json: {
          '@id': `${getRootUrl(req)}/@polyglot/glossary`,
          iate: iate.rows,
          microsoft: microsoft.rows,
          query: q,
          language: language || null,
        },
      };
    },
  },
];
