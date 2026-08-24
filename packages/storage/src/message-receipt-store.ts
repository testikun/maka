/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  messageContentsEqual,
  normalizeMessageContent,
  type MessageContent,
} from '@maka/core/events';
import { messageContentDigest } from './message-content-digest.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RECEIPT_SCHEMA_VERSION = 1 as const;
const RECEIPT_MAX_BYTES = 64 * 1024;

export type MessageReceiptOperation =
  | 'submit'
  | 'retract'
  | 'retract_entry'
  | 'promote'
  | 'update_entry'
  | 'reorder'
  | 'interrupt';

export interface MessageOperationReceipt {
  readonly payload: unknown;
  readonly result: unknown;
}

export interface PendingMessageAdmission {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly content: MessageContent;
  readonly modelContent: MessageContent;
  readonly submittedPlacement: 'current_turn' | 'next_turn';
  readonly placement: 'current_turn' | 'next_turn';
  readonly disposition: 'steering' | 'followup';
  readonly admittedAt: number;
}

export interface MessageAdmissionSettlement {
  readonly messageId: string;
  readonly settlement: 'retracted';
  readonly submittedPlacement?: 'current_turn' | 'next_turn';
  readonly submittedContentDigest?: `sha256:${string}`;
}

export interface MessageReceiptStore {
  beginHostEpoch(hostEpoch: string): Promise<void>;
  read(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
  ): Promise<MessageOperationReceipt | undefined>;
  commit(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
    receipt: MessageOperationReceipt,
  ): Promise<MessageOperationReceipt>;
  readMessageAdmission(
    sessionId: string,
    messageId: string,
  ): Promise<PendingMessageAdmission | undefined>;
  readMessageSettlement(
    sessionId: string,
    messageId: string,
  ): Promise<MessageAdmissionSettlement | undefined>;
  listPendingMessages(): Promise<readonly PendingMessageAdmission[]>;
  commitMessageOrder(sessionId: string, messageIds: readonly string[]): Promise<void>;
  commitMessageRetractions(sessionId: string, messageIds: readonly string[]): Promise<void>;
  garbageCollectMessageAdmissions(sessionId: string, messageIds: readonly string[]): Promise<void>;
}

interface StoredMessageOperationReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly hostEpoch: string;
  readonly operation: MessageReceiptOperation;
  readonly sessionId: string;
  readonly operationId: string;
  readonly payload: unknown;
  readonly result: unknown;
}

export interface ClosableMessageReceiptStore extends MessageReceiptStore {
  ready(): Promise<void>;
  close(): void;
}

export function createSqliteMessageReceiptStore(
  workspaceRoot: string,
): ClosableMessageReceiptStore {
  return new SqliteMessageReceiptStore(workspaceRoot);
}

class SqliteMessageReceiptStore implements ClosableMessageReceiptStore {
  readonly #lease: OperationalStateDatabaseLease;

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async beginHostEpoch(hostEpoch: string): Promise<void> {
    validateHostEpoch(hostEpoch);
    this.#lease.transaction('write', () => {
      this.#lease.database
        .prepare('INSERT OR IGNORE INTO core_message_host_epochs(host_epoch) VALUES (?)')
        .run(hostEpoch);
      this.#lease.database
        .prepare('DELETE FROM core_message_host_epochs WHERE host_epoch <> ?')
        .run(hostEpoch);
    });
  }

  async read(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
  ): Promise<MessageOperationReceipt | undefined> {
    validateIdentity(hostEpoch, operation, sessionId, operationId);
    const row = this.#lease.database
      .prepare(`
        SELECT payload_json, result_json
        FROM core_message_receipts
        WHERE host_epoch = ? AND operation = ? AND session_id = ? AND operation_id = ?
      `)
      .get(hostEpoch, operation, sessionId, operationId) as
      | { payload_json?: unknown; result_json?: unknown }
      | undefined;
    if (!row) return undefined;
    if (typeof row.payload_json !== 'string' || typeof row.result_json !== 'string') {
      throw new Error('Invalid SQLite message operation receipt');
    }
    return Object.freeze({
      payload: JSON.parse(row.payload_json),
      result: JSON.parse(row.result_json),
    });
  }

  async commit(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
    receipt: MessageOperationReceipt,
  ): Promise<MessageOperationReceipt> {
    validateIdentity(hostEpoch, operation, sessionId, operationId);
    const stored = normalizeReceipt(hostEpoch, operation, sessionId, operationId, receipt);
    return this.#lease.transaction('write', () => {
      this.#lease.database
        .prepare('INSERT OR IGNORE INTO core_message_host_epochs(host_epoch) VALUES (?)')
        .run(hostEpoch);
      const inserted = this.#lease.database
        .prepare(`
          INSERT OR IGNORE INTO core_message_receipts(
            host_epoch, operation, session_id, operation_id, payload_json, result_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          hostEpoch,
          operation,
          sessionId,
          operationId,
          JSON.stringify(stored.payload),
          JSON.stringify(stored.result),
        );
      if (inserted.changes === 0) {
        const existing = readSqliteReceipt(
          this.#lease.database,
          hostEpoch,
          operation,
          sessionId,
          operationId,
        );
        if (!existing || !isDeepStrictEqual(existing, stored)) {
          throw new Error('Message operation receipt identity conflict');
        }
        return existing;
      }
      return stored;
    });
  }

  async readMessageAdmission(
    sessionId: string,
    messageId: string,
  ): Promise<PendingMessageAdmission | undefined> {
    assertSafeId(sessionId, 'Invalid Session identity');
    assertSafeId(messageId, 'Invalid Message identity');
    const settlement = this.#lease.database
      .prepare(`
        SELECT 1
        FROM core_message_admission_settlements
        WHERE session_id = ? AND message_id = ?
      `)
      .get(sessionId, messageId);
    if (settlement) return undefined;
    return readPendingMessageAdmission(this.#lease.database, sessionId, messageId);
  }

  async readMessageSettlement(
    sessionId: string,
    messageId: string,
  ): Promise<MessageAdmissionSettlement | undefined> {
    assertSafeId(sessionId, 'Invalid Session identity');
    assertSafeId(messageId, 'Invalid Message identity');
    const row = this.#lease.database
      .prepare(`
        SELECT message_id, settlement, submitted_placement, submitted_content_digest
        FROM core_message_admission_settlements
        WHERE session_id = ? AND message_id = ?
      `)
      .get(sessionId, messageId) as MessageAdmissionSettlementRow | undefined;
    return row ? decodeMessageAdmissionSettlementRow(row) : undefined;
  }

  async listPendingMessages(): Promise<readonly PendingMessageAdmission[]> {
    return this.#lease.database
      .prepare(`
        SELECT session_id, turn_id, run_id, message_id, content_json, model_content_json,
          submitted_placement, placement, disposition, queue_order, admitted_at
        FROM core_message_admissions
        WHERE NOT EXISTS (
          SELECT 1
          FROM core_message_admission_settlements
          WHERE core_message_admission_settlements.session_id =
              core_message_admissions.session_id
            AND core_message_admission_settlements.message_id =
              core_message_admissions.message_id
        )
        ORDER BY session_id,
          CASE disposition WHEN 'steering' THEN 0 ELSE 1 END,
          queue_order,
          sequence
      `)
      .all()
      .map(decodePendingMessageAdmissionRow);
  }

  async commitMessageOrder(sessionId: string, messageIds: readonly string[]): Promise<void> {
    assertSafeId(sessionId, 'Invalid Session identity');
    for (const messageId of messageIds) assertSafeId(messageId, 'Invalid Message identity');
    this.#lease.transaction('write', () => {
      const statement = this.#lease.database.prepare(`
        UPDATE core_message_admissions
        SET queue_order = ?
        WHERE session_id = ? AND message_id = ? AND disposition = 'followup'
      `);
      for (let index = 0; index < messageIds.length; index += 1) {
        const updated = statement.run(index, sessionId, messageIds[index]);
        if (updated.changes !== 1) throw new Error('Message order identity conflict');
      }
    });
  }

  async commitMessageRetractions(sessionId: string, messageIds: readonly string[]): Promise<void> {
    assertSafeId(sessionId, 'Invalid Session identity');
    const uniqueMessageIds = [...new Set(messageIds)];
    for (const messageId of uniqueMessageIds) {
      assertSafeId(messageId, 'Invalid Message identity');
    }
    this.#lease.transaction('write', () => {
      const readAdmission = this.#lease.database.prepare(`
        SELECT session_id, turn_id, run_id, message_id, content_json, model_content_json,
          submitted_placement, placement, disposition, queue_order, admitted_at
        FROM core_message_admissions
        WHERE session_id = ? AND message_id = ?
      `);
      const statement = this.#lease.database.prepare(`
        INSERT OR IGNORE INTO core_message_admission_settlements(
          session_id, message_id, settlement, submitted_placement, submitted_content_digest
        ) VALUES (?, ?, 'retracted', ?, ?)
      `);
      const removeAdmission = this.#lease.database.prepare(`
        DELETE FROM core_message_admissions WHERE session_id = ? AND message_id = ?
      `);
      for (const messageId of uniqueMessageIds) {
        const existingSettlement = this.#lease.database
          .prepare(`
            SELECT message_id, settlement, submitted_placement, submitted_content_digest
            FROM core_message_admission_settlements
            WHERE session_id = ? AND message_id = ?
          `)
          .get(sessionId, messageId) as MessageAdmissionSettlementRow | undefined;
        if (existingSettlement) {
          decodeMessageAdmissionSettlementRow(existingSettlement);
          continue;
        }
        const admissionRow = readAdmission.get(sessionId, messageId) as
          | PendingMessageAdmissionRow
          | undefined;
        if (!admissionRow) throw new Error('Message retraction identity does not exist');
        const admission = decodePendingMessageAdmissionRow(admissionRow);
        statement.run(
          sessionId,
          messageId,
          admission.submittedPlacement,
          messageContentDigest(admission.content),
        );
        removeAdmission.run(sessionId, messageId);
      }
    });
  }

  async garbageCollectMessageAdmissions(
    sessionId: string,
    messageIds: readonly string[],
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid Session identity');
    const uniqueMessageIds = [...new Set(messageIds)];
    if (uniqueMessageIds.length === 0) return;
    for (const messageId of uniqueMessageIds) {
      assertSafeId(messageId, 'Invalid Message identity');
    }
    this.#lease.transaction('write', () => {
      const statement = this.#lease.database.prepare(`
        DELETE FROM core_message_admissions
        WHERE session_id = ? AND message_id = ?
      `);
      for (const messageId of uniqueMessageIds) statement.run(sessionId, messageId);
    });
  }

  close(): void {
    this.#lease.close();
  }
}

function readSqliteReceipt(
  db: DatabaseSync,
  hostEpoch: string,
  operation: MessageReceiptOperation,
  sessionId: string,
  operationId: string,
): MessageOperationReceipt | undefined {
  const row = db
    .prepare(`
      SELECT payload_json, result_json
      FROM core_message_receipts
      WHERE host_epoch = ? AND operation = ? AND session_id = ? AND operation_id = ?
    `)
    .get(hostEpoch, operation, sessionId, operationId) as
    | { payload_json?: unknown; result_json?: unknown }
    | undefined;
  if (!row) return undefined;
  if (typeof row.payload_json !== 'string' || typeof row.result_json !== 'string') {
    throw new Error('Invalid SQLite message operation receipt');
  }
  return Object.freeze({
    payload: JSON.parse(row.payload_json),
    result: JSON.parse(row.result_json),
  });
}

function normalizeReceipt(
  hostEpoch: string,
  operation: MessageReceiptOperation,
  sessionId: string,
  operationId: string,
  receipt: MessageOperationReceipt,
): MessageOperationReceipt {
  const encoded = JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    hostEpoch,
    operation,
    sessionId,
    operationId,
    payload: receipt.payload,
    result: receipt.result,
  });
  if (Buffer.byteLength(`${encoded}\n`, 'utf8') > RECEIPT_MAX_BYTES) {
    throw new Error('Message operation receipt exceeds size limit');
  }
  const decoded = decodeStoredReceipt(JSON.parse(encoded), {
    hostEpoch,
    operation,
    sessionId,
    operationId,
  });
  return Object.freeze({ payload: decoded.payload, result: decoded.result });
}

function validateHostEpoch(hostEpoch: string): void {
  assertSafeId(hostEpoch, 'Invalid Host Epoch');
}

function validateIdentity(
  hostEpoch: string,
  operation: MessageReceiptOperation,
  sessionId: string,
  operationId: string,
): void {
  assertSafeId(hostEpoch, 'Invalid Host Epoch');
  if (
    operation !== 'submit' &&
    operation !== 'retract' &&
    operation !== 'retract_entry' &&
    operation !== 'promote' &&
    operation !== 'update_entry' &&
    operation !== 'reorder' &&
    operation !== 'interrupt'
  ) {
    throw new Error('Invalid message receipt operation');
  }
  assertSafeId(sessionId, 'Invalid Session identity');
  assertSafeId(operationId, 'Invalid message operation identity');
}

function decodeStoredReceipt(
  value: unknown,
  expected: {
    hostEpoch: string;
    operation: MessageReceiptOperation;
    sessionId: string;
    operationId: string;
  },
): StoredMessageOperationReceipt {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 7
  ) {
    throw new Error('Invalid message operation receipt');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    record.hostEpoch !== expected.hostEpoch ||
    record.operation !== expected.operation ||
    record.sessionId !== expected.sessionId ||
    record.operationId !== expected.operationId ||
    !Object.hasOwn(record, 'payload') ||
    !Object.hasOwn(record, 'result')
  ) {
    throw new Error('Invalid message operation receipt');
  }
  return record as unknown as StoredMessageOperationReceipt;
}

interface PendingMessageAdmissionRow {
  readonly session_id?: unknown;
  readonly turn_id?: unknown;
  readonly run_id?: unknown;
  readonly message_id?: unknown;
  readonly content_json?: unknown;
  readonly model_content_json?: unknown;
  readonly submitted_placement?: unknown;
  readonly placement?: unknown;
  readonly disposition?: unknown;
  readonly queue_order?: unknown;
  readonly admitted_at?: unknown;
}

interface MessageAdmissionSettlementRow {
  readonly message_id?: unknown;
  readonly settlement?: unknown;
  readonly submitted_placement?: unknown;
  readonly submitted_content_digest?: unknown;
}

function decodeMessageAdmissionSettlementRow(
  row: MessageAdmissionSettlementRow,
): MessageAdmissionSettlement {
  if (
    typeof row.message_id !== 'string' ||
    row.settlement !== 'retracted' ||
    (row.submitted_placement !== null &&
      row.submitted_placement !== undefined &&
      row.submitted_placement !== 'current_turn' &&
      row.submitted_placement !== 'next_turn') ||
    (row.submitted_content_digest !== null &&
      row.submitted_content_digest !== undefined &&
      (typeof row.submitted_content_digest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(row.submitted_content_digest)))
  ) {
    throw new Error('Invalid SQLite Message admission settlement');
  }
  return {
    messageId: row.message_id,
    settlement: 'retracted',
    ...(row.submitted_placement ? { submittedPlacement: row.submitted_placement } : {}),
    ...(row.submitted_content_digest
      ? { submittedContentDigest: row.submitted_content_digest as `sha256:${string}` }
      : {}),
  };
}

export function normalizePendingMessageAdmission(
  admission: PendingMessageAdmission,
): PendingMessageAdmission {
  assertSafeId(admission.sessionId, 'Invalid Session identity');
  assertSafeId(admission.turnId, 'Invalid Turn identity');
  assertSafeId(admission.runId, 'Invalid Run identity');
  assertSafeId(admission.messageId, 'Invalid Message identity');
  if (
    (admission.submittedPlacement !== 'current_turn' &&
      admission.submittedPlacement !== 'next_turn') ||
    (admission.placement !== 'current_turn' && admission.placement !== 'next_turn') ||
    (admission.disposition !== 'steering' && admission.disposition !== 'followup') ||
    (admission.placement === 'current_turn') !== (admission.disposition === 'steering')
  ) {
    throw new Error('Invalid pending Message placement');
  }
  if (!Number.isSafeInteger(admission.admittedAt) || admission.admittedAt < 0) {
    throw new Error('Invalid message admission timestamp');
  }
  const normalized = Object.freeze({
    ...admission,
    content: normalizeMessageContent(admission.content),
    modelContent: normalizeMessageContent(admission.modelContent),
  });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > RECEIPT_MAX_BYTES) {
    throw new Error('Pending message admission exceeds size limit');
  }
  return normalized;
}

function decodePendingMessageAdmissionRow(
  row: PendingMessageAdmissionRow,
): PendingMessageAdmission {
  if (
    typeof row.session_id !== 'string' ||
    typeof row.turn_id !== 'string' ||
    typeof row.run_id !== 'string' ||
    typeof row.message_id !== 'string' ||
    typeof row.content_json !== 'string' ||
    typeof row.model_content_json !== 'string' ||
    (row.submitted_placement !== 'current_turn' && row.submitted_placement !== 'next_turn') ||
    (row.placement !== 'current_turn' && row.placement !== 'next_turn') ||
    (row.disposition !== 'steering' && row.disposition !== 'followup') ||
    typeof row.queue_order !== 'number' ||
    !Number.isSafeInteger(row.queue_order) ||
    row.queue_order < 0 ||
    typeof row.admitted_at !== 'number'
  ) {
    throw new Error('Invalid SQLite pending message admission');
  }
  return normalizePendingMessageAdmission({
    sessionId: row.session_id,
    turnId: row.turn_id,
    runId: row.run_id,
    messageId: row.message_id,
    content: JSON.parse(row.content_json),
    modelContent: JSON.parse(row.model_content_json),
    submittedPlacement: row.submitted_placement,
    placement: row.placement,
    disposition: row.disposition,
    admittedAt: row.admitted_at,
  });
}

export function readPendingMessageAdmission(
  db: DatabaseSync,
  sessionId: string,
  messageId: string,
): PendingMessageAdmission | undefined {
  const row = db
    .prepare(`
      SELECT session_id, turn_id, run_id, message_id, content_json, model_content_json,
        submitted_placement, placement, disposition, queue_order, admitted_at
      FROM core_message_admissions
      WHERE session_id = ? AND message_id = ?
    `)
    .get(sessionId, messageId) as PendingMessageAdmissionRow | undefined;
  return row ? decodePendingMessageAdmissionRow(row) : undefined;
}

export function samePendingMessageAdmission(
  left: PendingMessageAdmission,
  right: PendingMessageAdmission,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.messageId === right.messageId &&
    left.submittedPlacement === right.submittedPlacement &&
    messageContentsEqual(left.content, right.content) &&
    messageContentsEqual(left.modelContent, right.modelContent)
  );
}

function assertSafeId(value: string, message: string): void {
  if (!SAFE_ID_PATTERN.test(value)) throw new Error(message);
}
