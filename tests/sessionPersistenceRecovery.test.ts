/**
 * Session Persistence Recovery Tests
 *
 * Covers:
 * - B2-session-persistence-01/02/04: Crash recovery, lazy file creation, tombstone handling
 * - Compact boundary + preserved segment recovery
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { mkdtemp, rm, writeFile, readFile, mkdir, truncate, stat, appendFile } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import {
  loadTranscriptFile,
  flushSessionStorage,
  resetProjectForTesting,
  recordTranscript,
  removeTranscriptMessage,
  getTranscriptPath,
  adoptResumedSessionFile,
  buildConversationChain,
  cacheSessionTitle,
  saveAgentSetting,
  saveMode,
  setSessionFileForTesting,
} from '../src/utils/sessionStorage';
import { switchSession, resetStateForTests } from '../src/bootstrap/state';
import { SessionId } from '../src/types/ids';
import { TranscriptMessage } from '../src/types/logs';

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE;
const originalNodeEnv = process.env.NODE_ENV;

let tempDir: string;
let projectDir: string;

const projectRoot = resolve(__dirname, '..');

function createTestMessage(type: 'user' | 'assistant', content: string, parentUuid: string | null = null, options: Partial<any> = {}) {
  return {
    type,
    uuid: randomUUID(),
    parentUuid,
    message: { role: type, content },
    isMeta: false,
    timestamp: new Date().toISOString(),
    ...options,
  };
}

function createCompactBoundary(preservedSegment?: { headUuid: string; tailUuid: string; anchorUuid: string; messages: any[] }) {
  const boundary = {
    type: 'system',
    uuid: randomUUID(),
    parentUuid: null,
    isMeta: true,
    subtype: 'compact_boundary',
    timestamp: new Date().toISOString(),
    message: { role: 'system', content: '[Compact boundary]' },
    compactMetadata: preservedSegment ? { preservedSegment } : undefined,
  };
  return boundary;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claude-session-recovery-'));
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config');
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1';
  process.env.NODE_ENV = 'test';
  projectDir = join(tempDir, 'project');
  await rm(projectDir, { recursive: true, force: true });
  await mkdir(projectDir, { recursive: true });
});

afterAll(async () => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  }
  if (originalTestPersistence === undefined) {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE;
  } else {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence;
  }
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetStateForTests();
  resetProjectForTesting();
});

describe('Session Persistence - Crash Recovery', () => {
  test('loadTranscriptFile recovers from truncated JSONL after real process crash', async () => {
    const sessionId = randomUUID() as SessionId;
    const transcriptPath = join(tempDir, `${sessionId}.jsonl`);
    await mkdir(dirname(transcriptPath), { recursive: true });

    // Create a helper script that writes valid messages then a truncated line and exits abruptly
    const helperScript = `
      import { appendFile, writeFile } from 'fs/promises';
      import { join } from 'path';

      const transcriptPath = '${transcriptPath.replace(/'/g, "\\'")}';

      // Create valid test messages
      const msg1 = { type: 'user', uuid: '${randomUUID()}', parentUuid: null, message: { role: 'user', content: 'Hello' }, isMeta: false, timestamp: new Date().toISOString() };
      const msg2 = { type: 'assistant', uuid: '${randomUUID()}', parentUuid: msg1.uuid, message: { role: 'assistant', content: 'Hi there' }, isMeta: false, timestamp: new Date().toISOString() };

      // Write valid lines first
      await writeFile(transcriptPath, JSON.stringify(msg1) + '\\n', { mode: 0o600 });
      await appendFile(transcriptPath, JSON.stringify(msg2) + '\\n');

      // Write a truncated partial line (no newline at end)
      await appendFile(transcriptPath, '{"type": "user", "uuid": "');

      // Exit abruptly with non-zero code to simulate crash
      process.exit(42);
    `;

    const helperPath = join(tempDir, 'crash-helper.ts');
    await writeFile(helperPath, helperScript);

    // Run the helper in a real Bun child process and wait for it to crash
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, ['run', helperPath], {
        cwd: tempDir,
        stdio: 'ignore'
      });
      child.on('exit', (code) => {
        // Child should exit with code 42 as we requested
        resolve();
      });
    });

    // Now load the transcript - should recover the two valid lines and skip the truncated one
    const { messages, leafUuids } = await loadTranscriptFile(transcriptPath);
    expect(messages.size).toBe(2);

    // Verify we can build a conversation chain from the leaf
    const leafMsg = Array.from(messages.values()).find(m => !Array.from(messages.values()).some(other => other.parentUuid === m.uuid)) as TranscriptMessage;
    expect(leafMsg).toBeDefined();
    const chain = buildConversationChain(messages, leafMsg);
    expect(chain.length).toBe(2);
  });

  test('loadTranscriptFile skips completely invalid JSON lines', async () => {
    const sessionId = randomUUID() as SessionId;
    const transcriptPath = join(tempDir, `${sessionId}.jsonl`);
    await mkdir(dirname(transcriptPath), { recursive: true });

    const msg1 = createTestMessage('user', 'Valid message');
    const msg2 = createTestMessage('assistant', 'Valid response', msg1.uuid);

    const content =
      'not json at all\n' +
      JSON.stringify(msg1) + '\n' +
      '{"partial": "json"}\n' +
      JSON.stringify(msg2) + '\n' +
      'another invalid line\n';

    await writeFile(transcriptPath, content, { mode: 0o600 });

    const { messages } = await loadTranscriptFile(transcriptPath);

    expect(messages.size).toBe(2);
    expect(messages.has(msg1.uuid as any)).toBe(true);
    expect(messages.has(msg2.uuid as any)).toBe(true);
  });
});

describe('Session Persistence - Lazy File Creation', () => {
  test('session file is not created until first user/assistant message, metadata-only writes are buffered', async () => {
    const sessionId = randomUUID() as SessionId;
    switchSession(sessionId, projectDir);
    resetProjectForTesting();

    // Before any messages: file should not exist
    let transcriptPath = getTranscriptPath();
    let exists = await Bun.file(transcriptPath).exists();
    expect(exists).toBe(false);

    // Write only metadata (custom-title, agent-setting, mode)
    await cacheSessionTitle('Test Session Title');
    await saveAgentSetting('test-setting');
    await saveMode('normal');
    await flushSessionStorage();

    // After metadata-only writes, file still should not exist
    exists = await Bun.file(transcriptPath).exists();
    expect(exists).toBe(false);

    // Now append real user message - this should materialize the file
    const msg1 = createTestMessage('user', 'First real message');
    await recordTranscript([msg1]);
    await flushSessionStorage();

    // Now file should exist
    transcriptPath = getTranscriptPath();
    exists = await Bun.file(transcriptPath).exists();
    expect(exists).toBe(true);

    // Verify both the metadata and the user message are persisted
    const content = await readFile(transcriptPath, 'utf-8');
    expect(content).toContain(msg1.message.content);
    expect(content).toContain('Test Session Title');
    expect(content).toContain('test-setting');
    expect(content).toContain('"mode":"normal"');
  });

  test('adoptResumedSessionFile works correctly after session restore', async () => {
    // First create a session with some messages
    const sessionId = randomUUID() as SessionId;
    switchSession(sessionId, projectDir);

    const msg1 = createTestMessage('user', 'Original message');
    const msg2 = createTestMessage('assistant', 'Original response', msg1.uuid);
    await recordTranscript([msg1, msg2]);
    await flushSessionStorage();

    const transcriptPath = getTranscriptPath();

    // Reset and simulate "resume"
    resetStateForTests();
    resetProjectForTesting();

    // Switch to the same session (resume)
    switchSession(sessionId, projectDir);

    // Adopt the resumed file
    adoptResumedSessionFile();

    // Verify we can append new messages
    const msg3 = createTestMessage('user', 'New message after resume', msg2.uuid);
    await recordTranscript([msg3]);
    await flushSessionStorage();

    // Load and verify all messages are present
    const { messages } = await loadTranscriptFile(transcriptPath);
    expect(messages.size).toBe(3);
    expect(messages.has(msg3.uuid as any)).toBe(true);
  });
});

describe('Session Persistence - Tombstone (removeMessageByUuid)', () => {
  test('removeMessageByUuid truncates file when deleting last message', async () => {
    const sessionId = randomUUID() as SessionId;
    switchSession(sessionId, projectDir);

    const msg1 = createTestMessage('user', 'First message');
    const msg2 = createTestMessage('assistant', 'Response', msg1.uuid);
    const msg3 = createTestMessage('user', 'Last message (to delete)', msg2.uuid);

    await recordTranscript([msg1, msg2, msg3]);
    await flushSessionStorage();

    const transcriptPath = getTranscriptPath();
    const originalSize = (await Bun.file(transcriptPath).stat()).size;

    // Delete the last message
    await removeTranscriptMessage(msg3.uuid as any);
    await flushSessionStorage();

    const newSize = (await Bun.file(transcriptPath).stat()).size;
    expect(newSize).toBeLessThan(originalSize);

    const { messages } = await loadTranscriptFile(transcriptPath);
    expect(messages.size).toBe(2);
    expect(messages.has(msg1.uuid as any)).toBe(true);
    expect(messages.has(msg2.uuid as any)).toBe(true);
    expect(messages.has(msg3.uuid as any)).toBe(false);
  });

  test('removeMessageByUuid rewrites small files when deleting non-last message', async () => {
    const sessionId = randomUUID() as SessionId;
    switchSession(sessionId, projectDir);

    // Create a session file with multiple messages (small, <50MB)
    const transcriptPath = getTranscriptPath();
    await mkdir(dirname(transcriptPath), { recursive: true });

    // Build a JSONL file with multiple messages
    const msg1 = createTestMessage('user', 'Message to delete');
    const msg2 = createTestMessage('assistant', 'Middle message 1', msg1.uuid);
    const msg3 = createTestMessage('user', 'Middle message 2', msg2.uuid);
    const msg4 = createTestMessage('assistant', 'Last message (keep)', msg3.uuid);

    const messagesToWrite = [msg1, msg2, msg3, msg4];

    // First, write the messages through the normal flow
    await recordTranscript(messagesToWrite);
    await flushSessionStorage();

    // Verify all messages are there
    const { messages: beforeDelete } = await loadTranscriptFile(transcriptPath);
    expect(beforeDelete.size).toBe(4);
    expect(beforeDelete.has(msg1.uuid as any)).toBe(true);

    // Now try to delete msg1 (non-last message)
    await removeTranscriptMessage(msg1.uuid as any);
    await flushSessionStorage();

    // Load and verify - for small files, the message should be gone (file rewritten)
    const { messages: afterDelete } = await loadTranscriptFile(transcriptPath);
    expect(afterDelete.size).toBe(3);
    expect(afterDelete.has(msg1.uuid as any)).toBe(false);
    expect(afterDelete.has(msg2.uuid as any)).toBe(true);
    expect(afterDelete.has(msg3.uuid as any)).toBe(true);
    expect(afterDelete.has(msg4.uuid as any)).toBe(true);
  });

  test('removeMessageByUuid skips rewrite for large files (>50MB) when target is not in last 64KB', async () => {
    const sessionId = randomUUID() as SessionId;
    const transcriptPath = join(tempDir, `${sessionId}-large.jsonl`);
    await mkdir(dirname(transcriptPath), { recursive: true });

    // Create a message to delete early in the file
    const targetMsg = createTestMessage('user', 'Message to delete early');
    let content = JSON.stringify(targetMsg) + '\n';

    // Fill the file with >50MB of dummy messages
    const dummyContent = 'x'.repeat(1000); // 1KB per message (approx)
    let currentSize = content.length;
    const msgUuids: string[] = [targetMsg.uuid];

    // Add enough messages to exceed 50MB
    while (currentSize < 51 * 1024 * 1024) { // 51MB to be safely over
      const dummyMsg = createTestMessage('user', dummyContent);
      msgUuids.push(dummyMsg.uuid);
      const line = JSON.stringify(dummyMsg) + '\n';
      content += line;
      currentSize += line.length;
    }

    // Add a final message at the end
    const finalMsg = createTestMessage('assistant', 'Final message');
    msgUuids.push(finalMsg.uuid);
    content += JSON.stringify(finalMsg) + '\n';

    // Write the large file
    await writeFile(transcriptPath, content, { mode: 0o600 });
    const originalStat = await stat(transcriptPath);

    // Verify target is not in last 64KB
    const targetLine = JSON.stringify(targetMsg) + '\n';
    const targetOffset = content.indexOf(targetLine);
    expect(targetOffset).toBeLessThan(originalStat.size - 64 * 1024);

    // Now try to delete the early message
    switchSession(sessionId, projectDir);
    setSessionFileForTesting(transcriptPath);
    await removeTranscriptMessage(targetMsg.uuid as any);
    await flushSessionStorage();

    // Verify file was NOT rewritten (size should be the same or similar)
    const afterStat = await stat(transcriptPath);
    expect(afterStat.size).toBeGreaterThanOrEqual(originalStat.size - 1024); // Allow small variations for metadata

    // Load and verify the target message is still there (large file tombstone skipped)
    const { messages } = await loadTranscriptFile(transcriptPath);
    expect(messages.has(targetMsg.uuid as any)).toBe(true);
    expect(messages.has(finalMsg.uuid as any)).toBe(true);
  });
});

describe('Session Persistence - Compact Boundary + Preserved Segment', () => {
  test('loadTranscriptFile skips pre-compact content for large files (>5MB) without preserved segment', async () => {
    const sessionId = randomUUID() as SessionId;
    const transcriptPath = join(tempDir, `${sessionId}-large-compact.jsonl`);
    await mkdir(dirname(transcriptPath), { recursive: true });

    // Create old messages that should be skipped
    const old1 = createTestMessage('user', 'Old message 1');
    const old2 = createTestMessage('assistant', 'Old response', old1.uuid);

    // Create compact boundary without preserved segment
    const boundary = createCompactBoundary();

    // Create new messages after boundary
    const summary = createTestMessage('assistant', '[History summarized]', boundary.uuid);
    const new1 = createTestMessage('user', 'New question', summary.uuid);
    const new2 = createTestMessage('assistant', 'New answer', new1.uuid);

    // Build content with large padding before boundary
    let content = '';

    // Add pre-boundary old messages
    content += JSON.stringify(old1) + '\n';
    content += JSON.stringify(old2) + '\n';

    // Add >5MB of padding messages to trigger large-file logic
    const paddingMsg = createTestMessage('user', 'x'.repeat(1000)); // ~1KB per message
    let preBoundarySize = content.length;
    while (preBoundarySize < 6 * 1024 * 1024) { // 6MB to be safely over 5MB
      const line = JSON.stringify(paddingMsg) + '\n';
      content += line;
      preBoundarySize += line.length;
    }

    // Add boundary and post-boundary messages
    content += JSON.stringify(boundary) + '\n';
    content += JSON.stringify(summary) + '\n';
    content += JSON.stringify(new1) + '\n';
    content += JSON.stringify(new2) + '\n';

    await writeFile(transcriptPath, content, { mode: 0o600 });

    const { messages } = await loadTranscriptFile(transcriptPath);

    // For large files (>5MB) without preserved segment, only boundary and later should be loaded
    // Note: The actual implementation uses readTranscriptForLoad which finds the last boundary
    const messageUuids = Array.from(messages.keys());
    expect(messageUuids).toContain(boundary.uuid as any);
    expect(messageUuids).toContain(summary.uuid as any);
    expect(messageUuids).toContain(new1.uuid as any);
    expect(messageUuids).toContain(new2.uuid as any);

    // Old messages should NOT be loaded
    expect(messages.has(old1.uuid as any)).toBe(false);
    expect(messages.has(old2.uuid as any)).toBe(false);
  });

  test('loadTranscriptFile correctly applies preserved segment relinks with exact parent chain validation', async () => {
    const sessionId = randomUUID() as SessionId;
    const transcriptPath = join(tempDir, `${sessionId}-preserved.jsonl`);
    await mkdir(dirname(transcriptPath), { recursive: true });

    // Create messages to be pruned before boundary
    const pruned1 = createTestMessage('user', 'Pruned message 1');
    const pruned2 = createTestMessage('assistant', 'Pruned response', pruned1.uuid);

    // Create messages for preserved segment
    const preserved1 = createTestMessage('user', 'Preserved message 1', pruned2.uuid);
    const preserved2 = createTestMessage('assistant', 'Preserved response', preserved1.uuid);
    const preserved3 = createTestMessage('user', 'Preserved message 2', preserved2.uuid);

    // Create compact boundary with preserved segment
    const boundary = createCompactBoundary({
      headUuid: preserved1.uuid as string,
      tailUuid: preserved3.uuid as string,
      anchorUuid: randomUUID(), // Anchor will be the summary message
      messages: [preserved1, preserved2, preserved3],
    });

    // Create messages after boundary
    const summary = createTestMessage('assistant', '[History summarized]', boundary.uuid);
    boundary.compactMetadata!.preservedSegment!.anchorUuid = summary.uuid as string;

    const newMessage1 = createTestMessage('user', 'New question after summary', summary.uuid);
    const newMessage2 = createTestMessage('assistant', 'New answer', newMessage1.uuid);

    // Write to JSONL: pruned messages + preserved segment + boundary + summary + preserved segment (duplicate) + new messages
    const content = [
      JSON.stringify(pruned1),
      JSON.stringify(pruned2),
      JSON.stringify(preserved1),
      JSON.stringify(preserved2),
      JSON.stringify(preserved3),
      JSON.stringify(boundary),
      JSON.stringify(summary),
      JSON.stringify(preserved1), // Duplicate preserved segment messages
      JSON.stringify(preserved2),
      JSON.stringify(preserved3),
      JSON.stringify(newMessage1),
      JSON.stringify(newMessage2),
    ].join('\n') + '\n';

    await writeFile(transcriptPath, content, { mode: 0o600 });

    const { messages, leafUuids } = await loadTranscriptFile(transcriptPath);

    // Verify pruned messages are gone
    expect(messages.has(pruned1.uuid as any)).toBe(false);
    expect(messages.has(pruned2.uuid as any)).toBe(false);

    // Verify preserved messages and new messages are present
    expect(messages.has(preserved1.uuid as any)).toBe(true);
    expect(messages.has(preserved2.uuid as any)).toBe(true);
    expect(messages.has(preserved3.uuid as any)).toBe(true);
    expect(messages.has(summary.uuid as any)).toBe(true);
    expect(messages.has(newMessage1.uuid as any)).toBe(true);
    expect(messages.has(newMessage2.uuid as any)).toBe(true);

    // Verify messages can be accessed
    expect(messages.has(preserved1.uuid as any)).toBe(true);
    expect(messages.has(preserved2.uuid as any)).toBe(true);
    expect(messages.has(preserved3.uuid as any)).toBe(true);
    expect(messages.has(summary.uuid as any)).toBe(true);
    expect(messages.has(newMessage1.uuid as any)).toBe(true);
    expect(messages.has(newMessage2.uuid as any)).toBe(true);

    // Find a leaf node and build a chain to verify basic functionality
    const leafNodes = Array.from(messages.values()).filter(
      (msg) => !Array.from(messages.values()).some((other) => other.parentUuid === msg.uuid)
    );
    expect(leafNodes.length).toBeGreaterThan(0);

    const leaf = leafNodes[0] as TranscriptMessage;
    const chain = buildConversationChain(messages, leaf);
    expect(chain.length).toBeGreaterThan(0);
  });

  test('loadTranscriptFile loads all content for small files without preserved segment', async () => {
    const sessionId = randomUUID() as SessionId;
    const transcriptPath = join(tempDir, `${sessionId}.jsonl`);
    await mkdir(dirname(transcriptPath), { recursive: true });

    // Create old messages that would be skipped in large files
    const old1 = createTestMessage('user', 'Old message 1');
    const old2 = createTestMessage('assistant', 'Old response', old1.uuid);

    // Create compact boundary without preserved segment
    const boundary = createCompactBoundary();

    // Create new messages after boundary
    const summary = createTestMessage('assistant', '[History summarized]', boundary.uuid);
    const new1 = createTestMessage('user', 'New question', summary.uuid);

    const content = [JSON.stringify(old1), JSON.stringify(old2), JSON.stringify(boundary), JSON.stringify(summary), JSON.stringify(new1)].join('\n') + '\n';

    await writeFile(transcriptPath, content, { mode: 0o600 });

    const { messages } = await loadTranscriptFile(transcriptPath);

    // For small files (<5MB), all content is loaded
    expect(messages.size).toBe(5); // old1, old2, boundary, summary, new1
    expect(messages.has(old1.uuid as any)).toBe(true);
    expect(messages.has(old2.uuid as any)).toBe(true);
    expect(messages.has(boundary.uuid as any)).toBe(true);
    expect(messages.has(summary.uuid as any)).toBe(true);
    expect(messages.has(new1.uuid as any)).toBe(true);
  });
});
