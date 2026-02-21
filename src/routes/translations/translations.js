/**
 * Translations routes.
 * @module routes/translations/translations
 */

import { Document } from '../../models/document/document';
import { Controlpanel } from '../../models/controlpanel/controlpanel';
import { v4 as uuid } from 'uuid';

import { getUrl, getUrlByPath } from '../../helpers/url/url';

export const handler = async (req, trx) => {
  const documents = req.document.translation_group
    ? await Document.fetchAll(
        { translation_group: req.document.translation_group },
        {},
        trx,
      )
    : [];
  const controlpanel = await Controlpanel.fetchById('language', {}, trx);
  const settings = controlpanel.data;

  return {
    json: {
      '@id': `${getUrl(req)}/@translations`,
      items: documents.models.map((document) => ({
        '@id': getUrlByPath(req, document.path),
        language: document.language,
      })),
      root: Object.fromEntries(
        settings.available_languages.map((language) => [
          language,
          getUrlByPath(req, `/${language}`),
        ]),
      ),
    },
  };
};

export default [
  {
    op: 'get',
    view: '/@translations',
    permission: 'View',
    client: 'getTranslations',
    handler,
  },
  {
    op: 'delete',
    view: '/@translations',
    permission: 'Modify',
    client: 'unlinkTranslation',
    handler: async (req, trx) => {
      const document = await Document.fetchOne(
        {
          translation_group: req.document.translation_group,
          language: req.body.language,
        },
        {},
        trx,
      );
      await document.update(
        {
          translation_group: null,
        },
        trx,
      );
      return {
        json: {},
      };
    },
  },
  {
    op: 'post',
    view: '/@translations',
    permission: 'Modify',
    client: 'linkTranslation',
    handler: async (req, trx) => {
      const id = req.body.id;

      let target;
      // Check if path or uuid
      if (id.startsWith('/')) {
        target = await Document.fetchOne({ path: id }, {}, trx);
      } else {
        target = await Document.fetchOne({ uuid: id }, {}, trx);
      }

      // Ensure a translation_group exists
      let translationGroup = req.document.translation_group;
      if (!translationGroup) {
        translationGroup = uuid();
        await req.document.update({ translation_group: translationGroup }, trx);
      }

      // Link target to the same translation group
      await target.update(
        {
          translation_group: translationGroup,
        },
        trx,
      );

      return {
        json: {},
      };
    },
  },
  {
    op: 'get',
    view: '/@translation-locator',
    permission: 'View',
    client: 'getTranslationLocation',
    handler: async (req, trx) => {
      // Fetch parent
      const parent = await Document.fetchOne({
        uuid: req.document.parent,
      });

      const document = await Document.fetchOne(
        {
          translation_group: parent.translation_group,
          language: req.query.target_language,
        },
        {},
        trx,
      );

      return {
        json: {
          '@id': document
            ? getUrlByPath(req, document.path)
            : getUrlByPath(req, `/${req.query.target_language}`),
        },
      };
    },
  },
];
