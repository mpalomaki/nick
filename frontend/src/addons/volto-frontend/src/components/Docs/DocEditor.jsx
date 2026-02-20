import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Container,
  Header,
  Loader,
  Segment,
  Form,
  TextArea,
  Button,
  Message,
} from 'semantic-ui-react';
import { Helmet } from '@plone/volto/helpers';
import config from '@plone/volto/registry';
import DocSaveDialog from './DocSaveDialog';
import DocLinks from './DocLinks';

const DocEditor = () => {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const slug = searchParams.get('slug');

  const [doc, setDoc] = useState(null);
  const [bodyMd, setBodyMd] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!slug) {
      setError('No document slug provided');
      setLoading(false);
      return;
    }

    const apiPath =
      config.settings.devProxyToApiPath || config.settings.apiPath;
    fetch(`${apiPath}/@docs/view?slug=${encodeURIComponent(slug)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load document: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setDoc(data);
        setBodyMd(data.body_md || '');
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [slug]);

  const handleSaved = (updatedDoc) => {
    setDoc(updatedDoc);
    setBodyMd(updatedDoc.body_md || '');
    setSaveOpen(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 4000);
  };

  if (loading) {
    return (
      <Container style={{ paddingTop: '2em' }}>
        <Loader active inline="centered" content="Loading document..." />
      </Container>
    );
  }

  if (error) {
    return (
      <Container style={{ paddingTop: '2em' }}>
        <Segment color="red">Error: {error}</Segment>
      </Container>
    );
  }

  const hasChanges = doc && bodyMd !== (doc.body_md || '');

  return (
    <Container style={{ paddingTop: '2em', paddingBottom: '2em' }}>
      <Helmet title={`Edit: ${doc.title}`} />
      <Header as="h1">{doc.title}</Header>
      <p style={{ color: '#666' }}>
        Version {doc.version} | {doc.category}
        {doc.subcategory ? ` / ${doc.subcategory}` : ''}
      </p>

      {saved && (
        <Message
          positive
          content={`Document saved as version ${doc.version}.`}
        />
      )}

      <Form>
        <Form.Field>
          <TextArea
            value={bodyMd}
            onChange={(e) => setBodyMd(e.target.value)}
            rows={30}
            style={{ fontFamily: 'monospace', fontSize: '0.9em' }}
          />
        </Form.Field>
        <Button
          primary
          onClick={() => setSaveOpen(true)}
          disabled={!hasChanges}
        >
          Save
        </Button>
        {!hasChanges && (
          <span style={{ color: '#999', marginLeft: '1em' }}>
            No changes to save
          </span>
        )}
      </Form>

      {doc && (
        <DocSaveDialog
          doc={doc}
          bodyMd={bodyMd}
          open={saveOpen}
          onClose={() => setSaveOpen(false)}
          onSaved={handleSaved}
        />
      )}

      {doc && doc.frontmatter?.doc_id && (
        <DocLinks documentId={doc.frontmatter.doc_id} />
      )}
    </Container>
  );
};

export default DocEditor;
