/**
 * @file src/services/harness/sessions.ts
 * 文件职责：提供 Harness 会话持久化前的纯字段规范化与过期规则。
 * 主要内容：限制正文、上下文、问题和回答长度，校验动作/状态/时间与稳定 ID，并按 turn.createdAt 判断 30 天过期。
 * 模块边界：本文件不访问 IndexedDB、配置或模型；repository 负责事务、并发代次和存储生命周期。
 */
import type {HarnessActionId} from '@/src/core/config/harness';
import type {HarnessSession, HarnessStoredTurn, HarnessStoredTurnStatus} from './sessionTypes';
import {truncateUtf16} from '@/src/shared/function/truncateUtf16';

export const HARNESS_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const HARNESS_SESSION_TEXT_MAX = 4_096;
export const HARNESS_SESSION_CONTEXT_MAX = 4_000;
export const HARNESS_SESSION_QUESTION_MAX = 1_000;
export const HARNESS_SESSION_ANSWER_MAX = 16_000;

const ACTIONS = new Set<HarnessActionId>(['meaning', 'grammar', 'usage', 'practice']);
const STATUSES = new Set<HarnessStoredTurnStatus>(['streaming', 'completed', 'stopped', 'error']);

function boundedString(value: unknown, max: number, field: string, required = false, preservePair = true): string {
    if (typeof value !== 'string') {
        if (!required && value === undefined) return '';
        throw new TypeError(`Harness 会话 ${field} 必须是字符串`);
    }
    const normalized = value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').trim();
    if (required && !normalized) throw new TypeError(`Harness 会话 ${field} 不能为空`);
    return preservePair ? truncateUtf16(normalized, max) : normalized.slice(0, max);
}

function stableId(value: unknown, field: string): string {
    // ID 必须按原有代码单元切片后校验；不能因字符边界修复而接受旧版拒绝的非法 ID。
    const id = boundedString(value, 200, field, true, false);
    if (!/^[A-Za-z0-9._:-]+$/u.test(id)) throw new TypeError(`Harness 会话 ${field} 格式无效`);
    return id;
}

function timestamp(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`Harness 会话 ${field} 必须是非负有限数字`);
    }
    return Math.floor(value);
}

export function isHarnessSessionAction(value: unknown): value is HarnessActionId {
    return typeof value === 'string' && ACTIONS.has(value as HarnessActionId);
}

export function isHarnessStoredTurnStatus(value: unknown): value is HarnessStoredTurnStatus {
    return typeof value === 'string' && STATUSES.has(value as HarnessStoredTurnStatus);
}

export function normalizeHarnessStoredTurn(value: HarnessStoredTurn): HarnessStoredTurn {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Harness turn 必须是对象');
    if (!isHarnessSessionAction(value.intent)) throw new TypeError('Harness turn intent 无效');
    if (!isHarnessStoredTurnStatus(value.status)) throw new TypeError('Harness turn status 无效');
    return {
        id: stableId(value.id, 'turn.id'),
        question: boundedString(value.question, HARNESS_SESSION_QUESTION_MAX, 'turn.question'),
        answer: boundedString(value.answer, HARNESS_SESSION_ANSWER_MAX, 'turn.answer'),
        intent: value.intent,
        status: value.status,
        createdAt: timestamp(value.createdAt, 'turn.createdAt'),
        service: boundedString(value.service, 200, 'turn.service', value.status === 'completed'),
        model: boundedString(value.model, 200, 'turn.model', value.status === 'completed'),
    };
}

export function normalizeHarnessSession(value: Omit<HarnessSession, 'turns'> & {turns?: HarnessStoredTurn[]}): HarnessSession {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Harness 会话必须是对象');
    if (!isHarnessSessionAction(value.intent)) throw new TypeError('Harness 会话 intent 无效');
    return {
        id: stableId(value.id, 'id'),
        text: boundedString(value.text, HARNESS_SESSION_TEXT_MAX, 'text', true),
        context: boundedString(value.context, HARNESS_SESSION_CONTEXT_MAX, 'context'),
        createdAt: timestamp(value.createdAt, 'createdAt'),
        updatedAt: timestamp(value.updatedAt, 'updatedAt'),
        intent: value.intent,
        turns: (value.turns || []).map(normalizeHarnessStoredTurn),
    };
}

export function isHarnessTurnExpired(turn: HarnessStoredTurn, now: number): boolean {
    return turn.createdAt <= now - HARNESS_SESSION_TTL_MS;
}
