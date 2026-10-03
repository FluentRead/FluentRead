/**
 * WASM 私有 stderr 适配器，由构建器插入各引擎 glue 的闭包内。
 * 不覆盖全局 console，不更改模型、执行后端、参数或 Promise 错误传播。
 * 本文件保留为普通 JS，让发布资产中的诊断不被业务构建的 drop:console 删除。
 */
function fluentReadWasmStderr(message) {
    const text = String(message).replace(/\u001b\[[0-9;]*m/g, '');
    // ORT 将所有严重级别写入 stderr，Emscripten 默认全部转为 console.error。
    const onnx = !/[\r\n]/.test(text.trim())
        && /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ )?\[([VIWEF]):onnxruntime[:\]]/.exec(text);
    if (onnx) {
        // 浏览器 WASM 不暴露 CPU 厂商；上游 https://github.com/microsoft/onnxruntime/pull/27399 已确认此单行提示无操作价值。
        // 只降低 vendor=0 的已知初始化提示，其他警告、错误和多行输出保持原级别。
        if (onnx[1] === 'W' && /\[W:onnxruntime:Default, cpuid_info\.cc:\d+ LogEarlyWarning\] Unknown CPU vendor\. cpuinfo_vendor value: 0\s*$/.test(text)) {
            console.debug(text);
            return;
        }
        const level = {V: 'debug', I: 'info', W: 'warn', E: 'error', F: 'error'}[onnx[1]];
        console[level](text);
        return;
    }
    // 官方 CJK traineddata 仍带有 Legacy 引擎参数；LSTM-only core 不包含这些参数。
    // 只降级已核对的完整单行提示；陌生参数或附带其他错误的输出仍然可见。
    if (/^Warning: Parameter not found: (?:language_model_ngram_on|segsearch_max_char_wh_ratio|language_model_ngram_space_delimited_language|language_model_ngram_scale_factor|language_model_use_sigmoidal_certainty|language_model_ngram_nonmatch_score|classify_integer_matcher_multiplier|assume_fixed_pitch_char_segment|chop_enable|allow_blob_division)\s*$/.test(text)
        || /^Estimating resolution as \d+\s*$/.test(text)) {
        console.debug(text);
    } else if (/^Warning:[^\r\n]*\s*$/.test(text)) {
        console.warn(text);
    } else {
        // 未知 stderr 采用保守的错误级别；不能因为首行像提示就吞掉后续失败。
        console.error(text);
    }
}
