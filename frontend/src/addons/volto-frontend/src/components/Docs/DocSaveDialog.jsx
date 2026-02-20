import React, { useState, useMemo } from 'react';
import { Modal, Button, Form, Radio, TextArea, Message } from 'semantic-ui-react';
import config from '@plone/volto/registry';

/**
 * Bump a semver version string.
 * @param {string} version - e.g. "1.0.0"
 * @param {string} bump - "patch" | "minor" | "major"
 * @returns {string}
 */
function bumpVersion(version, bump) {
  const parts = (version || '0.0.0').split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  const [major, minor, patch] = parts;
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

const BUMP_OPTIONS = [
  {
    value: 'patch',
    label: 'Patch',
    description: 'Cosmetic fix (typo, formatting)',
  },
  {
    value: 'minor',
    label: 'Minor',
    description: 'Content change (new section, updated info)',
  },
  {
    value: 'major',
    label: 'Major',
    description: 'Structural change (reorganisation, major rewrite)',
  },
];

const DocSaveDialog = ({ doc, bodyMd, open, onClose, onSaved }) => {
  const [versionBump, setVersionBump] = useState('patch');
  const [changeSummary, setChangeSummary] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const newVersion = useMemo(
    () => bumpVersion(doc?.version, versionBump),
    [doc?.version, versionBump],
  );

  const handleSave = async () => {
    if (!changeSummary.trim()) return;

    setSaving(true);
    setError(null);

    try {
      const apiPath =
        config.settings.devProxyToApiPath || config.settings.apiPath;
      const response = await fetch(`${apiPath}/@docs/save`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          doc_id: doc.id,
          body_md: bodyMd,
          version_bump: versionBump,
          change_summary: changeSummary.trim(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `Server error: ${response.status}`);
      }

      // Reset state
      setChangeSummary('');
      setVersionBump('patch');
      if (onSaved) onSaved(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (!saving) {
      setError(null);
      onClose();
    }
  };

  return (
    <Modal open={open} onClose={handleClose} size="small" closeIcon>
      <Modal.Header>Save Document</Modal.Header>
      <Modal.Content>
        <Form>
          <Form.Field>
            <label>Version bump</label>
            <p style={{ color: '#666', marginBottom: '0.5em' }}>
              Current: <strong>{doc?.version || 'none'}</strong>
              {' → '}
              New: <strong>{newVersion}</strong>
            </p>
            {BUMP_OPTIONS.map((opt) => (
              <Form.Field key={opt.value}>
                <Radio
                  label={`${opt.label} — ${opt.description}`}
                  name="versionBump"
                  value={opt.value}
                  checked={versionBump === opt.value}
                  onChange={() => setVersionBump(opt.value)}
                />
              </Form.Field>
            ))}
          </Form.Field>

          <Form.Field required>
            <label>Change summary</label>
            <TextArea
              placeholder="Describe what changed and why..."
              value={changeSummary}
              onChange={(e) => setChangeSummary(e.target.value)}
              rows={3}
            />
          </Form.Field>

          {error && <Message negative content={error} />}
        </Form>
      </Modal.Content>
      <Modal.Actions>
        <Button onClick={handleClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          primary
          onClick={handleSave}
          loading={saving}
          disabled={saving || !changeSummary.trim()}
        >
          Save as {newVersion}
        </Button>
      </Modal.Actions>
    </Modal>
  );
};

export default DocSaveDialog;
