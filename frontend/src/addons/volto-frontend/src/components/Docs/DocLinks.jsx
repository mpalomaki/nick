import React, { useEffect, useState, useCallback } from 'react';
import {
  Segment,
  Header,
  Table,
  Button,
  Form,
  Input,
  Dropdown,
  Icon,
  Message,
  Confirm,
  Label,
} from 'semantic-ui-react';
import config from '@plone/volto/registry';

const DocLinks = ({ documentId }) => {
  const [links, setLinks] = useState([]);
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  // Form state
  const [targetDocId, setTargetDocId] = useState('');
  const [relType, setRelType] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const apiPath =
    config.settings.devProxyToApiPath || config.settings.apiPath;

  const fetchLinks = useCallback(async () => {
    try {
      const res = await fetch(
        `${apiPath}/@docs/links?doc_id=${encodeURIComponent(documentId)}`,
      );
      if (!res.ok) throw new Error(`Failed to load links: ${res.status}`);
      const data = await res.json();
      setLinks(data.items || []);
    } catch (err) {
      setError(err.message);
    }
  }, [apiPath, documentId]);

  const fetchTypes = useCallback(async () => {
    try {
      const res = await fetch(`${apiPath}/@docs/links/types`);
      if (!res.ok) throw new Error(`Failed to load types: ${res.status}`);
      const data = await res.json();
      setTypes(data.items || []);
    } catch (err) {
      setError(err.message);
    }
  }, [apiPath]);

  useEffect(() => {
    Promise.all([fetchLinks(), fetchTypes()]).then(() => setLoading(false));
  }, [fetchLinks, fetchTypes]);

  const handleAdd = async () => {
    setFormError(null);
    if (!targetDocId.trim() || !relType) {
      setFormError('Target Document ID and Relationship Type are required.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${apiPath}/@docs/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_doc_id: documentId,
          target_doc_id: targetDocId.trim(),
          relationship_type: relType,
          notes: notes.trim() || undefined,
        }),
      });
      if (res.status === 409) {
        setFormError('This link already exists.');
        setSubmitting(false);
        return;
      }
      if (!res.ok) {
        const data = await res.json();
        setFormError(data.error || `Error: ${res.status}`);
        setSubmitting(false);
        return;
      }
      // Reset form and refresh
      setTargetDocId('');
      setRelType('');
      setNotes('');
      setShowForm(false);
      await fetchLinks();
    } catch (err) {
      setFormError(err.message);
    }
    setSubmitting(false);
  };

  const handleDelete = async (id) => {
    try {
      const res = await fetch(`${apiPath}/@docs/links/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) {
        const data = await res.json();
        setError(data.error || `Delete failed: ${res.status}`);
        return;
      }
      setConfirmDelete(null);
      await fetchLinks();
    } catch (err) {
      setError(err.message);
    }
  };

  const typeOptions = types.map((t) => ({
    key: t.code,
    value: t.code,
    text: t.label,
    description: t.description,
  }));

  if (loading) return null;

  return (
    <Segment style={{ marginTop: '2em' }}>
      <Header as="h3">
        <Icon name="linkify" />
        <Header.Content>
          Document Links
          <Header.Subheader>
            Cross-references to and from this document
          </Header.Subheader>
        </Header.Content>
      </Header>

      {error && <Message negative content={error} onDismiss={() => setError(null)} />}

      {links.length === 0 && !showForm && (
        <p style={{ color: '#888' }}>No document links yet.</p>
      )}

      {links.length > 0 && (
        <Table compact celled>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Relationship</Table.HeaderCell>
              <Table.HeaderCell>Related Document</Table.HeaderCell>
              <Table.HeaderCell>Notes</Table.HeaderCell>
              <Table.HeaderCell>Created</Table.HeaderCell>
              <Table.HeaderCell width={1}></Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {links.map((link) => (
              <Table.Row key={`${link.id}-${link.direction}`}>
                <Table.Cell>
                  {link.relationship_label}
                  {' '}
                  <Label
                    size="tiny"
                    color={link.direction === 'outgoing' ? 'blue' : 'grey'}
                  >
                    {link.direction}
                  </Label>
                </Table.Cell>
                <Table.Cell>
                  <strong>{link.related_doc_id}</strong>
                  {link.related_title && (
                    <span style={{ color: '#666' }}> — {link.related_title}</span>
                  )}
                </Table.Cell>
                <Table.Cell>{link.notes || ''}</Table.Cell>
                <Table.Cell style={{ whiteSpace: 'nowrap', fontSize: '0.85em' }}>
                  {link.created_by}
                  <br />
                  {new Date(link.created_at).toLocaleDateString()}
                </Table.Cell>
                <Table.Cell textAlign="center">
                  {link.direction === 'outgoing' && (
                    <Button
                      icon="trash"
                      size="mini"
                      color="red"
                      basic
                      title="Delete link"
                      onClick={() => setConfirmDelete(link.id)}
                    />
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      {!showForm && (
        <Button
          size="small"
          primary
          icon="plus"
          content="Add Link"
          onClick={() => setShowForm(true)}
        />
      )}

      {showForm && (
        <Segment secondary>
          <Header as="h4">Add Link</Header>
          {formError && <Message negative size="small" content={formError} />}
          <Form>
            <Form.Group widths="equal">
              <Form.Field required>
                <label>Target Document ID</label>
                <Input
                  placeholder="e.g. SOP-DC-001"
                  value={targetDocId}
                  onChange={(e) => setTargetDocId(e.target.value)}
                />
              </Form.Field>
              <Form.Field required>
                <label>Relationship Type</label>
                <Dropdown
                  placeholder="Select type..."
                  fluid
                  selection
                  search
                  options={typeOptions}
                  value={relType}
                  onChange={(e, { value }) => setRelType(value)}
                />
              </Form.Field>
            </Form.Group>
            <Form.Field>
              <label>Notes (optional)</label>
              <Form.TextArea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Form.Field>
            <Button
              primary
              size="small"
              loading={submitting}
              onClick={handleAdd}
              content="Save Link"
            />
            <Button
              size="small"
              onClick={() => {
                setShowForm(false);
                setFormError(null);
              }}
              content="Cancel"
            />
          </Form>
        </Segment>
      )}

      <Confirm
        open={confirmDelete !== null}
        content="Delete this document link?"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => handleDelete(confirmDelete)}
      />
    </Segment>
  );
};

export default DocLinks;
