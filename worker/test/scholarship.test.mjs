import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const env = {
    SCHOLARSHIP_DEADLINE: '2999-01-01T00:00:00Z',
    BOARD_KEY: 'test-board-key',
    VIDEOS: {
      head: async key => key === 'transcripts/valid.pdf' || key === 'proofs/legacy.pdf' ? {} : null,
      get: async key => key === 'transcripts/valid.pdf'
        ? { body: 'document', size: 8, httpMetadata: { contentType: 'application/pdf' } }
        : null,
      list: async () => ({ objects: [], truncated: false })
    },
    DB: {
      prepare(sql) {
        const statement = db.prepare(sql);
        const bound = {
          bind(...args) {
            return {
              run: async () => statement.run(...args),
              first: async () => statement.get(...args),
              all: async () => ({ results: statement.all(...args) })
            };
          },
          all: async () => ({ results: statement.all() })
        };
        return bound;
      }
    }
  };
  return { db, env };
}

const application = {
  firstName: 'Test', lastName: 'Student', email: 'student@example.com',
  instagramHandle: 'student', school: 'Spelman College', galaAvailability: 'Yes',
  gpa: '3.5', serviceHours: '100', videoUrl: 'https://youtu.be/123456789ab',
  transcriptKey: 'transcripts/valid.pdf', transcriptName: 'transcript.pdf'
};

function post(path, body, env) {
  return worker.fetch(new Request(`https://example.com${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env);
}

test('accepts hours without proof or supervisor and preserves prior proof on resubmission', async () => {
  const { db, env } = setup();
  const original = {
    ...application, supervisorName: 'Supervisor', supervisorEmail: 'supervisor@example.com',
    supervisorPhone: '5555555555', proofKey: 'proofs/legacy.pdf', proofName: 'proof.pdf'
  };
  assert.equal((await post('/api/scholarship/apply', original, env)).status, 200);
  assert.equal((await post('/api/scholarship/apply', { ...application, serviceHours: '120' }, env)).status, 200);
  const row = db.prepare('SELECT * FROM scholarship_applications').get();
  assert.equal(row.service_hours, '120');
  assert.equal(row.proof_key, original.proofKey);
  assert.equal(row.proof_name, original.proofName);
  assert.equal(row.supervisor_name, original.supervisorName);
  assert.equal(row.supervisor_email, original.supervisorEmail);
  assert.equal(row.supervisor_phone, original.supervisorPhone);

  assert.equal((await post('/api/scholarship/apply', { ...application, email: 'new@example.com' }, env)).status, 200);
  const newRow = db.prepare('SELECT * FROM scholarship_applications WHERE email = ?').get('new@example.com');
  assert.equal(newRow.proof_key, null);
  assert.equal(newRow.supervisor_name, null);
});

test('still requires 100 hours and a completed transcript upload', async () => {
  const { env } = setup();
  for (const body of [
    { ...application, serviceHours: '99' },
    { ...application, transcriptKey: '' },
    { ...application, transcriptKey: 'transcripts/missing.pdf' },
    { ...application, proofKey: 'proofs/missing.pdf' }
  ]) {
    assert.equal((await post('/api/scholarship/apply', body, env)).status, 400);
  }
  assert.equal((await post('/api/scholarship/apply', application, { ...env, VIDEOS: undefined })).status, 400);
});

test('board entries, reviews, and documents work without a code; file listing stays protected', async () => {
  const { env } = setup();
  assert.equal((await post('/api/scholarship/apply', application, env)).status, 200);
  const noKey = { ...env, BOARD_KEY: undefined };
  const entries = await worker.fetch(new Request('https://example.com/api/scholarship/entries', { method: 'POST' }), noKey);
  assert.equal(entries.status, 200);
  const { entries: [entry] } = await entries.json();
  const review = await post('/api/scholarship/review', {
    applicationId: entry.id, reviewer: 'Reviewer', score: 5, note: 'Good'
  }, noKey);
  assert.equal(review.status, 200);
  const updated = await post('/api/scholarship/entries', {}, noKey);
  assert.equal((await updated.json()).entries[0].reviews[0].score, 5);
  const document = await worker.fetch(new Request('https://example.com/api/scholarship/video?key=transcripts%2Fvalid.pdf'), noKey);
  assert.equal(document.status, 200);
  assert.equal(await document.text(), 'document');
  const files = await worker.fetch(new Request('https://example.com/api/scholarship/files'), env);
  assert.equal(files.status, 401);
  const authorized = await worker.fetch(new Request(`https://example.com/api/scholarship/files?k=${env.BOARD_KEY}`), env);
  assert.equal(authorized.status, 200);
});
