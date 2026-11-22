#!/usr/bin/env node
/** Validate metadata-only records, evidence files, and exact source/reference split isolation. */
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, 'expected lowercase SHA-256');
const sha1Schema = z.string().regex(/^[0-9a-f]{40}$/u, 'expected lowercase Git blob SHA-1');
const nullableSha256Schema = sha256Schema.nullable();

const segmentSchema = z.object({
    segment_id: z.string().min(1),
    ordinal_index: z.number().int().nonnegative(),
    structure_kind: z.string().min(1),
    content_kind_candidate: z.string().nullable(),
    content_kind_status: z.enum(['not_applicable', 'source_structure', 'pending_human_adjudication']),
    source_sha256: sha256Schema,
    reference_candidate_sha256: nullableSha256Schema,
}).strict();

const assetSchema = z.object({
    kind: z.literal('page_image'),
    path: z.string().min(1),
    sha256: sha256Schema,
    byte_size: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
}).strict();

const sourceLocatorSchema = z.object({
    url: z.string().url().nullable(),
    path: z.string().min(1).nullable(),
    repository_path: z.string().min(1).nullable(),
    repository_url: z.string().url().nullable(),
}).strict();

const referenceSchema = z.object({
    kind: z.enum(['official_localization_candidate', 'expert_translation', 'source_only']),
    status: z.enum(['pending_semantic_review', 'adjudicated', 'not_applicable']),
    url: z.string().url().nullable(),
    revision: z.string().min(1).nullable(),
    sha256: nullableSha256Schema,
    blob_sha1: sha1Schema.nullable(),
    alignment_status: z.string().min(1),
}).strict();

const rightsSchema = z.object({
    license_name: z.string().min(1),
    license_version: z.string().min(1).nullable(),
    license_scope: z.string().min(1),
    policy_evidence_status: z.enum([
        'current_policy_checked_pinned_revision_remote_unverified',
        'official_policy_and_item_page_checked',
        'provenance_recorded',
    ]),
    intended_use_scope: z.enum(['internal_evaluation_only', 'public_release', 'excluded']),
    intended_use_review_status: z.enum(['pending', 'provenance_recorded', 'approved_internal', 'approved_public', 'excluded']),
    public_distribution_status: z.enum(['not_approved', 'approved', 'not_applicable']),
    third_party_materials_status: z.enum([
        'none_declared_unverified', 'none_claimed_in_provenance', 'verified_absent', 'present_or_scope_unknown',
    ]),
    attribution: z.string().min(1),
    adaptation_terms: z.string().min(1),
    evidence_urls: z.array(z.string().url()),
    evidence_paths: z.array(z.string().min(1)),
    rights_reviewer: z.string().min(1).nullable(),
    rights_reviewed_at: z.string().datetime().nullable(),
}).strict();

const humanReviewSchema = z.object({
    status: z.enum(['pending', 'in_progress', 'complete', 'adjudicated']),
    required_independent_reviewers: z.number().int().min(2),
    completed_independent_reviewers: z.number().int().nonnegative(),
    adjudication_status: z.enum(['pending', 'not_needed', 'complete']),
    rubric_version: z.string().min(1).nullable(),
    review_scope: z.array(z.string().min(1)).min(1),
}).strict();

const translationRunEvidenceSchema = z.object({
    model_id: z.string().min(1),
    condition_label: z.string().min(1),
    replicate_index: z.number().int().positive(),
    segment_id: z.string().min(1).optional(),
    replicate_scope: z.enum(['source_unit', 'segment']).optional(),
    status: z.string().min(1),
    http_status: z.number().int().positive().nullable(),
    response_model: z.string().min(1).nullable(),
    prompt_sha256: sha256Schema.nullable(),
    translation_sha256: nullableSha256Schema,
    request_path: z.string().min(1),
    request_sha256: sha256Schema,
    response_path: z.string().min(1).nullable(),
    response_sha256: nullableSha256Schema,
    context_included: z.boolean(),
    context_sha256: nullableSha256Schema,
    image_uploaded: z.boolean().optional(),
}).strict();

const translationRunEvidenceSummarySchema = z.object({
    provider: z.string().min(1),
    results_path: z.string().min(1),
    results_sha256: sha256Schema,
    source_language_api_code: z.string().min(1),
    target_language_api_code: z.string().min(1),
    target_language_prompt_name: z.string().min(1),
    model_ids: z.array(z.string().min(1)),
    condition_labels: z.array(z.string().min(1)),
    run_count_for_unit: z.number().int().nonnegative(),
    repeats_per_model_condition: z.number().int().positive(),
    replicate_scope: z.enum(['source_unit', 'segment', 'mixed']).optional(),
    runs: z.array(translationRunEvidenceSchema),
    execution_status: z.enum(['not_started', 'planned', 'in_progress', 'complete']).optional(),
    planned_model_ids: z.array(z.string().min(1)).min(1).optional(),
    planned_condition_labels: z.array(z.string().min(1)).min(1).optional(),
    planned_run_count_for_unit: z.number().int().positive().optional(),
    run_design_evidence: z.array(z.object({
        kind: z.enum(['runner_script', 'results_configuration', 'study_manifest', 'attempt_diagnostics']),
        scope: z.enum(['cell_matrix', 'study_level']),
        path: z.string().min(1),
        sha256: sha256Schema,
    }).strict()).optional(),
    model_input_scope: z.string().min(1),
    scene_context_sha256: nullableSha256Schema,
    image_uploaded: z.boolean(),
}).strict();

export const benchmarkManifestRecordSchema = z.object({
    schema_version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    corpus_version: z.string().min(1),
    record_id: z.string().min(1),
    parent_document_id: z.string().min(1),
    document_id: z.string().min(1),
    source_unit_id: z.string().min(1),
    split_group_id: z.string().min(1),
    quality_unit: z.enum(['source_document', 'page']),
    source_id: z.string().min(1),
    track: z.enum(['technical_documentation', 'scientific_paper', 'manga', 'general_web', 'educational_document']),
    genre: z.string().min(1),
    source_language: z.string().min(1),
    target_language: z.string().min(1),
    source_locator: sourceLocatorSchema,
    source_revision: z.string().min(1),
    source_version: z.string().min(1).nullable(),
    captured_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    source_sha256: sha256Schema,
    source_blob_sha1: sha1Schema.nullable(),
    segments: z.array(segmentSchema).min(1),
    assets: z.array(assetSchema),
    reference: referenceSchema,
    rights: rightsSchema,
    human_review: humanReviewSchema,
    translation_run_evidence: translationRunEvidenceSummarySchema,
    split: z.enum(['train', 'dev', 'test', 'challenge']).nullable(),
    eligibility_status: z.enum(['candidate_only', 'eligible_internal', 'eligible_public', 'excluded']),
    candidate_source_record_path: z.string().min(1),
    candidate_source_record_sha256: sha256Schema,
    source_integrity_audit_path: z.string().min(1),
    source_integrity_audit_sha256: sha256Schema,
    raw_source_text_in_manifest: z.literal(false),
}).strict();

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function addIssue(issues, row, code, field = '') {
    issues.push({row, code, field});
}

function resolveWorkspacePath(workspaceRoot, relativePath) {
    if (path.isAbsolute(relativePath)) return null;
    const resolved = path.resolve(workspaceRoot, relativePath);
    const rel = path.relative(workspaceRoot, resolved);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
    return resolved;
}

function normalizeWorkspaceRelative(workspaceRoot, absolutePath) {
    const relative = path.relative(workspaceRoot, absolutePath);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join('/');
}

function verifyRunMatrix(record, resultsBytes, resultsPath, workspaceRoot, issues, checks, row) {
    let results;
    try {
        results = JSON.parse(resultsBytes.toString('utf8'));
    } catch {
        addIssue(issues, row, 'translation_results_invalid_json', 'translation_run_evidence.results_path');
        return;
    }
    const sourceRuns = (results.runs ?? []).filter(run => record.quality_unit !== 'page' || run.pageId === record.source_unit_id);
    const evidenceRuns = record.translation_run_evidence.runs;
    if (sourceRuns.length !== evidenceRuns.length) {
        addIssue(issues, row, 'run_matrix_count_differs_from_results', 'translation_run_evidence.runs');
    }

    const sourceCells = new Map();
    for (const run of sourceRuns) {
        const condition = run.condition ?? run.profileId;
        const resultDirectory = path.dirname(resultsPath);
        const requestPath = run.requestFile
            ? normalizeWorkspaceRelative(workspaceRoot, path.resolve(resultDirectory, run.requestFile))
            : null;
        const responsePath = run.responseFile
            ? normalizeWorkspaceRelative(workspaceRoot, path.resolve(resultDirectory, run.responseFile))
            : null;
        const key = JSON.stringify([run.modelId, condition, requestPath, responsePath]);
        sourceCells.set(key, run);
    }

    for (const run of evidenceRuns) {
        const key = JSON.stringify([run.model_id, run.condition_label, run.request_path, run.response_path]);
        const sourceRun = sourceCells.get(key);
        if (!sourceRun) {
            addIssue(issues, row, 'run_matrix_cell_missing_from_results', 'translation_run_evidence.runs');
            continue;
        }
        sourceCells.delete(key);
        const sourceTranslationHash = typeof sourceRun.translation === 'string' ? sha256(sourceRun.translation) : null;
        const matches = sourceRun.status === run.status
            && (sourceRun.httpStatus ?? null) === run.http_status
            && (sourceRun.responseModel ?? null) === run.response_model
            && (sourceRun.promptSha256 ?? null) === run.prompt_sha256
            && sourceTranslationHash === run.translation_sha256
            && Boolean(sourceRun.contextIncluded ?? false) === run.context_included
            && (sourceRun.sceneContextSha256 ?? null) === run.context_sha256
            && (run.image_uploaded === undefined || Boolean(sourceRun.imageUploaded ?? false) === run.image_uploaded);
        if (!matches) addIssue(issues, row, 'run_matrix_cell_metadata_mismatch', 'translation_run_evidence.runs');
        else checks.push({record_id: record.record_id, evidence: 'run_matrix_cell_metadata', hash_matches: true});
    }
    if (sourceCells.size) addIssue(issues, row, 'translation_results_contain_unrecorded_runs', 'translation_run_evidence.runs');
}

async function verifyFileEvidence(records, workspaceRoot, issues) {
    const checks = [];
    for (const [index, record] of records.entries()) {
        const row = index + 1;
        for (const [field, expectedHash] of [
            ['candidate_source_record_path', record.candidate_source_record_sha256],
            ['source_integrity_audit_path', record.source_integrity_audit_sha256],
            [null, record.translation_run_evidence.results_sha256],
        ]) {
            const relativePath = field === null
                ? record.translation_run_evidence.results_path
                : record[field];
            const abs = resolveWorkspacePath(workspaceRoot, relativePath);
            if (abs === null) {
                addIssue(issues, row, 'evidence_path_escapes_workspace', field ?? 'translation_run_evidence.results_path');
                continue;
            }
            let contents;
            try {
                contents = await readFile(abs);
            } catch {
                addIssue(issues, row, 'evidence_file_missing', field ?? 'translation_run_evidence.results_path');
                continue;
            }
            const actualHash = sha256(contents);
            if (actualHash !== expectedHash) addIssue(issues, row, 'evidence_file_hash_mismatch', field ?? 'translation_run_evidence.results_path');
            if (field === null) verifyRunMatrix(record, contents, abs, workspaceRoot, issues, checks, row);
            if (field === 'source_integrity_audit_path') {
                try {
                    const audit = JSON.parse(contents.toString('utf8'));
                    if (audit.integrity_status !== 'verified' || audit.integrity_error_count !== 0) {
                        addIssue(issues, row, 'source_integrity_audit_not_verified', field);
                    }
                    const sourceAuditRecord = (audit.candidates ?? []).find(candidate =>
                        candidate.track === record.track
                        && candidate.candidate_file_sha256 === record.candidate_source_record_sha256
                        && candidate.results_file_sha256 === record.translation_run_evidence.results_sha256);
                    if (!sourceAuditRecord) {
                        addIssue(issues, row, 'source_integrity_audit_does_not_cover_artifacts', field);
                    } else {
                        const auditedSourceHash = record.quality_unit === 'page'
                            ? sourceAuditRecord.manga_page_source_sha256_by_id?.[record.source_unit_id]
                            : sourceAuditRecord.source_content_sha256;
                        if (auditedSourceHash !== record.source_sha256) {
                            addIssue(issues, row, 'manifest_source_hash_differs_from_integrity_audit', 'source_sha256');
                        } else {
                            checks.push({record_id: record.record_id, evidence: 'source_text_hash', hash_matches: true});
                        }
                    }
                } catch {
                    addIssue(issues, row, 'source_integrity_audit_invalid_json', field);
                }
            }
            checks.push({record_id: record.record_id, evidence: field ?? 'translation_results', hash_matches: actualHash === expectedHash});
        }
        for (const run of record.translation_run_evidence.runs) {
            for (const [evidence, relativePath, expectedHash] of [
                ['run_request', run.request_path, run.request_sha256],
                ['run_response', run.response_path, run.response_sha256],
            ]) {
                if (relativePath === null) {
                    if (expectedHash !== null) {
                        addIssue(issues, row, 'run_artifact_hash_without_path', 'translation_run_evidence.runs.' + evidence);
                    }
                    continue;
                }
                if (expectedHash === null) {
                    addIssue(issues, row, 'run_artifact_path_without_hash', 'translation_run_evidence.runs.' + evidence);
                    continue;
                }
                const abs = resolveWorkspacePath(workspaceRoot, relativePath);
                if (abs === null) {
                    addIssue(issues, row, 'run_artifact_path_escapes_workspace', 'translation_run_evidence.runs.' + evidence);
                    continue;
                }
                try {
                    const bytes = await readFile(abs);
                    const matches = sha256(bytes) === expectedHash;
                    if (!matches) addIssue(issues, row, 'run_artifact_hash_mismatch', 'translation_run_evidence.runs.' + evidence);
                    else checks.push({record_id: record.record_id, evidence, hash_matches: true});
                } catch {
                    addIssue(issues, row, 'run_artifact_file_missing', 'translation_run_evidence.runs.' + evidence);
                }
            }
        }
        for (const evidence of record.translation_run_evidence.run_design_evidence ?? []) {
            const abs = resolveWorkspacePath(workspaceRoot, evidence.path);
            if (abs === null) {
                addIssue(issues, row, 'run_design_evidence_path_escapes_workspace', 'translation_run_evidence.run_design_evidence.path');
                continue;
            }
            try {
                const bytes = await readFile(abs);
                const matches = sha256(bytes) === evidence.sha256;
                if (!matches) addIssue(issues, row, 'run_design_evidence_hash_mismatch', 'translation_run_evidence.run_design_evidence.sha256');
                else checks.push({record_id: record.record_id, evidence: 'run_design:' + evidence.kind, scope: evidence.scope, hash_matches: true});
            } catch {
                addIssue(issues, row, 'run_design_evidence_file_missing', 'translation_run_evidence.run_design_evidence.path');
            }
        }
        for (const asset of record.assets) {
            const abs = resolveWorkspacePath(workspaceRoot, asset.path);
            if (abs === null) {
                addIssue(issues, row, 'asset_path_escapes_workspace', 'assets.path');
                continue;
            }
            try {
                const bytes = await readFile(abs);
                if (sha256(bytes) !== asset.sha256) addIssue(issues, row, 'asset_hash_mismatch', 'assets.sha256');
                if (bytes.byteLength !== asset.byte_size) addIssue(issues, row, 'asset_size_mismatch', 'assets.byte_size');
                checks.push({record_id: record.record_id, evidence: 'asset:' + asset.kind, hash_matches: sha256(bytes) === asset.sha256});
            } catch {
                addIssue(issues, row, 'asset_file_missing', 'assets.path');
            }
        }
        if (record.source_locator.path !== null) {
            const abs = resolveWorkspacePath(workspaceRoot, record.source_locator.path);
            if (abs === null || !abs.startsWith(workspaceRoot + path.sep)) {
                addIssue(issues, row, 'source_locator_escapes_workspace', 'source_locator.path');
            } else {
                try {
                    await readFile(abs);
                } catch {
                    addIssue(issues, row, 'source_locator_file_missing', 'source_locator.path');
                }
            }
        }
    }
    return checks;
}

function inspectRunDesign(record, row, issues) {
    const evidence = record.translation_run_evidence;
    const executionStatus = evidence.execution_status ?? (evidence.runs.length ? 'complete' : 'not_started');
    const explicitPlanDeclared = evidence.planned_model_ids !== undefined
        && evidence.planned_condition_labels !== undefined
        && evidence.planned_run_count_for_unit !== undefined;
    const notStartedWithoutPlan = executionStatus === 'not_started'
        && evidence.runs.length === 0
        && evidence.run_count_for_unit === 0
        && evidence.model_ids.length === 0
        && evidence.condition_labels.length === 0
        && evidence.planned_model_ids === undefined
        && evidence.planned_condition_labels === undefined
        && evidence.planned_run_count_for_unit === undefined;
    const plannedModelIds = evidence.planned_model_ids ?? evidence.model_ids;
    const plannedConditions = evidence.planned_condition_labels ?? evidence.condition_labels;
    const plannedRunCount = evidence.planned_run_count_for_unit ?? evidence.run_count_for_unit;
    const modelIds = [...new Set(evidence.runs.map(run => run.model_id))].sort();
    const conditions = [...new Set(evidence.runs.map(run => run.condition_label))].sort();
    const defaultScope = evidence.replicate_scope === 'mixed' ? null : evidence.replicate_scope;
    const scopeForRun = run => run.replicate_scope ?? defaultScope ?? (run.segment_id ? 'segment' : (evidence.replicate_scope === 'mixed' ? null : 'source_unit'));
    const scopesByCondition = new Map(conditions.map(condition => [condition, new Set()]));
    for (const run of evidence.runs) scopesByCondition.get(run.condition_label).add(scopeForRun(run));
    const scopeByCondition = new Map();
    for (const [condition, scopes] of scopesByCondition) {
        if (scopes.size !== 1 || scopes.has(null)) {
            addIssue(issues, row, 'condition_replicate_scope_is_ambiguous', 'translation_run_evidence.runs.replicate_scope');
        } else scopeByCondition.set(condition, [...scopes][0]);
    }
    const recordSegmentIds = new Set(record.segments.map(segment => segment.segment_id));
    for (const run of evidence.runs) {
        const scope = scopeForRun(run);
        if (scope === 'segment' && !run.segment_id) {
            addIssue(issues, row, 'segment_scoped_run_missing_segment_id', 'translation_run_evidence.runs.segment_id');
        }
        if (scope === 'source_unit' && run.segment_id) {
            addIssue(issues, row, 'run_segment_id_requires_segment_replicate_scope', 'translation_run_evidence.runs.replicate_scope');
        }
        if (run.segment_id && !recordSegmentIds.has(run.segment_id)) {
            addIssue(issues, row, 'run_segment_not_in_record', 'translation_run_evidence.runs.segment_id');
        }
        if (run.response_path === null) {
            if (run.response_sha256 !== null) {
                addIssue(issues, row, 'response_hash_without_response_artifact', 'translation_run_evidence.runs.response_sha256');
            }
            if (run.http_status !== null || run.response_model !== null) {
                addIssue(issues, row, 'response_metadata_without_http_response', 'translation_run_evidence.runs.response_path');
            }
            if (run.translation_sha256 !== null || run.status === 'translated') {
                addIssue(issues, row, 'translation_output_without_http_response', 'translation_run_evidence.runs.translation_sha256');
            }
        } else if (run.response_sha256 === null) {
            addIssue(issues, row, 'response_artifact_missing_hash', 'translation_run_evidence.runs.response_sha256');
        }
    }
    const normalizedOutcomeCounts = Object.create(null);
    for (const run of evidence.runs) {
        const outcome = normalizeRunOutcome(run);
        normalizedOutcomeCounts[outcome] = (normalizedOutcomeCounts[outcome] ?? 0) + 1;
    }
    if (JSON.stringify(modelIds) !== JSON.stringify([...evidence.model_ids].sort())) {
        addIssue(issues, row, 'run_matrix_models_differ_from_declared_models', 'translation_run_evidence.model_ids');
    }
    if (JSON.stringify(conditions) !== JSON.stringify([...evidence.condition_labels].sort())) {
        addIssue(issues, row, 'run_matrix_conditions_differ_from_declared_conditions', 'translation_run_evidence.condition_labels');
    }
    if (evidence.runs.length !== evidence.run_count_for_unit) {
        addIssue(issues, row, 'run_matrix_count_differs_from_declared_count', 'translation_run_evidence.run_count_for_unit');
    }
    if (new Set(plannedModelIds).size !== plannedModelIds.length) {
        addIssue(issues, row, 'planned_model_ids_must_be_unique', 'translation_run_evidence.planned_model_ids');
    }
    if (new Set(plannedConditions).size !== plannedConditions.length) {
        addIssue(issues, row, 'planned_condition_labels_must_be_unique', 'translation_run_evidence.planned_condition_labels');
    }
    if (modelIds.some(modelId => !plannedModelIds.includes(modelId))) {
        addIssue(issues, row, 'executed_models_not_in_planned_matrix', 'translation_run_evidence.planned_model_ids');
    }
    if (conditions.some(condition => !plannedConditions.includes(condition))) {
        addIssue(issues, row, 'executed_conditions_not_in_planned_matrix', 'translation_run_evidence.planned_condition_labels');
    }
    if (evidence.run_count_for_unit > plannedRunCount) {
        addIssue(issues, row, 'executed_run_count_exceeds_plan', 'translation_run_evidence.planned_run_count_for_unit');
    }
    if (evidence.execution_status === 'planned' && evidence.runs.length !== 0) {
        addIssue(issues, row, 'planned_matrix_must_not_contain_runs', 'translation_run_evidence.execution_status');
    }
    if (evidence.execution_status === 'not_started' && evidence.runs.length !== 0) {
        addIssue(issues, row, 'not_started_matrix_must_not_contain_runs', 'translation_run_evidence.execution_status');
    }
    if (evidence.execution_status === 'in_progress'
        && (evidence.runs.length === 0 || evidence.runs.length >= plannedRunCount)) {
        addIssue(issues, row, 'in_progress_matrix_has_inconsistent_run_count', 'translation_run_evidence.execution_status');
    }
    if (evidence.execution_status === 'complete' && evidence.runs.length !== plannedRunCount) {
        addIssue(issues, row, 'complete_matrix_run_count_differs_from_plan', 'translation_run_evidence.execution_status');
    }
    if (evidence.execution_status && evidence.execution_status !== 'not_started'
        && plannedModelIds.length === 0) {
        addIssue(issues, row, 'planned_matrix_requires_models', 'translation_run_evidence.planned_model_ids');
    }
    if (evidence.execution_status && evidence.execution_status !== 'not_started'
        && plannedConditions.length === 0) {
        addIssue(issues, row, 'planned_matrix_requires_conditions', 'translation_run_evidence.planned_condition_labels');
    }
    if (evidence.execution_status && evidence.execution_status !== 'not_started'
        && evidence.planned_run_count_for_unit === undefined) {
        addIssue(issues, row, 'execution_status_requires_planned_run_count', 'translation_run_evidence.planned_run_count_for_unit');
    }
    if (evidence.planned_run_count_for_unit !== undefined
        && plannedModelIds.length > 0
        && plannedConditions.length > 0
        && evidence.replicate_scope !== 'mixed') {
        const plannedUnitsPerCondition = evidence.replicate_scope === 'segment' ? record.segments.length : 1;
        const expectedPlannedCount = plannedModelIds.length
            * plannedConditions.length
            * plannedUnitsPerCondition
            * evidence.repeats_per_model_condition;
        if (plannedRunCount !== expectedPlannedCount) {
            addIssue(issues, row, 'planned_run_count_does_not_match_matrix_dimensions', 'translation_run_evidence.planned_run_count_for_unit');
        }
    }

    const cells = new Map();
    const coverageByModel = Object.fromEntries(modelIds.map(modelId => [modelId, []]));
    let successfulCellCount = 0;
    let failedCellCount = 0;
    for (const run of evidence.runs) {
        const hasSuccessfulTranslation = run.status === 'translated' && run.http_status === 200;
        const hasTranslationHash = run.translation_sha256 !== null;
        if (hasSuccessfulTranslation !== hasTranslationHash) {
            addIssue(issues, row, 'run_translation_hash_status_mismatch', 'translation_run_evidence.runs.translation_sha256');
        }
        if (record.schema_version === 1 && !hasSuccessfulTranslation) {
            addIssue(issues, row, 'legacy_manifest_run_must_be_successful', 'translation_run_evidence.runs.status');
        }
        if (hasSuccessfulTranslation) successfulCellCount += 1;
        else failedCellCount += 1;
        const cell = JSON.stringify([run.model_id, run.condition_label, scopeForRun(run) === 'segment' ? (run.segment_id ?? null) : null]);
        const replicates = cells.get(cell) ?? [];
        replicates.push(run.replicate_index);
        cells.set(cell, replicates);
        coverageByModel[run.model_id].push(run.condition_label);
    }
    for (const [cell, replicates] of cells) {
        replicates.sort((a, b) => a - b);
        if (replicates.length > evidence.repeats_per_model_condition) {
            addIssue(issues, row, 'run_matrix_exceeds_declared_repeats', 'translation_run_evidence.runs');
        }
        if (replicates.some((replicate, index) => replicate !== index + 1)) {
            addIssue(issues, row, 'run_matrix_replicates_not_contiguous', 'translation_run_evidence.runs');
        }
    }
    for (const modelId of modelIds) coverageByModel[modelId].sort();

    const modelsByCondition = new Map(conditions.map(condition => [condition, new Set()]));
    for (const run of evidence.runs) modelsByCondition.get(run.condition_label).add(run.model_id);
    const expectedCells = new Set();
    for (const modelId of plannedModelIds) {
        for (const condition of plannedConditions) {
            const replicateScope = scopeByCondition.get(condition) ?? defaultScope;
            const segmentIds = replicateScope === 'segment'
                ? record.segments.map(segment => segment.segment_id).sort()
                : [null];
            for (const segmentId of segmentIds) expectedCells.add(JSON.stringify([modelId, condition, segmentId]));
        }
    }
    const plannedScopeByCondition = new Map(plannedConditions.map(condition => [
        condition,
        scopeByCondition.get(condition) ?? defaultScope,
    ]));
    const uniqueScopes = new Set(plannedScopeByCondition.values());
    const segmentScoped = uniqueScopes.size === 1 && uniqueScopes.has('segment');
    const sourceUnitScoped = uniqueScopes.size === 1 && uniqueScopes.has('source_unit');
    return {
        record_id: record.record_id,
        track: record.track,
        model_ids: modelIds,
        condition_labels: conditions,
        execution_status: executionStatus,
        execution_status_basis: evidence.execution_status !== undefined ? 'declared' : (evidence.runs.length ? 'inferred_from_run_presence' : 'default_not_started'),
        explicit_plan_declared: explicitPlanDeclared,
        plan_declaration_status: explicitPlanDeclared ? 'explicit' : (notStartedWithoutPlan ? 'not_started_no_plan' : 'legacy_plan_not_recorded'),
        planned_run_count_basis: evidence.planned_run_count_for_unit !== undefined ? 'declared_plan' : (evidence.run_count_for_unit > 0 ? 'observed_run_count_fallback' : 'not_declared'),
        planned_model_ids: plannedModelIds,
        planned_condition_labels: plannedConditions,
        planned_run_count_for_unit: plannedRunCount,
        segment_scoped: segmentScoped,
        mixed_granularity: uniqueScopes.size > 1,
        replicate_scope_by_condition: Object.fromEntries(scopeByCondition),
        segment_count: segmentScoped ? record.segments.length : null,
        segment_ids: segmentScoped ? record.segments.map(segment => segment.segment_id).sort() : null,
        source_unit_scoped: sourceUnitScoped,
        run_cell_count: evidence.runs.length,
        normalized_run_outcome_counts: normalizedOutcomeCounts,
        complete_factorial: expectedCells.size > 0 && expectedCells.size === cells.size && [...expectedCells].every(cell => cells.has(cell)),
        successful_translation_cell_count: successfulCellCount,
        failed_cell_count: failedCellCount,
        all_cells_successful: failedCellCount === 0,
        cross_model_conditions: conditions.filter(condition => modelsByCondition.get(condition).size > 1),
        single_model_conditions: conditions.filter(condition => modelsByCondition.get(condition).size === 1),
        coverage_by_model: coverageByModel,
        declared_repeats_per_model_condition: evidence.repeats_per_model_condition,
    };
}

function normalizeRunOutcome(run) {
    if (run.http_status !== null && run.http_status !== 200) return 'provider_http_error';
    if (run.http_status === null && ['network-error', 'network_error'].includes(run.status)) return 'network_transport_error';
    if (run.status === 'translated' && run.http_status === 200 && run.translation_sha256 !== null) return 'translation_output_available';
    if (run.http_status === 200 && run.status === 'invalid_response_structure') return 'response_structure_error';
    if (run.http_status === 200 && ['invalid-response', 'invalid_response', 'invalid_response_payload'].includes(run.status)) return 'response_parse_error';
    return 'unclassified_run_state';
}

function validateCrossRecordRules(records, issues) {
    const ids = new Map();
    const docs = new Map();
    const splitGroups = new Map();
    const splitGroupRows = new Map();
    const sourceHashes = new Map();
    const segmentHashes = new Map();
    const referenceHashes = new Map();
    const segmentReferenceHashes = new Map();
    let eligibleCount = 0;
    const readiness = [];
    const runDesignByRecord = [];

    records.forEach((record, index) => {
        const row = index + 1;
        runDesignByRecord.push(inspectRunDesign(record, row, issues));
        if (ids.has(record.record_id)) addIssue(issues, row, 'duplicate_record_id', 'record_id');
        else ids.set(record.record_id, row);
        if (docs.has(record.document_id)) addIssue(issues, row, 'duplicate_document_id', 'document_id');
        else docs.set(record.document_id, row);

        const groupSplits = splitGroups.get(record.split_group_id) ?? new Set();
        if (record.split !== null) groupSplits.add(record.split);
        splitGroups.set(record.split_group_id, groupSplits);
        if (!splitGroupRows.has(record.split_group_id)) splitGroupRows.set(record.split_group_id, row);
        const hashRecords = sourceHashes.get(record.source_sha256) ?? [];
        hashRecords.push(record);
        sourceHashes.set(record.source_sha256, hashRecords);
        if (record.reference.sha256 !== null) {
            const referenceHashRecords = referenceHashes.get(record.reference.sha256) ?? [];
            referenceHashRecords.push(record);
            referenceHashes.set(record.reference.sha256, referenceHashRecords);
        }

        const segmentIds = record.segments.map(segment => segment.segment_id);
        if (new Set(segmentIds).size !== segmentIds.length) addIssue(issues, row, 'duplicate_segment_id', 'segments');
        for (const segment of record.segments) {
            const segmentHashRows = segmentHashes.get(segment.source_sha256) ?? [];
            segmentHashRows.push({
                record_id: record.record_id,
                segment_id: segment.segment_id,
                split: record.split,
                split_group_id: record.split_group_id,
                source_unit_id: record.source_unit_id,
            });
            segmentHashes.set(segment.source_sha256, segmentHashRows);
            if (segment.reference_candidate_sha256 !== null) {
                const segmentReferenceHashRows = segmentReferenceHashes.get(segment.reference_candidate_sha256) ?? [];
                segmentReferenceHashRows.push({
                    record_id: record.record_id,
                    segment_id: segment.segment_id,
                    split: record.split,
                    split_group_id: record.split_group_id,
                    source_unit_id: record.source_unit_id,
                });
                segmentReferenceHashes.set(segment.reference_candidate_sha256, segmentReferenceHashRows);
            }
        }
        if (record.source_locator.url === null && record.source_locator.path === null) {
            addIssue(issues, row, 'source_location_missing', 'source_locator');
        }
        const assetPaths = record.assets.map(asset => asset.path);
        if (new Set(assetPaths).size !== assetPaths.length) addIssue(issues, row, 'duplicate_asset_path', 'assets');
        for (const assetPath of assetPaths) {
            if (path.isAbsolute(assetPath) || assetPath.split(/[\\/]/u).includes('..')) {
                addIssue(issues, row, 'asset_path_must_be_relative_and_contained', 'assets.path');
            }
        }

        if (record.reference.kind === 'source_only') {
            if (record.reference.url !== null || record.reference.sha256 !== null) {
                addIssue(issues, row, 'source_only_reference_must_not_claim_target', 'reference');
            }
        } else if (record.reference.url === null || record.reference.sha256 === null) {
            addIssue(issues, row, 'reference_candidate_requires_url_and_hash', 'reference');
        }
        if (record.rights.evidence_urls.length === 0 && record.rights.evidence_paths.length === 0) {
            addIssue(issues, row, 'rights_evidence_missing', 'rights');
        }
        if (['approved_internal', 'approved_public'].includes(record.rights.intended_use_review_status)
            && (!record.rights.rights_reviewer || !record.rights.rights_reviewed_at)) {
            addIssue(issues, row, 'approved_rights_status_requires_reviewer_and_time', 'rights');
        }
        if (record.human_review.status === 'adjudicated'
            && (record.human_review.completed_independent_reviewers < record.human_review.required_independent_reviewers
                || record.human_review.adjudication_status !== 'complete')) {
            addIssue(issues, row, 'adjudicated_review_missing_double_review_or_outcome', 'human_review');
        }
        // 漫画视觉页必须有页图；纯文字脚本候选可按 source_document 统计，但不得冒充页级视觉样本。
        if (record.track === 'manga' && record.quality_unit === 'page' && record.assets.length === 0) {
            addIssue(issues, row, 'manga_page_requires_page_asset', 'quality_unit');
        }
        if (record.track === 'manga' && record.quality_unit === 'source_document' && record.genre !== 'comic_text_source') {
            addIssue(issues, row, 'manga_document_unit_requires_comic_text_source_genre', 'genre');
        }
        if (record.track === 'educational_document' && record.quality_unit !== 'source_document') {
            addIssue(issues, row, 'educational_document_requires_document_unit', 'quality_unit');
        }
        if (!['manga', 'educational_document'].includes(record.track) && record.quality_unit !== 'source_document') {
            addIssue(issues, row, 'document_track_requires_document_unit', 'quality_unit');
        }
        const runImageFlags = record.translation_run_evidence.runs.map(run => run.image_uploaded);
        const hasPerRunImageFlags = runImageFlags.some(flag => flag !== undefined);
        if (hasPerRunImageFlags && runImageFlags.some(flag => flag === undefined)) {
            addIssue(issues, row, 'run_image_upload_flags_incomplete', 'translation_run_evidence.runs.image_uploaded');
        }
        if (hasPerRunImageFlags) {
            const anyImageUploaded = runImageFlags.some(flag => flag === true);
            if (record.translation_run_evidence.image_uploaded !== anyImageUploaded) {
                addIssue(issues, row, 'run_image_upload_summary_mismatch', 'translation_run_evidence.image_uploaded');
            }
            if (anyImageUploaded && !record.assets.some(asset => asset.kind === 'page_image')) {
                addIssue(issues, row, 'image_uploaded_without_page_asset', 'translation_run_evidence.runs.image_uploaded');
            }
        }

        const blockers = [];
        const internalUsePermitted = record.rights.intended_use_review_status === 'approved_internal'
            || (record.rights.intended_use_review_status === 'provenance_recorded'
                && record.rights.intended_use_scope === 'internal_evaluation_only');
        if (!internalUsePermitted) {
            blockers.push('intended_use_not_approved');
        }
        if (record.human_review.status !== 'adjudicated'
            || record.human_review.completed_independent_reviewers < record.human_review.required_independent_reviewers
            || record.human_review.adjudication_status === 'pending') {
            blockers.push('independent_human_review_or_adjudication_pending');
        }
        if (record.split === null) blockers.push('split_not_assigned');
        const runExecutionStatus = record.translation_run_evidence.execution_status
            ?? (record.translation_run_evidence.runs.length ? 'complete' : 'not_started');
        const hasExplicitRunPlan = record.translation_run_evidence.planned_model_ids !== undefined
            && record.translation_run_evidence.planned_condition_labels !== undefined
            && record.translation_run_evidence.planned_run_count_for_unit !== undefined;
        const notStartedWithoutPlan = runExecutionStatus === 'not_started'
            && record.translation_run_evidence.runs.length === 0
            && record.translation_run_evidence.run_count_for_unit === 0
            && record.translation_run_evidence.model_ids.length === 0
            && record.translation_run_evidence.condition_labels.length === 0
            && record.translation_run_evidence.planned_model_ids === undefined
            && record.translation_run_evidence.planned_condition_labels === undefined
            && record.translation_run_evidence.planned_run_count_for_unit === undefined;
        if (notStartedWithoutPlan) blockers.push('translation_experiment_not_started');
        else {
            if (!hasExplicitRunPlan) blockers.push('translation_run_plan_not_explicit');
            if (runExecutionStatus !== 'complete') blockers.push('translation_run_matrix_not_complete');
        }
        if (record.translation_run_evidence.runs.some(run => run.status !== 'translated' || run.http_status !== 200)) {
            blockers.push('translation_run_matrix_has_failed_cells');
        }
        if (record.track === 'manga' && record.segments.some(segment => segment.content_kind_status === 'pending_human_adjudication')) {
            blockers.push('manga_region_labels_pending');
        }
        const referenceLimits = [];
        if (record.reference.status === 'pending_semantic_review') {
            referenceLimits.push('official_localization_not_adjudicated_as_a_semantic_reference');
        }
        if (record.reference.kind === 'source_only') {
            referenceLimits.push('no_target_reference_for_reference_based_metrics');
        }
        if (record.eligibility_status === 'eligible_internal') {
            if (blockers.length) addIssue(issues, row, 'internal_eligibility_claimed_with_open_gates', 'eligibility_status');
            else eligibleCount += 1;
        }
        if (record.eligibility_status === 'eligible_public'
            && (blockers.length || record.rights.intended_use_review_status !== 'approved_public'
                || record.rights.intended_use_scope !== 'public_release'
                || record.rights.public_distribution_status !== 'approved')) {
            addIssue(issues, row, 'public_eligibility_claimed_with_open_gates', 'eligibility_status');
        }
        readiness.push({
            record_id: record.record_id,
            track: record.track,
            internal_benchmark_blockers: blockers,
            reference_metric_limitations: referenceLimits,
        });
    });

    for (const [groupId, groupSplits] of splitGroups) {
        if (groupSplits.size > 1) addIssue(issues, splitGroupRows.get(groupId), 'split_group_crosses_partitions', 'split_group_id');
    }
    const duplicateSourceHashGroups = [...sourceHashes.entries()]
        .filter(([, hashRecords]) => hashRecords.length > 1)
        .map(([source_sha256, hashRecords]) => ({
            source_sha256,
            record_ids: hashRecords.map(record => record.record_id),
            split_group_ids: [...new Set(hashRecords.map(record => record.split_group_id))],
            assigned_splits: [...new Set(hashRecords.map(record => record.split).filter(Boolean))],
            unassigned_occurrences: hashRecords.filter(record => record.split === null).length,
        }));
    for (const group of duplicateSourceHashGroups) {
        if (group.assigned_splits.length > 1) {
            addIssue(issues, 0, 'duplicate_source_content_crosses_splits', 'source_sha256');
        }
    }
    const duplicateReferenceHashGroups = [...referenceHashes.entries()]
        .filter(([, hashRecords]) => hashRecords.length > 1)
        .map(([reference_sha256, hashRecords]) => ({
            reference_sha256,
            record_ids: hashRecords.map(record => record.record_id),
            split_group_ids: [...new Set(hashRecords.map(record => record.split_group_id))],
            assigned_splits: [...new Set(hashRecords.map(record => record.split).filter(Boolean))],
            unassigned_occurrences: hashRecords.filter(record => record.split === null).length,
        }));
    for (const group of duplicateReferenceHashGroups) {
        if (group.assigned_splits.length > 1) {
            addIssue(issues, 0, 'duplicate_reference_content_crosses_splits', 'reference.sha256');
        }
    }
    const duplicateSegmentHashGroups = [...segmentHashes.entries()]
        .filter(([, segmentRows]) => segmentRows.length > 1)
        .map(([source_sha256, segmentRows]) => ({
            source_sha256,
            record_ids: [...new Set(segmentRows.map(segment => segment.record_id))],
            segment_ids: segmentRows.map(segment => segment.segment_id),
            split_group_ids: [...new Set(segmentRows.map(segment => segment.split_group_id))],
            assigned_splits: [...new Set(segmentRows.map(segment => segment.split).filter(Boolean))],
            unassigned_occurrences: segmentRows.filter(segment => segment.split === null).length,
            occurrences: segmentRows.length,
        }));
    for (const group of duplicateSegmentHashGroups) {
        if (group.assigned_splits.length > 1) {
            const row = ids.get(group.record_ids[0]) ?? 0;
            addIssue(issues, row, 'duplicate_segment_content_crosses_splits', 'segments.source_sha256');
        }
    }
    const duplicateSegmentReferenceHashGroups = [...segmentReferenceHashes.entries()]
        .filter(([, segmentRows]) => segmentRows.length > 1)
        .map(([reference_candidate_sha256, segmentRows]) => ({
            reference_candidate_sha256,
            record_ids: [...new Set(segmentRows.map(segment => segment.record_id))],
            segment_ids: segmentRows.map(segment => segment.segment_id),
            split_group_ids: [...new Set(segmentRows.map(segment => segment.split_group_id))],
            assigned_splits: [...new Set(segmentRows.map(segment => segment.split).filter(Boolean))],
            unassigned_occurrences: segmentRows.filter(segment => segment.split === null).length,
            occurrences: segmentRows.length,
        }));
    for (const group of duplicateSegmentReferenceHashGroups) {
        if (group.assigned_splits.length > 1) {
            const row = ids.get(group.record_ids[0]) ?? 0;
            addIssue(issues, row, 'duplicate_reference_segment_content_crosses_splits', 'segments.reference_candidate_sha256');
        }
    }
    const pendingUnassignedSourceHashGroups = [
        ...duplicateSourceHashGroups,
        ...duplicateSegmentHashGroups,
    ].filter(group => group.unassigned_occurrences > 0 && group.assigned_splits.length > 0);
    const pendingUnassignedReferenceHashGroups = [
        ...duplicateReferenceHashGroups,
        ...duplicateSegmentReferenceHashGroups,
    ].filter(group => group.unassigned_occurrences > 0 && group.assigned_splits.length > 0);
    return {
        eligibleCount,
        readiness,
        duplicateSourceHashGroups,
        duplicateSegmentHashGroups,
        duplicateReferenceHashGroups,
        duplicateSegmentReferenceHashGroups,
        pendingUnassignedSourceHashGroups,
        pendingUnassignedReferenceHashGroups,
        runDesignByRecord,
    };
}

function parseArgs(argv) {
    const args = {manifest: null, output: null, schemaOutput: null};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--output') args.output = argv[++index];
        else if (arg === '--schema-output') args.schemaOutput = argv[++index];
        else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        else if (args.manifest === null) args.manifest = arg;
        else throw new Error('Only one JSONL manifest is supported.');
    }
    if (!args.manifest) throw new Error('Usage: node scripts/quality/validate-benchmark-manifest.mjs <manifest.jsonl> [--output report.json] [--schema-output schema.json]');
    return args;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(args.manifest);
const manifestText = await readFile(manifestPath, 'utf8');
const lines = manifestText.split(/\r?\n/u);
const issues = [];
const records = [];
for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let value;
    try {
        value = JSON.parse(lines[index]);
    } catch {
        addIssue(issues, index + 1, 'invalid_jsonl_record', '');
        continue;
    }
    const parsed = benchmarkManifestRecordSchema.safeParse(value);
    if (!parsed.success) {
        for (const error of parsed.error.issues) addIssue(issues, index + 1, 'schema_' + error.code, error.path.join('.'));
        continue;
    }
    records.push(parsed.data);
}

const cross = validateCrossRecordRules(records, issues);
const workspaceRoot = path.resolve(path.dirname(manifestPath), '../../..');
const fileEvidenceChecks = await verifyFileEvidence(records, workspaceRoot, issues);
const validatorSha256 = sha256(await readFile(new URL(import.meta.url)));
const trackCounts = Object.create(null);
const unitCounts = Object.create(null);
const runPlanDeclarationCounts = Object.create(null);
for (const design of cross.runDesignByRecord) {
    const label = design.plan_declaration_status;
    runPlanDeclarationCounts[label] = (runPlanDeclarationCounts[label] ?? 0) + 1;
}
const unassignedGroups = new Set();
const rawRunStatusCounts = Object.create(null);
const normalizedRunOutcomeCounts = Object.create(null);
const normalizedRunOutcomeCountsByTrack = Object.create(null);
for (const record of records) {
    trackCounts[record.track] = (trackCounts[record.track] ?? 0) + 1;
    unitCounts[record.quality_unit] = (unitCounts[record.quality_unit] ?? 0) + 1;
    if (record.split === null) unassignedGroups.add(record.split_group_id);
    normalizedRunOutcomeCountsByTrack[record.track] ??= Object.create(null);
    for (const run of record.translation_run_evidence.runs) {
        rawRunStatusCounts[run.status] = (rawRunStatusCounts[run.status] ?? 0) + 1;
        const normalized = normalizeRunOutcome(run);
        normalizedRunOutcomeCounts[normalized] = (normalizedRunOutcomeCounts[normalized] ?? 0) + 1;
        const byTrack = normalizedRunOutcomeCountsByTrack[record.track];
        byTrack[normalized] = (byTrack[normalized] ?? 0) + 1;
    }
}

const report = {
    schema_version: 1,
    status: issues.length ? 'invalid' : (cross.eligibleCount ? 'structurally_valid_with_eligible_records' : 'structurally_valid_pending_gates'),
    manifest_path: manifestPath,
    manifest_sha256: sha256(manifestText),
    validator_sha256: validatorSha256,
    workspace_root: workspaceRoot,
    raw_source_text_in_validation_report: false,
    raw_translations_in_validation_report: false,
    source_artifacts_hashed_as_bytes: true,
    manifest_record_count: records.length,
    track_record_counts: trackCounts,
    quality_unit_counts: unitCounts,
    run_plan_declaration_counts: runPlanDeclarationCounts,
    raw_run_status_counts: rawRunStatusCounts,
    normalized_run_outcome_counts: normalizedRunOutcomeCounts,
    normalized_run_outcome_counts_by_track: normalizedRunOutcomeCountsByTrack,
    eligible_internal_record_count: cross.eligibleCount,
    unassigned_split_group_count: unassignedGroups.size,
    readiness_by_record: cross.readiness,
    duplicate_source_hash_groups: cross.duplicateSourceHashGroups,
    duplicate_source_hash_group_count: cross.duplicateSourceHashGroups.length,
    duplicate_reference_hash_groups: cross.duplicateReferenceHashGroups,
    duplicate_reference_hash_group_count: cross.duplicateReferenceHashGroups.length,
    duplicate_segment_hash_groups: cross.duplicateSegmentHashGroups,
    duplicate_segment_hash_group_count: cross.duplicateSegmentHashGroups.length,
    duplicate_segment_reference_hash_groups: cross.duplicateSegmentReferenceHashGroups,
    duplicate_segment_reference_hash_group_count: cross.duplicateSegmentReferenceHashGroups.length,
    pending_unassigned_source_hash_groups: cross.pendingUnassignedSourceHashGroups,
    pending_unassigned_source_hash_group_count: cross.pendingUnassignedSourceHashGroups.length,
    pending_unassigned_reference_hash_groups: cross.pendingUnassignedReferenceHashGroups,
    pending_unassigned_reference_hash_group_count: cross.pendingUnassignedReferenceHashGroups.length,
    run_design_by_record: cross.runDesignByRecord,
    file_evidence_check_count: fileEvidenceChecks.length,
    file_evidence_checks: fileEvidenceChecks,
    issue_count: issues.length,
    issues,
};
if (args.schemaOutput) {
    const generated = z.toJSONSchema(benchmarkManifestRecordSchema, {target: 'draft-2020-12'});
    generated.$id = 'urn:fluentread:translation-benchmark-manifest:v3';
    generated.title = 'FluentRead real-source translation benchmark manifest record v3';
    await writeFile(path.resolve(args.schemaOutput), JSON.stringify(generated, null, 2) + '\n');
}
if (args.output) await writeFile(path.resolve(args.output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
    status: report.status,
    manifest_record_count: report.manifest_record_count,
    track_record_counts: report.track_record_counts,
    eligible_internal_record_count: report.eligible_internal_record_count,
    unassigned_split_group_count: report.unassigned_split_group_count,
    duplicate_source_hash_group_count: report.duplicate_source_hash_group_count,
    duplicate_reference_hash_group_count: report.duplicate_reference_hash_group_count,
    duplicate_segment_hash_group_count: report.duplicate_segment_hash_group_count,
    duplicate_segment_reference_hash_group_count: report.duplicate_segment_reference_hash_group_count,
    pending_unassigned_source_hash_group_count: report.pending_unassigned_source_hash_group_count,
    pending_unassigned_reference_hash_group_count: report.pending_unassigned_reference_hash_group_count,
    issue_count: report.issue_count,
    validator_sha256: report.validator_sha256,
    output: args.output ? path.resolve(args.output) : null,
}, null, 2));
if (issues.length) process.exitCode = 1;
